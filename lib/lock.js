// lib/lock.js — master password, manual lock and idle auto-lock.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const KEYLEN = 32;

export class LockManager {
  constructor(dataDir, { idleMinutes = 15 } = {}) {
    this.file = path.join(dataDir, "lock.json");
    this.state = { master: null, idleMinutes: Number(idleMinutes) >= 0 ? Number(idleMinutes) : 15, locked: false };
    this.lastActivity = Date.now();
    this._load();
  }

  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.state.master = d.master || null;
      this.state.idleMinutes = Number(d.idleMinutes) >= 0 ? Number(d.idleMinutes) : 15;
      this.state.locked = Boolean(d.locked);
    } catch {
      /* no lock file yet */
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
  }

  get hasMaster() {
    return Boolean(this.state.master);
  }
  get locked() {
    return this.state.locked;
  }
  get idleMinutes() {
    return this.state.idleMinutes;
  }

  /** Set the master password for the first time (4+ chars). */
  setup(password) {
    if (this.hasMaster) throw new Error("master-already-set");
    const text = String(password || "");
    if (text.length < 4) throw new Error("weak-password");
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(text, salt, KEYLEN);
    this.state.master = `${salt.toString("hex")}:${hash.toString("hex")}`;
    this._save();
  }

  verify(password) {
    if (!this.hasMaster) return false;
    const [saltHex, hashHex] = String(this.state.master).split(":");
    if (!saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(String(password || ""), Buffer.from(saltHex, "hex"), expected.length || KEYLEN);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  lock() {
    if (!this.hasMaster) throw new Error("master-required");
    this.state.locked = true;
    this._save();
  }

  unlock(password) {
    if (!this.verify(password)) return false;
    this.state.locked = false;
    this.lastActivity = Date.now();
    this._save();
    return true;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  setIdle(minutes) {
    const n = Number(minutes);
    this.state.idleMinutes = Number.isFinite(n) && n >= 0 ? n : this.idleMinutes;
    this._save();
  }

  /** Auto-lock when idle; returns true when currently locked. */
  checkIdle() {
    if (!this.hasMaster || !this.state.idleMinutes) return this.state.locked;
    if (this.state.locked) return true;
    if (Date.now() - this.lastActivity >= this.state.idleMinutes * 60000) {
      this.state.locked = true;
      this._save();
    }
    return this.state.locked;
  }
}
