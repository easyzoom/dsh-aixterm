import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeName } from "../lib/transfer.js";

test("transfer: dedupeName appends a counter before the extension", () => {
  const taken = new Set(["a.txt"]);
  assert.equal(dedupeName("a.txt", (n) => taken.has(n)), "a (1).txt");
  taken.add("a (1).txt");
  assert.equal(dedupeName("a.txt", (n) => taken.has(n)), "a (2).txt");
  assert.equal(dedupeName("plain", () => false), "plain");
  assert.equal(dedupeName("archive.tar.gz", (n) => n === "archive.tar.gz"), "archive.tar (1).gz");
});
