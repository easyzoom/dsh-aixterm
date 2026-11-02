import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../lib/store.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aixterm-"));

test("store: create / list / get / remove, secret encrypted and decrypted", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const s = store.create({
    name: "box",
    host: "10.0.0.1",
    port: 2222,
    user: "root",
    auth: { kind: "password" },
    password: "s3cret",
  });
  assert.ok(s.id);
  assert.equal(s.hasSecret, true);
  assert.equal(s.password, undefined, "secret never leaks in the public view");
  assert.equal(store.list().length, 1);
  assert.equal(store.credential(s.id), "s3cret");

  // Persisted across reloads, and the on-disk file does not contain the plaintext.
  const reloaded = new SessionStore(dir);
  const raw = fs.readFileSync(path.join(dir, "sessions.json"), "utf8");
  assert.equal(raw.includes("s3cret"), false, "password is not stored in plaintext");
  assert.equal(reloaded.list()[0].host, "10.0.0.1");
  assert.equal(reloaded.credential(s.id), "s3cret");

  assert.equal(reloaded.remove(s.id), true);
  assert.equal(reloaded.list().length, 0);
});

test("store: key auth stores no secret", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const s = store.create({ host: "h", user: "u", auth: { kind: "key", keyPath: "/k/id_ed25519" } });
  assert.equal(s.hasSecret, false);
  assert.equal(store.credential(s.id), undefined);
  assert.equal(s.auth.keyPath, "/k/id_ed25519");
});

test("store: proxyJump and reconnect round-trip, with defaults", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const a = store.create({ name: "a", host: "10.0.0.1", user: "root", auth: { kind: "password" }, password: "x" });
  const b = store.create({
    name: "b",
    host: "10.0.0.2",
    user: "root",
    auth: { kind: "password" },
    password: "y",
    proxyJump: a.id,
    reconnect: false,
  });
  assert.equal(a.proxyJump, "", "direct connection by default");
  assert.equal(a.reconnect, true, "reconnect on by default");
  assert.equal(b.proxyJump, a.id);
  assert.equal(b.reconnect, false);

  const reloaded = new SessionStore(dir);
  assert.equal(reloaded.get(b.id).proxyJump, a.id, "jump host persists");
  assert.equal(reloaded.get(b.id).reconnect, false, "reconnect preference persists");

  const cleared = store.update(b.id, { proxyJump: "" });
  assert.equal(cleared.proxyJump, "", "jump host can be cleared");
});
