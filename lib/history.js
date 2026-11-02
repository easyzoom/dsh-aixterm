// lib/history.js — per-session command history (persisted, deduplicated).
import fs from "node:fs";
import path from "node:path";

const DEFAULT_LIMIT = 500;

export class HistoryStore {
  constructor(dataDir, { limit = DEFAULT_LIMIT } = {}) {
    this.file = path.join(dataDir, "history.json");
    this.limit = limit;
    this.map = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const out = new Map();
      if (raw && typeof raw === "object") {
        for (const [key, list] of Object.entries(raw)) {
          if (Array.isArray(list)) out.set(key, list.filter((x) => typeof x === "string").slice(-this.limit));
        }
      }
      return out;
    } catch {
      return new Map();
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const obj = {};
      for (const [key, list] of this.map) obj[key] = list;
      fs.writeFileSync(this.file, JSON.stringify(obj, null, 2), { mode: 0o600 });
    } catch {
      /* best-effort persistence */
    }
  }

  /** Append a command; skips blanks and immediate repeats. */
  add(sessionId, command) {
    const key = String(sessionId || "");
    const text = String(command || "").trim();
    if (!key || !text) return;
    const list = this.map.get(key) || [];
    if (list[list.length - 1] === text) return;
    list.push(text);
    if (list.length > this.limit) list.splice(0, list.length - this.limit);
    this.map.set(key, list);
    this._save();
  }

  list(sessionId) {
    return [...(this.map.get(String(sessionId || "")) || [])];
  }

  clear(sessionId) {
    this.map.delete(String(sessionId || ""));
    this._save();
  }
}
