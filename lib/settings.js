// lib/settings.js — runtime-editable terminal settings (persisted in dataDir).
import fs from "node:fs";
import path from "node:path";

const DEFAULTS = { saveScrollback: true, scrollbackDir: "", bufferLines: 2000, termType: "xterm-256color", colorfulBanner: true };
const TERM_TYPES = ["xterm-256color", "xterm", "vt100", "vt220", "linux", "screen", "screen-256color", "ansi", "dumb"];
const MIN_LINES = 100;
const MAX_LINES = 100000;

export class SettingsStore {
  constructor(dataDir, defaults = {}) {
    this.file = path.join(dataDir, "settings.json");
    this.defaults = { ...DEFAULTS, ...pickValid(defaults) };
    this.state = { ...this.defaults, ...this._load() };
  }

  _load() {
    try {
      return pickValid(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      return {};
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
  }

  get() {
    return { ...this.state };
  }

  /** Validate and persist a partial update; throws on invalid values. */
  update(patch) {
    const next = { ...this.state };
    if (patch) {
      if (patch.saveScrollback !== undefined) next.saveScrollback = Boolean(patch.saveScrollback);
      if (patch.scrollbackDir !== undefined) {
        const dir = String(patch.scrollbackDir || "").trim();
        if (dir && !path.isAbsolute(dir)) throw new Error("scrollback-dir-must-be-absolute");
        if (dir && (dir === "/" || dir === path.parse(dir).root)) throw new Error("scrollback-dir-too-broad");
        next.scrollbackDir = dir;
      }
      if (patch.bufferLines !== undefined) {
        const lines = Number(patch.bufferLines);
        if (!Number.isFinite(lines) || lines < MIN_LINES || lines > MAX_LINES) {
          throw new Error(`buffer-lines-out-of-range (${MIN_LINES}-${MAX_LINES})`);
        }
        next.bufferLines = Math.floor(lines);
      }
      if (patch.termType !== undefined) {
        if (!TERM_TYPES.includes(patch.termType)) throw new Error("unsupported-term-type");
        next.termType = patch.termType;
      }
      if (patch.colorfulBanner !== undefined) {
        if (typeof patch.colorfulBanner !== "boolean") throw new Error("colorful-banner-must-be-boolean");
        next.colorfulBanner = patch.colorfulBanner;
      }
    }
    this.state = next;
    this._save();
    return this.get();
  }
}

function pickValid(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  if (input.saveScrollback !== undefined) out.saveScrollback = Boolean(input.saveScrollback);
  if (typeof input.scrollbackDir === "string") out.scrollbackDir = input.scrollbackDir.trim();
  if (input.bufferLines !== undefined) {
    const n = Number(input.bufferLines);
    if (Number.isFinite(n) && n >= MIN_LINES && n <= MAX_LINES) out.bufferLines = Math.floor(n);
  }
  if (input.termType !== undefined && TERM_TYPES.includes(input.termType)) out.termType = input.termType;
  if (typeof input.colorfulBanner === "boolean") out.colorfulBanner = input.colorfulBanner;
  return out;
}
