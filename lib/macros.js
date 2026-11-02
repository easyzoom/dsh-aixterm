// lib/macros.js — recorded command macros (name + ordered steps).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAX_STEPS = 200;
const MAX_STEP_LEN = 4096;

function normalize(input) {
  const name = String((input && input.name) || "").trim();
  if (!name) throw new Error("name-required");
  const steps = Array.isArray(input && input.steps) ? input.steps : [];
  if (!steps.length) throw new Error("steps-required");
  if (steps.length > MAX_STEPS) throw new Error("too-many-steps");
  const clean = steps.map((s) => {
    const text = String(s === null || s === undefined ? "" : s);
    if (text.length > MAX_STEP_LEN) throw new Error("step-too-long");
    return text;
  });
  return {
    name: name.slice(0, 120),
    description: String((input && input.description) || "").slice(0, 500),
    steps: clean,
  };
}

export class MacroStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "macros.json");
    this.macros = this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(parsed.macros) ? parsed.macros : [];
    } catch {
      return [];
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ macros: this.macros }, null, 2), { mode: 0o600 });
  }

  list() {
    return this.macros.map((m) => ({ ...m }));
  }

  /** Create (no id) or update (existing id); returns the stored macro. */
  save(input) {
    const data = normalize(input);
    const id = input && input.id ? String(input.id) : "";
    const now = new Date().toISOString();
    if (id) {
      const found = this.macros.find((m) => m.id === id);
      if (!found) throw new Error("macro-not-found");
      Object.assign(found, data, { updatedAt: now });
      this._save();
      return { ...found };
    }
    const macro = { id: crypto.randomUUID(), ...data, createdAt: now, updatedAt: now };
    this.macros.push(macro);
    this._save();
    return { ...macro };
  }

  remove(id) {
    const before = this.macros.length;
    this.macros = this.macros.filter((m) => m.id !== id);
    if (this.macros.length !== before) {
      this._save();
      return true;
    }
    return false;
  }
}
