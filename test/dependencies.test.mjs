import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

test("node-pty ships executable Darwin spawn helpers", { skip: process.platform === "win32" }, () => {
  const packageDir = path.resolve(path.dirname(require.resolve("node-pty")), "..");
  for (const arch of ["arm64", "x64"]) {
    const helper = path.join(packageDir, "prebuilds", `darwin-${arch}`, "spawn-helper");
    const mode = fs.statSync(helper).mode & 0o777;
    assert.notEqual(mode & 0o111, 0, `${arch} spawn-helper mode ${mode.toString(8)} is not executable`);
  }
});
