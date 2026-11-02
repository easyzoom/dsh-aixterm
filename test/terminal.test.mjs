import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalManager } from "../lib/terminal.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aixterm-term-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("terminal: local shell echoes, keeps a buffer, persists scrollback", async () => {
  const dir = tmp();
  const mgr = new TerminalManager({ dataDir: dir });
  const shell = process.platform === "win32" ? "cmd.exe" : "bash";
  const id = await mgr.open({ local: { shell }, cols: 100, rows: 30 });
  assert.ok(id);
  await wait(1000);
  mgr.input(id, process.platform === "win32" ? "echo AIXTERM_OK\r\n" : "echo AIXTERM_OK\n");
  await wait(1800);

  assert.match(mgr.buffer(id), /AIXTERM_OK/, "buffer holds the command output");
  assert.match(mgr.read(id, 4096), /AIXTERM_OK/, "AI read returns the tail");

  const term = mgr.get(id);
  assert.ok(term.logPath, "scrollback path assigned");
  assert.match(path.basename(term.logPath), /^local-\d{4}-/, "named by label and timestamp");
  const log = fs.readFileSync(term.logPath, "utf8");
  assert.match(log, /AIXTERM_OK/, "scrollback log persisted");

  mgr.close(id);
});

test("terminal: saveScrollback=false writes no file", async () => {
  const dir = tmp();
  const settings = { get: () => ({ saveScrollback: false, bufferLines: 2000, scrollbackDir: "" }) };
  const mgr = new TerminalManager({ dataDir: dir, settings });
  const shell = process.platform === "win32" ? "cmd.exe" : "bash";
  const id = await mgr.open({ local: { shell }, cols: 80, rows: 24 });
  try {
    await wait(500);
    const term = mgr.get(id);
    assert.equal(term.logPath, null, "no log path when saving is disabled");
    assert.equal(
      fs.readdirSync(path.join(dir, "terminals")).filter((f) => f.endsWith(".log")).length,
      0
    );
  } finally {
    mgr.close(id);
    await wait(300);
  }
});

test("terminal: line-based circular buffer keeps only recent lines", async () => {
  const dir = tmp();
  const settings = { get: () => ({ bufferLines: 100, saveScrollback: false, scrollbackDir: "" }) };
  const mgr = new TerminalManager({ dataDir: dir, settings });
  const shell = process.platform === "win32" ? "cmd.exe" : "bash";
  const id = await mgr.open({ local: { shell }, cols: 80, rows: 24 });
  await wait(600);
  mgr.input(id, process.platform === "win32" ? "for /L %i in (1,1,500) do @echo LINE%i\r\n" : "seq 1 500\r");
  await wait(2000);
  const buf = mgr.buffer(id);
  const lines = buf.split("\n").length;
  assert.ok(lines <= 320, `buffer kept ${lines} lines (limit 100 + headroom)`);
  assert.match(buf, /500/, "newest output retained");
  assert.doesNotMatch(buf, /^1$/m, "oldest lines trimmed");
  mgr.close(id);
  await wait(500);
});
