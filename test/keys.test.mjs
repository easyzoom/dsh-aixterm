import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";
import { generateKey, importKey, listKeys, deleteKey, keyPathOf } from "../lib/keys.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aixterm-keys-"));

test("keys: generate, list, fingerprint, delete", () => {
  const dir = tmpDir();
  const made = generateKey(dir, "laptop");
  assert.equal(made.type, "ssh-ed25519");
  assert.match(made.publicKey, /^ssh-ed25519 /);
  const file = keyPathOf(dir, "laptop");
  // Windows reports writable/read-only attributes, not POSIX permission bits.
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "private key is 600");
  }
  const list = listKeys(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "laptop");
  assert.equal(list[0].type, "ssh-ed25519");
  assert.match(list[0].fingerprint, /^SHA256:/);
  assert.equal(deleteKey(dir, "laptop"), true);
  assert.equal(listKeys(dir).length, 0);
  assert.equal(deleteKey(dir, "laptop"), false);
});

test("keys: import validates and rejects invalid material", () => {
  const dir = tmpDir();
  const made = generateKey(dir, "src");
  const material = fs.readFileSync(keyPathOf(dir, "src"), "utf8");
  const imported = importKey(dir, "copy", material);
  assert.equal(imported.name, "copy");
  assert.equal(listKeys(dir).length, 2);
  assert.throws(() => importKey(dir, "bad", "not a key"), /invalid-private-key/);
  assert.throws(() => generateKey(dir, "../escape"), /invalid-key-name/);
  assert.throws(() => deleteKey(dir, "a/b"), /invalid-key-name/);
});

test("keys: generation retries malformed upstream ed25519 output", { concurrency: false }, () => {
  const originalGenerate = ssh2.utils.generateKeyPairSync;
  let valid;
  do {
    valid = originalGenerate("ed25519");
  } while (ssh2.utils.parseKey(valid.private) instanceof Error || ssh2.utils.parseKey(valid.public) instanceof Error);

  let attempts = 0;
  ssh2.utils.generateKeyPairSync = () => {
    attempts += 1;
    return attempts === 1 ? { private: "malformed", public: "malformed" } : valid;
  };

  const dir = tmpDir();
  try {
    const made = generateKey(dir, "retried");
    assert.equal(attempts, 2, "invalid generated material is discarded and regenerated");
    assert.match(made.publicKey, /^ssh-ed25519 /);
    assert.equal(ssh2.utils.parseKey(fs.readFileSync(keyPathOf(dir, "retried"))) instanceof Error, false);
  } finally {
    ssh2.utils.generateKeyPairSync = originalGenerate;
  }
});
