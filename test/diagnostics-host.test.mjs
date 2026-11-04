import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { apply } from "../lib/index.js";
import { dropSharedConnection } from "../lib/ssh.js";

test("diagnostic HTTP and agent interfaces share real SSH evidence and enforce validation/locking", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aixterm-diag-host-"));
  const routes = new Map(), tools = new Map(), clients = new Set(), disposers = [], commands = [], ids = [];
  const commandUsers = [];
  let deferAuthentication = false, pendingAuthentication, onPendingAuthentication;
  let allowCustom = false, approvalRequests = 0;
  const terminalSockets = new Set();
  const telnet = net.createServer((socket) => {
    terminalSockets.add(socket);
    socket.on("close", () => terminalSockets.delete(socket));
    socket.write("x".repeat(15000) + "END_OF_DIAGNOSTIC_LOG");
  });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ssh = new ssh2.Server({ hostKeys: [privateKey.export({ type: "pkcs1", format: "pem" })] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      client.testUser = ctx.username;
      if (deferAuthentication) { pendingAuthentication = ctx; onPendingAuthentication(); }
      else ctx.accept();
    });
    client.on("ready", () => client.on("session", (accept) => {
      accept().on("exec", (acceptExec, _reject, info) => {
        commands.push(info.command);
        commandUsers.push(client.testUser);
        const stream = acceptExec();
        stream.on("error", () => {});
        stream.write(info.command === "uname -s" ? "Linux\n" : info.command === "df -kP" ? "/dev/root 100 95 5 95% /\n" : "collected evidence\n");
        stream.exit(0);
        stream.end();
      });
    }));
  });
  const web = http.createServer((req, res) => {
    const route = routes.get(new URL(req.url, "http://localhost").pathname);
    if (!route) { res.writeHead(404); res.end(); return; }
    Promise.resolve(route.handler(req, res)).catch((error) => { res.writeHead(500); res.end(error.message); });
  });
  t.after(async () => {
    for (const dispose of disposers.reverse()) dispose?.();
    for (const id of ids) dropSharedConnection(id);
    for (const client of clients) client.end();
    for (const socket of terminalSockets) socket.destroy();
    telnet.close();
    ssh.close();
    await new Promise((resolve) => web.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve) => ssh.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => telnet.listen(0, "127.0.0.1", resolve));
  await apply({
    userQuestions: { ask: async () => { approvalRequests++; return { answers: [{ selected: allowCustom ? ["允许执行"] : ["拒绝"] }] }; } },
    webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } },
    effect: (register) => { disposers.push(register()); },
    inject: () => {},
    get: (name) => name === "tools" ? { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } : undefined,
  }, { dataDir, requireApproval: true, saveScrollback: false });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${web.address().port}/dsh-aixterm`;
  async function request(endpoint, body, method = "POST", headers = { "content-type": "application/json" }) {
    const response = await fetch(origin + endpoint, { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  const created = await request("/sessions", { name: "test-board", host: "127.0.0.1", port: ssh.address().port, user: "tester" });
  assert.equal(created.status, 200);
  const id = created.body.session.id;
  ids.push(id);
  assert.ok(tools.has("aixterm_diagnose"), "new tool registers with real DSH definition");
  assert.equal((await request("/diagnose", undefined, "GET")).status, 405);
  assert.equal((await request("/diagnose", {}, "POST", {})).status, 415);
  assert.equal((await request("/diagnose", { sessionId: id, scenario: "unknown" })).body.error, "invalid-scenario");
  assert.equal((await request("/diagnose", { sessionId: id, scenario: "service", service: "x; reboot" })).body.error, "invalid-service");
  assert.equal((await request("/diagnose", { sessionId: "absent" })).status, 404);
  assert.equal((await request("/diagnose", { sessionId: id, terminalId: "other-terminal" })).body.error, "terminal-session-mismatch");
  assert.equal(commands.length, 0, "invalid requests never execute SSH commands");

  const report = await request("/diagnose", { sessionId: id, scenario: "storage" });
  assert.equal(report.status, 200);
  assert.equal(report.body.session.id, id);
  assert.ok(report.body.findings.some((f) => f.evidenceId === "space"));
  await request("/sessions/update", { id, user: "other-tester" });
  const commandsBeforeEdit = commands.length;
  const agent = await tools.get("aixterm_diagnose").execute({ session: "test-board", scenario: "storage" });
  assert.deepEqual(agent.evidence.map((e) => [e.id, e.stdout]), report.body.evidence.map((e) => [e.id, e.stdout]));
  assert.ok(commandUsers.slice(commandsBeforeEdit).every((user) => user === "other-tester"), "changed connection settings must invalidate the pooled SSH connection");

  const custom = { schemaVersion: 1, id: "custom-echo", name: "Custom echo", target: { os: ["linux"], transport: ["ssh"] }, inputs: [{ id: "value", name: "Value" }], checks: [{ id: "echo", name: "Echo", command: "printf '%s' {{value}}", timeoutMs: 1000, maxOutputBytes: 1024 }] };
  const beforeProfiles = commands.length;
  assert.equal((await request("/diagnostic-profiles", custom)).status, 200);
  assert.equal((await request("/diagnostic-profiles", undefined, "GET")).body.profiles.length, 4);
  const params = { sessionId: id, profileId: custom.id, inputs: { value: "hello" } };
  assert.match((await request("/diagnose", params)).body.error, /confirmation/);
  const preview = await request("/diagnose/preview", params);
  assert.equal(preview.body.checks[0].command, "printf '%s' 'hello'");
  assert.equal(commands.length, beforeProfiles, "save and preview never execute commands");
  const executed = await request("/diagnose", { ...params, confirmationToken: preview.body.confirmationToken });
  assert.equal(executed.body.profile.id, custom.id);
  assert.equal(commands.at(-1), "printf '%s' 'hello'");
  assert.match((await request("/diagnose", { ...params, confirmationToken: preview.body.confirmationToken })).body.error, /confirmation/);
  const stale = await request("/diagnose/preview", params);
  assert.match((await request("/diagnose", { ...params, inputs: { value: "changed" }, confirmationToken: stale.body.confirmationToken })).body.error, /confirmation/);
  const beforeDenied = commands.length;
  const denied = await tools.get("aixterm_diagnose").execute({ session: id, profileId: custom.id, inputs: { value: "agent" } });
  assert.equal(denied.denied, true);
  assert.equal(commands.length, beforeDenied);
  allowCustom = true;
  const approved = await tools.get("aixterm_diagnose").execute({ session: id, profileId: custom.id, inputs: { value: "agent" } });
  assert.equal(approved.ok, true);
  assert.equal(approvalRequests, 2, "custom commands need approval even without danger-pattern matches");
  const exported = await request("/diagnostic-profiles/export?id=" + custom.id, undefined, "GET");
  const imported = await request("/diagnostic-profiles/import", { data: exported.body.data });
  assert.equal(imported.body.profiles[0].id, custom.id + "-2");
  assert.equal((await tools.get("aixterm_diagnostic_profiles").execute({})).profiles.length, 5);
  const jumpSession = await request("/sessions", { name: "jump-host", host: "127.0.0.1", port: ssh.address().port, user: "jump-user" });
  const throughJump = await request("/sessions", { name: "private-board", host: "192.0.2.10", user: "tester", proxyJump: jumpSession.body.session.id });
  const jumpParams = { ...params, sessionId: throughJump.body.session.id };
  const jumpPreview = await request("/diagnose/preview", jumpParams);
  const beforeJumpChange = commands.length;
  await request("/sessions/update", { id: jumpSession.body.session.id, host: "192.0.2.200" });
  const changedJump = await request("/diagnose", { ...jumpParams, confirmationToken: jumpPreview.body.confirmationToken });
  assert.match(changedJump.body.error, /confirmation/);
  assert.equal(commands.length, beforeJumpChange, "changed jump settings invalidate prior confirmation before connecting");

  const serial = await request("/sessions", { name: "serial-board", kind: "serial", serial: { path: "COM3" } });
  const countBefore = commands.length;
  const bufferOnly = await request("/diagnose", { sessionId: serial.body.session.id });
  assert.equal(bufferOnly.body.mode, "buffer-only");
  assert.equal(bufferOnly.body.partial, true);
  assert.equal(commands.length, countBefore);

  const telnetSession = await request("/sessions", { name: "telnet-board", kind: "telnet", host: "127.0.0.1", port: telnet.address().port });
  const opened = await request("/term/open", { sessionId: telnetSession.body.session.id });
  const terminalId = opened.body.terminalId;
  let received = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const output = await (await fetch(origin + "/term/log?terminalId=" + terminalId)).text();
    if (output.includes("END_OF_DIAGNOSTIC_LOG")) { received = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(received, "real Telnet bytes reach the shared terminal buffer");
  const liveReport = await request("/diagnose", { sessionId: telnetSession.body.session.id, terminalId });
  assert.equal(liveReport.body.evidence[0].truncated, true);
  assert.ok(liveReport.body.evidence[0].stdout.endsWith("END_OF_DIAGNOSTIC_LOG"));
  assert.ok(Buffer.byteLength(liveReport.body.evidence[0].stdout) <= 12000);
  await request("/sessions/update", { id: telnetSession.body.session.id, host: "192.0.2.99" });
  const staleTerminal = await request("/diagnose", { sessionId: telnetSession.body.session.id, terminalId });
  assert.equal(staleTerminal.body.error, "terminal-session-mismatch", "do not attribute an old device terminal to the edited connection target");

  assert.equal((await request("/lock/setup", { password: "test-only" })).status, 200);
  const raceSession = await request("/sessions", { name: "race-board", host: "127.0.0.1", port: ssh.address().port, user: "tester" });
  ids.push(raceSession.body.session.id);
  deferAuthentication = true;
  const authenticationStarted = new Promise((resolve) => { onPendingAuthentication = resolve; });
  const pendingReport = request("/diagnose", { sessionId: raceSession.body.session.id });
  await authenticationStarted;
  await request("/lock/lock", {});
  pendingAuthentication.accept();
  assert.equal((await pendingReport).status, 423);
  assert.equal((await request("/diagnose", { sessionId: id })).status, 423);
  assert.equal((await tools.get("aixterm_diagnose").execute({ session: id })).error, "locked");
  assert.equal(commands.length, countBefore, "locked UI and agent calls never execute commands");
});
