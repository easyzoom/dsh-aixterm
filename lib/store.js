// lib/store.js — saved SSH sessions, with secrets encrypted at rest.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { encrypt, decrypt } from "./crypto.js";

/** Resolve the data directory (DSH home + aixterm, or the configured override). */
export function dataDirOf(cfg) {
  const base = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return (cfg && cfg.dataDir) || path.join(base, "aixterm");
}

function normalize(input) {
  const kind = input.kind === "serial" ? "serial" : input.kind === "telnet" ? "telnet" : "ssh";
  const base = {
    kind,
    name: String(input.name || input.host || (input.serial && input.serial.path) || "session"),
    group: input.group || "",
    // Keep-alive / auto-reconnect preference (terminals + future logic).
    reconnect: input.reconnect !== false,
  };
  if (kind === "telnet") {
    return {
      ...base,
      host: String(input.host || ""),
      port: Number(input.port) > 0 ? Number(input.port) : 23,
    };
  }
  if (kind === "serial") {
    const ser = input.serial || {};
    const parity = ["none", "even", "odd", "mark", "space"].includes(ser.parity) ? ser.parity : "none";
    return {
      ...base,
      serial: {
        path: String(ser.path || ""),
        baudRate: Number(ser.baudRate) || 115200,
        dataBits: [5, 6, 7, 8].includes(Number(ser.dataBits)) ? Number(ser.dataBits) : 8,
        stopBits: [1, 1.5, 2].includes(Number(ser.stopBits)) ? Number(ser.stopBits) : 1,
        parity,
      },
    };
  }
  const auth = input.auth || {};
  const authKind = auth.kind === "key" || auth.kind === "agent" ? auth.kind : "password";
  const port = Number(input.port) > 0 ? Number(input.port) : 22;
  return {
    ...base,
    host: String(input.host || ""),
    port,
    user: String(input.user || ""),
    auth:
      authKind === "key"
        ? { kind: authKind, keyPath: String(auth.keyPath || ""), keyId: String(auth.keyId || "") }
        : { kind: authKind, credentialEnv: String(auth.credentialEnv || "") },
    // Jump host: id of another saved session to chain through ("" = direct).
    proxyJump: input.proxyJump ? String(input.proxyJump) : "",
    // X11 forwarding for interactive shells.
    x11: Boolean(input.x11),
  };
}

export class SessionStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "sessions.json");
    this.sessions = this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(parsed.sessions) ? parsed.sessions : [];
    } catch {
      return [];
    }
  }

  _save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ sessions: this.sessions }, null, 2), "utf8");
  }

  /** Public projection: never leaks the encrypted secret. */
  _public(s) {
    const { secretRef, ...rest } = s;
    return { ...rest, hasSecret: secretRef !== undefined && secretRef !== null };
  }

  list() {
    return this.sessions.map((s) => this._public(s));
  }

  get(id) {
    return this.sessions.find((s) => s.id === id);
  }

  create(input) {
    const session = { id: crypto.randomUUID(), ...normalize(input) };
    if (input.password !== undefined && input.password !== null && input.password !== "") {
      session.secretRef = encrypt(this.dataDir, input.password);
    }
    this.sessions.push(session);
    this._save();
    return this._public(session);
  }

  update(id, input) {
    const session = this.get(id);
    if (!session) return undefined;
    const merged = { ...session, ...input };
    if (input.serial) merged.serial = { ...(session.serial || {}), ...input.serial };
    const next = normalize(merged);
    Object.assign(session, next);
    if (input.password !== undefined) {
      if (input.password === null || input.password === "") delete session.secretRef;
      else session.secretRef = encrypt(this.dataDir, input.password);
    }
    this._save();
    return this._public(session);
  }

  /** Copy a session (including its encrypted secret reference) under a new id. */
  duplicate(id) {
    const s = this.get(id);
    if (!s) return undefined;
    const copy = { ...s, id: crypto.randomUUID(), name: s.name + " (副本)" };
    this.sessions.push(copy);
    this._save();
    return this._public(copy);
  }

  remove(id) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length !== before) {
      this._save();
      return true;
    }
    return false;
  }

  /** The decrypted secret (password or key passphrase) for a session, if any. */
  credential(id) {
    const session = this.get(id);
    if (!session || session.secretRef === undefined) return undefined;
    return decrypt(this.dataDir, session.secretRef);
  }
}
