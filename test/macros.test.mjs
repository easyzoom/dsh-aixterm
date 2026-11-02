import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MacroStore } from "../lib/macros.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aixterm-mac-"));

test("macros: create, update, persist, remove", () => {
  const dir = tmpDir();
  const store = new MacroStore(dir);
  const made = store.save({ name: "deploy", description: "ship it", steps: ["cd /opt/app", "make && make install"] });
  assert.ok(made.id);
  assert.equal(store.list().length, 1);
  const updated = store.save({ id: made.id, name: "deploy2", steps: ["echo hi"] });
  assert.equal(updated.name, "deploy2");
  assert.deepEqual(updated.steps, ["echo hi"]);
  const reloaded = new MacroStore(dir);
  assert.equal(reloaded.list()[0].name, "deploy2");
  assert.equal(reloaded.remove(made.id), true);
  assert.equal(reloaded.list().length, 0);
});

test("macros: validation", () => {
  const store = new MacroStore(tmpDir());
  assert.throws(() => store.save({ name: "", steps: ["x"] }), /name-required/);
  assert.throws(() => store.save({ name: "a", steps: [] }), /steps-required/);
  assert.throws(() => store.save({ name: "a", steps: Array(201).fill("x") }), /too-many-steps/);
  assert.throws(() => store.save({ name: "a", steps: ["x".repeat(5000)] }), /step-too-long/);
  assert.throws(() => store.save({ id: "missing", name: "a", steps: ["x"] }), /not-found/);
});
