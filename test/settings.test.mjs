import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "../lib/settings.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aixterm-set-"));

test("settings: defaults, update, persistence", () => {
  const dir = tmpDir();
  const store = new SettingsStore(dir, { saveScrollback: true, bufferLines: 2000 });
  assert.equal(store.get().bufferLines, 2000);
  assert.equal(store.get().colorfulBanner, true);
  const next = store.update({ saveScrollback: false, bufferLines: 500, scrollbackDir: "/tmp/aix-logs", colorfulBanner: false });
  assert.equal(next.saveScrollback, false);
  assert.equal(next.colorfulBanner, false);
  assert.equal(next.bufferLines, 500);
  assert.equal(next.scrollbackDir, "/tmp/aix-logs");
  const reloaded = new SettingsStore(dir);
  assert.deepEqual(reloaded.get(), next);
});

test("settings: rejects invalid values", () => {
  const store = new SettingsStore(tmpDir());
  assert.throws(() => store.update({ bufferLines: 10 }), /out-of-range/);
  assert.throws(() => store.update({ bufferLines: 999999 }), /out-of-range/);
  assert.throws(() => store.update({ scrollbackDir: "relative/path" }), /absolute/);
  assert.throws(() => store.update({ scrollbackDir: "/" }), /too-broad/);
  assert.throws(() => store.update({ colorfulBanner: "false" }), /boolean/);
  assert.equal(store.get().bufferLines, 2000, "failed updates leave state untouched");
});
