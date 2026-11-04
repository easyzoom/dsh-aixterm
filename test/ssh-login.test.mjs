import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { TerminalManager } from "../lib/terminal.js";
import { connectionHeader, formatPreAuthBanner } from "../lib/ssh-display.js";
import stringWidth from "string-width";
import { openShell } from "../lib/ssh.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (text) => text.replace(/\x1b\[[\d;]*m/g, "");
const welcome = "\r\nBusyBox v1.33.2 built-in shell (ash)\r\n注意: rootfs/app/resdata目前为只读分区\r\nroot@TinaLinux:~# ";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
async function fixture(t, compression = ["none"]) {
  const clients = new Set(), input = [], execs = [];
  const server = new ssh2.Server({ banner: "Enter default password\r\n", algorithms: { compress: compression }, hostKeys: [privateKey.export({ type: "pkcs1", format: "pem" })] }, (client) => {
    clients.add(client); client.on("error", () => {}); client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty());
      const serve = (stream) => {
        stream.on("error", () => {});
        stream.on("data", (data) => { input.push(data.toString()); stream.write(data); });
        stream.write(welcome);
      };
      session.on("shell", (acceptShell) => serve(acceptShell()));
      session.on("exec", (acceptExec, _reject, info) => { execs.push(info.command); serve(acceptExec()); });
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aixterm-login-"));
  const manager = new TerminalManager({ dataDir: dir, settings: { get: () => ({ saveScrollback: false }) } });
  t.after(async () => {
    const closed = Promise.all([...clients].map((client) => new Promise((resolve) => client.once("close", resolve))));
    for (const id of manager.terms.keys()) manager.close(id);
    await closed;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { manager, input, execs, session: { id: "login-test", name: "Board", kind: "ssh", host: "127.0.0.1", port: server.address().port, user: "root", reconnect: false, auth: { kind: "password" } } };
}

test("SSH login preserves server welcome and emits no shell initialization commands", async (t) => {
  const { manager, input, session } = await fixture(t);
  const id = await manager.open({ session, cols: 100, rows: 24 });
  await wait(1100); // The old delayed PS1 injection ran after 900 ms.
  assert.equal(input.join(""), "", "opening a plain SSH terminal must not send commands or change the user's shell");
  const output = manager.buffer(id);
  assert.match(output, /Pre-authentication banner message from server:\r\n\| Enter default password\r\nEnd of banner message from server/);
  assert.ok(output.indexOf("End of banner message") < output.indexOf("dsh-aixterm"));
  assert.ok(output.indexOf("dsh-aixterm") < output.indexOf("BusyBox"));
  assert.ok(output.endsWith("root@TinaLinux:~# "));
  assert.doesNotMatch(output, /BASH_VERSION|PROMPT_COMMAND|exec bash|\x1b\[2J/);
  manager.input(id, "echo USER_COMMAND\r");
  await wait(40);
  assert.equal(input.join(""), "echo USER_COMMAND\r");
});

test("SSH login header rows align and fit a narrow terminal", async (t) => {
  const { manager, session } = await fixture(t);
  const id = await manager.open({ session: { ...session, user: "a".repeat(90) }, cols: 40, rows: 24 });
  const rows = plain(manager.buffer(id)).split("\r\n").filter((line) => /^[┌│└]/.test(line));
  assert.ok(rows.length > 5);
  assert.equal(new Set(rows.map((line) => [...line].length)).size, 1);
  assert.ok(rows.every((line) => [...line].length <= 40));
  assert.match(rows.join("\n"), /SSH compression\s*:\s*✗/);
});

test("SSH login negotiates and accurately displays supported compression", async (t) => {
  const { manager, session } = await fixture(t, ["zlib@openssh.com", "none"]);
  const id = await manager.open({ session, cols: 100, rows: 24 });
  assert.match(plain(manager.buffer(id)), /SSH compression\s*:\s*✓/);
});

test("explicit tmux attachment uses an SSH exec request without typing commands into the login shell", async (t) => {
  const { manager, input, execs, session } = await fixture(t);
  const id = await manager.open({ session, tmuxName: "work", cols: 100, rows: 24 });
  await wait(50);
  assert.deepEqual(execs, ["exec tmux new-session -A -s 'work'"]);
  assert.equal(input.join(""), "");
  assert.match(plain(manager.buffer(id)), /tmux\s*:\s*work/);
});

test("connection banner is colorful by default, resets styles, and supports plain output", () => {
  const session = { user: "root", host: "example.test" }, options = { cols: 80, compression: { outgoing: "none", incoming: "none" } };
  const colored = connectionHeader(session, options), disabled = connectionHeader(session, { ...options, color: false });
  assert.match(colored, /\x1b\[/);
  assert.ok(colored.endsWith("\x1b[0m\r\n"));
  assert.doesNotMatch(disabled, /\x1b/);
  assert.equal(plain(colored), disabled);
  assert.ok(plain(colored).trimEnd().split("\r\n").every((row) => stringWidth(row) === 72));
});

test("SSH display handles wide characters, long fields, multiline banners and unsafe tmux names", async () => {
  const header = connectionHeader({ user: "用户".repeat(30), host: "example.test", port: 22 }, { cols: 40, compression: { outgoing: "none", incoming: "none" } });
  assert.ok(header.trimEnd().split("\r\n").every((row) => stringWidth(row) === 40));
  assert.ok(header.includes("…"));
  assert.equal(formatPreAuthBanner(""), "");
  assert.equal(formatPreAuthBanner("line1\nline2\r\n"), "Pre-authentication banner message from server:\r\n| line1\r\n| line2\r\nEnd of banner message from server\r\n\r\n");
  await assert.rejects(openShell({}, "", { tmuxName: "x'; reboot" }), /invalid-tmux-name/);
});
