import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinProfiles, validateProfile, renderProfile } from "../lib/diagnostic-profiles.js";
import { DiagnosticProfileStore } from "../lib/diagnostic-profile-store.js";

const sample = () => ({ schemaVersion: 1, id: "my-check", name: "Custom check", target: { os: ["linux"], transport: ["ssh"] }, inputs: [{ id: "service", name: "Service", required: true }], checks: [{ id: "status", name: "Status", command: "printf '%s' {{service}}", timeoutMs: 1000, maxOutputBytes: 1024 }], analysis: { instructions: "Explain the evidence." } });

test("protocol normalizes defaults and quotes hostile input as one shell argument", () => {
  const profile = validateProfile(sample());
  const plan = renderProfile(profile, { service: "a'; reboot; echo '" });
  assert.equal(plan.checks[0].command, "printf '%s' 'a'\\''; reboot; echo '\\'''" );
  assert.equal(plan.checks[0].type, "command");
  assert.throws(() => renderProfile(profile, {}), /service/);
  assert.throws(() => renderProfile(profile, { service: "x", other: "y" }), /other/);
});

test("protocol rejects unsupported versions, fields, duplicates, unsafe templates and excessive budgets", () => {
  for (const mutate of [
    (p) => { p.schemaVersion = 2; },
    (p) => { p.readOnly = true; },
    (p) => { p.id = "../outside"; },
    (p) => { p.checks.push({ ...p.checks[0] }); },
    (p) => { p.checks[0].command = "echo {{missing}}"; },
    (p) => { p.checks[0].command = "echo '{{service}}'"; },
    (p) => { p.checks[0].command = "cat <<EOF\n{{service}}\nEOF"; },
    (p) => { p.checks[0].command = "echo ok # {{service}}"; },
    (p) => { p.checks[0].timeoutMs = 15001; },
    (p) => { p.checks[0].maxOutputBytes = 999999; },
    (p) => { p.checks = Array.from({ length: 5 }, (_, i) => ({ id: "step" + i, name: "Step", command: "true", timeoutMs: 15000 })); },
    (p) => { p.inputs[0].id = "__proto__"; },
  ]) {
    const p = sample(); mutate(p);
    assert.throws(() => validateProfile(p));
  }
});

test("profile store protects built-ins, persists user data and imports atomically without overwrites", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aixterm-profiles-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new DiagnosticProfileStore(dir);
  assert.equal(store.list().length, 3);
  assert.throws(() => store.save({ ...sample(), id: "boot" }), /built-in/);
  store.save(sample());
  assert.equal(new DiagnosticProfileStore(dir).get("my-check").name, "Custom check");
  const before = fs.readFileSync(store.file, "utf8");
  assert.throws(() => store.import({ schemaVersion: 1, profiles: [sample(), { ...sample(), id: "invalid", schemaVersion: 99 }] }));
  assert.equal(fs.readFileSync(store.file, "utf8"), before);
  assert.throws(() => store.import({ schemaVersion: 1, profiles: [sample(), sample()] }), /duplicate/);
  const imported = store.import(store.export("my-check"));
  assert.equal(imported.profiles[0].id, "my-check-2");
  assert.equal(store.get("my-check").name, "Custom check");
  const builtinImport = store.import(store.export("boot"));
  assert.notEqual(builtinImport.profiles[0].id, "boot");
  assert.equal(store.get("boot").builtin, true);
  assert.throws(() => store.remove("boot"), /built-in/);
  assert.equal(store.remove("my-check-2"), true);
  assert.deepEqual(store.export().profiles.map((p) => p.id), store.list().filter((p) => !p.builtin).map((p) => p.id));
});

test("built-in profiles validate and exported definitions do not carry runtime metadata", () => {
  for (const p of builtinProfiles()) {
    const { builtin, ...definition } = p;
    assert.equal(builtin, true);
    assert.equal(validateProfile(definition).id, p.id);
  }
});

test("documented examples and empty user libraries round-trip through the protocol", (t) => {
  const examples = JSON.parse(fs.readFileSync(new URL("../docs/examples/diagnostic-profiles.json", import.meta.url), "utf8"));
  const schema = JSON.parse(fs.readFileSync(new URL("../docs/diagnostic-profile.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$defs.profile.properties.schemaVersion.const, 1);
  for (const profile of examples.profiles) validateProfile(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aixterm-empty-profiles-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new DiagnosticProfileStore(dir);
  assert.deepEqual(store.import(store.export()).profiles, []);
  assert.equal(store.import(examples).profiles.length, 2);
});
