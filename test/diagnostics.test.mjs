import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { connect } from "../lib/ssh.js";
import { collectDiagnostics, diagnosticChecks, executeDiagnostic, formatDiagnosticPrompt } from "../lib/diagnostics.js";

const session = { id: "board", name: "开发板", kind: "ssh", host: "localhost", user: "tester" };

test("diagnostics reject invalid scenarios and service names before execution", async () => {
  assert.throws(() => diagnosticChecks("unknown"), /invalid-scenario/);
  for (const service of ["", "-x", "a; reboot", "$(id)", "a\nreboot", "a".repeat(65)]) {
    assert.throws(() => diagnosticChecks("service", service), /invalid-service/);
  }
  const checks = diagnosticChecks("service", "sshd@board.service");
  assert.ok(checks.some((c) => c.command.includes("'sshd@board.service'")));
  assert.throws(() => diagnosticChecks("boot", "$(id)"), /invalid-service/);
});

test("SSH reports retain failed checks, disk evidence, timestamps and selected identity", async () => {
  const calls = [];
  const report = await collectDiagnostics({ session, scenario: "storage", readOutput: () => "recent output", execute: async (command) => {
    calls.push(command);
    if (command === "uname -s") return { code: 0, stdout: "Linux\n", stderr: "" };
    if (command === "df -kP") return { code: 0, stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 100 95 5 95% /\n", stderr: "" };
    if (command.includes("df -i")) return { code: 1, stdout: "", stderr: "unsupported" };
    return { code: 0, stdout: "ok", stderr: "" };
  } });
  assert.equal(report.ok, true);
  assert.equal(report.partial, true);
  assert.equal(report.session.id, session.id);
  assert.ok(Number.isFinite(Date.parse(report.collectedAt)));
  assert.equal(calls.length, diagnosticChecks("storage").length + 1);
  assert.ok(report.evidence.some((c) => c.status === "error" && c.stderr === "unsupported"));
  assert.ok(report.findings.some((f) => f.evidenceId === "space" && f.message.includes("95%")));
  const prompt = formatDiagnosticPrompt(report);
  assert.ok(prompt.includes(report.collectedAt));
  assert.ok(prompt.includes("/dev/root"));
  assert.ok(prompt.includes("不执行"));
});

test("non-Linux targets are detected before sending Linux-specific checks", async () => {
  const calls = [];
  const report = await collectDiagnostics({ session, scenario: "boot", execute: async (command) => {
    calls.push(command);
    return { code: 0, stdout: "Darwin\n", stderr: "" };
  } });
  assert.deepEqual(calls, ["uname -s"]);
  assert.equal(report.partial, true);
  assert.equal(report.evidence[0].error, "unsupported-target-platform");
});

test("serial paths are opaque identifiers across Windows, Linux and macOS hosts", async () => {
  for (const serialPath of ["COM3", "\\\\.\\COM12", "/dev/ttyUSB0", "/dev/cu.usbserial-123"]) {
    const report = await collectDiagnostics({ session: { ...session, kind: "serial", serial: { path: serialPath } }, readOutput: () => "boot log" });
    assert.equal(report.mode, "buffer-only");
    assert.equal(report.evidence[0].stdout, "boot log");
  }
});

test("serial and Telnet diagnostics only read existing output; absent output is incomplete", async () => {
  for (const kind of ["serial", "telnet"]) {
    const report = await collectDiagnostics({ session: { ...session, kind }, scenario: "boot", readOutput: () => "Kernel panic - not syncing", execute: () => assert.fail("must not send commands") });
    assert.equal(report.evidence.length, 1);
    assert.equal(report.evidence[0].id, "terminal");
    assert.equal(report.mode, "buffer-only");
    assert.ok(report.findings.some((f) => f.evidenceId === "terminal"));
    const empty = await collectDiagnostics({ session: { ...session, kind }, scenario: "boot", readOutput: () => "" });
    assert.equal(empty.partial, true);
    assert.equal(empty.evidence[0].status, "unavailable");
  }
});

test("connection failures preserve available evidence and bounded terminal tail", async () => {
  const report = await collectDiagnostics({ session, scenario: "boot", readOutput: () => "x".repeat(20000), execute: async () => { throw new Error("connection refused"); } });
  assert.equal(report.partial, true);
  assert.ok(report.evidence.filter((e) => e.command).every((e) => e.status === "error"));
  const terminal = report.evidence.find((e) => e.id === "terminal");
  assert.ok(Buffer.byteLength(terminal.stdout) <= 12000);
  assert.equal(terminal.truncated, true);
});

test("unverified terminal routes are reported as missing evidence rather than attributed to the target", async () => {
  const report = await collectDiagnostics({ session, scenario: "storage", execute: async (command) => ({ code: 0, stdout: command === "uname -s" ? "Linux" : "ok", stderr: "" }), readOutput: () => { throw new Error("terminal-route-unverified"); } });
  const terminal = report.evidence.find((e) => e.id === "terminal");
  assert.equal(terminal.status, "unavailable");
  assert.equal(terminal.error, "terminal-route-unverified");
  assert.equal(terminal.stdout, "");
  assert.equal(report.partial, true);
});

test("all scenarios use static read-only checks, never start or source init scripts", () => {
  for (const scenario of ["boot", "service", "storage"]) {
    const checks = diagnosticChecks(scenario, scenario === "service" ? "my-app" : "");
    assert.ok(checks.length >= 3);
    for (const { command } of checks) {
      assert.doesNotMatch(command, /\b(sudo|reboot|rm|kill|eval)\b|systemctl\s+(start|restart|stop)|\/etc\/init\.d\/[^\s]+\s+(start|status)/);
    }
  }
});

test("custom profiles run rendered steps with per-step limits and preserve analysis guidance", async () => {
  const profile = { schemaVersion: 1, id: "custom", name: "My plan", target: { os: ["linux"], transport: ["ssh"] }, inputs: [{ id: "value", name: "Value" }], checks: [{ id: "echo", name: "Echo", command: "echo {{value}}", timeoutMs: 1000, maxOutputBytes: 2048 }], analysis: { instructions: "Focus on this evidence." } };
  const calls = [];
  const report = await collectDiagnostics({ session, profile, inputs: { value: "hello" }, execute: async (command, limits) => { calls.push({ command, limits }); return { code: 0, stdout: command === "uname -s" ? "Linux" : "hello", stderr: "" }; } });
  assert.equal(report.profile.id, "custom");
  assert.deepEqual(calls[1], { command: "echo 'hello'", limits: { timeoutMs: 1000, maxBytes: 2048 } });
  assert.ok(formatDiagnosticPrompt(report).includes("Focus on this evidence."));
  await assert.rejects(collectDiagnostics({ session: { ...session, kind: "serial" }, profile, inputs: { value: "hello" } }), /unsupported-profile-transport/);
});

test("pure log profiles require no SSH command, even on SSH sessions", async () => {
  const profile = { schemaVersion: 1, id: "logs", name: "Logs", target: { os: ["linux"], transport: ["ssh", "serial", "telnet"] }, checks: [{ id: "log", name: "Log tail", type: "terminal", maxOutputBytes: 256 }] };
  const report = await collectDiagnostics({ session, profile, readOutput: () => "x".repeat(500), execute: () => assert.fail("pure log collection must not execute") });
  assert.equal(report.evidence.length, 1);
  assert.equal(report.evidence[0].id, "log");
  assert.equal(report.evidence[0].truncated, true);
  assert.ok(Buffer.byteLength(report.evidence[0].stdout) <= 256);
});

test("mixed terminal and command steps retain the configured capture order", async () => {
  const profile = { schemaVersion: 1, id: "ordered", name: "Order", target: { os: ["linux"], transport: ["ssh"] }, checks: [{ id: "before", name: "Before", type: "terminal" }, { id: "after", name: "After", command: "echo next" }] };
  const events = [];
  const report = await collectDiagnostics({ session, profile, execute: async (command) => { events.push(command); return { code: 0, stdout: command === "uname -s" ? "Linux" : "ok", stderr: "" }; }, readOutput: () => { events.push("read-buffer"); return "before-command"; } });
  assert.deepEqual(events, ["uname -s", "read-buffer", "echo next"]);
  assert.deepEqual(report.evidence.map((e) => e.id), ["platform", "before", "after"]);
});

test("missing boot timing tools and failed pipeline producers stay incomplete", async () => {
  const report = await collectDiagnostics({ session, scenario: "boot", execute: async (command) => {
    if (command === "uname -s") return { code: 0, stdout: "Linux\n", stderr: "" };
    if (command.includes("systemd-analyze")) return { code: 0, stdout: "[unavailable] systemd-analyze; current uptime only:\n25 40", stderr: "" };
    if (command.startsWith("dmesg")) return { code: 0, stdout: "", stderr: "dmesg: permission denied" };
    return { code: 0, stdout: "ok", stderr: "" };
  } });
  assert.equal(report.partial, true);
  assert.equal(report.evidence.find((e) => e.id === "boot").status, "unavailable");
  assert.equal(report.evidence.find((e) => e.id === "kernel").status, "error");
});

test("SSH channel execution handles real output, nonzero exits, timeout and bounded output", async (t) => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const clients = new Set();
  const server = new ssh2.Server({ hostKeys: [privateKey.export({ type: "pkcs1", format: "pem" })] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => client.on("session", (accept) => {
      accept().on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        stream.on("error", () => {});
        if (info.command === "hang") return;
        if (info.command === "huge") stream.write(Buffer.alloc(64000, 120));
        else { stream.write("evidence"); stream.stderr.write("detail"); }
        stream.exit(info.command === "fail" ? 3 : 0);
        stream.end();
      });
    }));
  });
  t.after(() => { for (const client of clients) client.end(); server.close(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const conn = await connect({ ...session, host: "127.0.0.1", port: server.address().port }, "any");
  t.after(() => conn.end());
  const normal = await executeDiagnostic(conn, "normal");
  assert.equal(normal.stdout, "evidence");
  assert.equal(normal.stderr, "detail");
  assert.equal(normal.code, 0);
  assert.equal((await executeDiagnostic(conn, "fail")).code, 3);
  const huge = await executeDiagnostic(conn, "huge", { maxBytes: 256 });
  assert.ok(Buffer.byteLength(huge.stdout) + Buffer.byteLength(huge.stderr) <= 256);
  assert.equal(huge.truncated, true);
  const timeout = await executeDiagnostic(conn, "hang", { timeoutMs: 50 });
  assert.equal(timeout.error, "timeout");
  // Closing an individual exec channel must leave the shared connection usable.
  assert.equal((await executeDiagnostic(conn, "normal")).code, 0);
});
