import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { builtinProfiles, profileDefinition, validateProfile, PROFILE_FILE_LIMIT } from "./diagnostic-profiles.js";

export class DiagnosticProfileStore {
  constructor(dataDir) { this.file = path.join(dataDir, "diagnostic-profiles.json"); }
  _read() {
    let data;
    try { data = fs.readFileSync(this.file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    if (Buffer.byteLength(data) > PROFILE_FILE_LIMIT) throw new Error("profile-library-too-large");
    const parsed = JSON.parse(data);
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.profiles)) throw new Error("invalid-profile-library");
    const profiles = parsed.profiles.map(validateProfile);
    this._validateLibrary(profiles);
    return profiles;
  }
  _validateLibrary(profiles) {
    if (profiles.length > 100) throw new Error("too-many-profiles");
    const ids = new Set(builtinProfiles().map((p) => p.id));
    for (const p of profiles) {
      if (ids.has(p.id)) throw new Error(`duplicate-or-built-in-id: ${p.id}`);
      ids.add(p.id);
    }
  }
  _write(profiles) {
    this._validateLibrary(profiles);
    const data = JSON.stringify({ schemaVersion: 1, profiles }, null, 2) + "\n";
    if (Buffer.byteLength(data) > PROFILE_FILE_LIMIT) throw new Error("profile-library-too-large");
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + crypto.randomUUID() + ".tmp";
    try { fs.writeFileSync(temporary, data, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, this.file); }
    finally { try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== "ENOENT") throw e; } }
  }
  list() { return [...builtinProfiles(), ...this._read().map((p) => ({ ...p, builtin: false }))]; }
  get(id) { return builtinProfiles().find((p) => p.id === id) || this._read().find((p) => p.id === id); }
  save(input) {
    const profile = validateProfile(input);
    if (builtinProfiles().some((p) => p.id === profile.id)) throw new Error("built-in-profile-is-readonly");
    const profiles = this._read(), index = profiles.findIndex((p) => p.id === profile.id);
    if (index < 0) profiles.push(profile); else profiles[index] = profile;
    this._write(profiles);
    return profile;
  }
  remove(id) {
    if (builtinProfiles().some((p) => p.id === id)) throw new Error("built-in-profile-is-readonly");
    const profiles = this._read(), remaining = profiles.filter((p) => p.id !== id);
    if (remaining.length === profiles.length) return false;
    this._write(remaining);
    return true;
  }
  export(id) {
    const profiles = id ? [this.get(id)] : this._read();
    if (profiles.some((p) => !p)) throw new Error("profile-not-found");
    return { schemaVersion: 1, profiles: profiles.map(profileDefinition) };
  }
  import(input) {
    const encoded = typeof input === "string" ? input : JSON.stringify(input);
    if (!encoded || Buffer.byteLength(encoded) > PROFILE_FILE_LIMIT) throw new Error("profile-file-too-large");
    const data = JSON.parse(encoded);
    let incoming;
    if (data && Object.hasOwn(data, "profiles")) {
      if (data.schemaVersion !== 1 || Object.keys(data).some((k) => !["schemaVersion", "profiles"].includes(k)) || !Array.isArray(data.profiles)) throw new Error("invalid-profile-bundle");
      incoming = data.profiles.map(validateProfile);
    } else incoming = [validateProfile(data)];
    if (new Set(incoming.map((p) => p.id)).size !== incoming.length) throw new Error("duplicate-profile-id-in-import");
    const profiles = this._read(), ids = new Set([...profiles, ...builtinProfiles()].map((p) => p.id));
    const added = incoming.map((p) => {
      let id = p.id, suffix = 2;
      if (builtinProfiles().some((b) => b.id === id)) id = "user-" + id;
      const base = id.slice(0, 58);
      while (ids.has(id)) id = `${base}-${suffix++}`;
      ids.add(id);
      return { ...p, id };
    });
    this._write([...profiles, ...added]);
    return { profiles: added };
  }
}
