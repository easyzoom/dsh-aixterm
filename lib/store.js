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
  const auth = input.auth || {};
  const kind = auth.kind === "key" || auth.kind === "agent" ? auth.kind : "password";
  const port = Number(input.port) > 0 ? Number(input.port) : 22;
  return {
    name: String(input.name || input.host || "session"),
    group: input.group || "",
    host: String(input.host || ""),
    port,
    user: String(input.user || ""),
    auth: kind === "key" ? { kind, keyPath: String(auth.keyPath || "") } : { kind },
    // Jump host: id of another saved session to chain through ("" = direct).
    proxyJump: input.proxyJump ? String(input.proxyJump) : "",
    // Keep-alive / auto-reconnect preference (UI + future reconnect logic).
    reconnect: input.reconnect !== false,
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
    const next = normalize({ ...session, ...input });
    Object.assign(session, next);
    if (input.password !== undefined) {
      if (input.password === null || input.password === "") delete session.secretRef;
      else session.secretRef = encrypt(this.dataDir, input.password);
    }
    this._save();
    return this._public(session);
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
