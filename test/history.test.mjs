import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryStore } from "../lib/history.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aixterm-hist-"));

test("history: add, dedupe consecutive, persist, clear", () => {
  const dir = tmpDir();
  const store = new HistoryStore(dir, { limit: 10 });
  store.add("s1", "ls -la");
  store.add("s1", "git status");
  store.add("s1", "git status");
  store.add("s2", "uptime");
  assert.deepEqual(store.list("s1"), ["ls -la", "git status"]);
  assert.deepEqual(store.list("s2"), ["uptime"]);
  const reloaded = new HistoryStore(dir);
  assert.deepEqual(reloaded.list("s1"), ["ls -la", "git status"]);
  reloaded.clear("s1");
  assert.deepEqual(reloaded.list("s1"), []);
  assert.deepEqual(reloaded.list("s2"), ["uptime"]);
});

test("history: caps at the limit and ignores blanks", () => {
  const dir = tmpDir();
  const store = new HistoryStore(dir, { limit: 3 });
  store.add("s", "");
  store.add("s", "one");
  store.add("s", "two");
  store.add("s", "three");
  store.add("s", "four");
  assert.deepEqual(store.list("s"), ["two", "three", "four"]);
});
