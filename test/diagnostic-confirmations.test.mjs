import { test } from "node:test";
import assert from "node:assert/strict";
import { DiagnosticConfirmations } from "../lib/diagnostic-confirmations.js";

test("execution confirmation is bound, expiring, single-use and bounded", () => {
  let now = 0;
  const confirmations = new DiagnosticConfirmations({ now: () => now });
  const binding = { session: "a", command: "echo ok", inputs: { value: "x" } };
  assert.throws(() => confirmations.consume("", binding), /confirmation/);
  const token = confirmations.issue(binding);
  assert.throws(() => confirmations.consume(token, { ...binding, session: "b" }), /confirmation/);
  const fresh = confirmations.issue(binding);
  confirmations.consume(fresh, binding);
  assert.throws(() => confirmations.consume(fresh, binding), /confirmation/);
  const expired = confirmations.issue(binding);
  now = 300001;
  assert.throws(() => confirmations.consume(expired, binding), /confirmation/);
  for (let i = 0; i < 200; i++) confirmations.issue(binding);
  assert.ok(confirmations.entries.size <= 128);
});
