import { DIAGNOSTIC_SCENARIOS, diagnosticChecks } from "./diagnostic-builtins.js";

export const PROFILE_FILE_LIMIT = 1024 * 1024;
const ID = /^[a-z][a-z0-9._-]{0,63}$/;
const INPUT_ID = /^[a-z][a-z0-9_]{0,31}$/;
const fail = (field, message) => { throw new Error(`${field}: ${message}`); };
function record(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field, "object required");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${field}.${key}`, "unknown field");
}
function text(value, field, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value.length > max || value.includes("\0")) fail(field, `string required, at most ${max} characters, no NUL`);
  return value;
}
function identifier(value, field, regex = ID) {
  if (typeof value !== "string" || !regex.test(value) || ["constructor", "prototype"].includes(value)) fail(field, "invalid identifier");
  return value;
}
function integer(value, field, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) fail(field, `${min}–${max} integer required`);
  return value;
}
function choices(value, allowed, field) {
  if (!Array.isArray(value) || !value.length || value.some((v) => !allowed.includes(v)) || new Set(value).size !== value.length) fail(field, `nonempty unique array of ${allowed.join(", ")}`);
  return [...value];
}

// Parameters must be stand-alone shell words. Reject quoted, escaped and
// concatenated placeholders rather than pretending to parse arbitrary shell.
export function substituteParameters(command, known, values) {
  if (command.includes("{{") && command.includes("<<")) fail("command", "parameters in here-documents are not supported");
  let quote = "", result = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "#" && !quote) {
      const end = command.indexOf("\n", i), comment = command.slice(i, end < 0 ? command.length : end);
      if (comment.includes("{{")) fail("command", "parameters in comments are not supported");
      result += comment;
      i += comment.length - 1;
      continue;
    }
    if (command.startsWith("{{", i)) {
      const end = command.indexOf("}}", i + 2), id = command.slice(i + 2, end);
      if (end < 0 || !known.has(id)) fail("command", `unknown parameter ${id}`);
      if (quote || (i > 0 && !/[\s|;&(<>=]/.test(command[i - 1])) || (end + 2 < command.length && !/[\s|;&)<>]/.test(command[end + 2]))) fail("command", "parameter must be an unquoted stand-alone shell word");
      const value = values ? values[id] : "";
      result += values ? `'${value.replace(/'/g, "'\\''")}'` : "''";
      i = end + 1;
      continue;
    }
    if (command.startsWith("}}", i)) fail("command", "unmatched parameter delimiter");
    result += ch;
    if (ch === "\\" && quote !== "'") { if (i + 1 < command.length) result += command[++i]; continue; }
    if (["'", '"', "`"].includes(ch)) {
      if (!quote) quote = ch;
      else if (quote === ch) quote = "";
    }
  }
  return result;
}

export function validateProfile(value) {
  record(value, ["schemaVersion", "id", "name", "description", "target", "inputs", "checks", "analysis"], "profile");
  if (value.schemaVersion !== 1) fail("schemaVersion", "only version 1 is supported");
  const id = identifier(value.id, "id"), name = text(value.name, "name", 120).trim();
  if (!name) fail("name", "required");
  record(value.target, ["os", "transport"], "target");
  const target = { os: choices(value.target.os, ["linux"], "target.os"), transport: choices(value.target.transport, ["ssh", "serial", "telnet"], "target.transport") };
  const rawInputs = value.inputs === undefined ? [] : value.inputs;
  if (!Array.isArray(rawInputs) || rawInputs.length > 8) fail("inputs", "at most 8 inputs");
  const known = new Set();
  const inputs = rawInputs.map((input, i) => {
    record(input, ["id", "name", "required", "default"], `inputs[${i}]`);
    const inputId = identifier(input.id, `inputs[${i}].id`, INPUT_ID);
    if (known.has(inputId)) fail("inputs", `duplicate id ${inputId}`);
    known.add(inputId);
    if (input.required !== undefined && typeof input.required !== "boolean") fail("inputs.required", "boolean required");
    const name = text(input.name, "inputs.name", 80).trim(), defaultValue = text(input.default, "inputs.default", 256, "");
    if (!name || /[\r\n]/.test(defaultValue)) fail("inputs", "nonempty name and single-line default required");
    return { id: inputId, name, required: input.required ?? true, default: defaultValue };
  });
  if (!Array.isArray(value.checks) || !value.checks.length || value.checks.length > 12) fail("checks", "1–12 checks required");
  const checkIds = new Set(["platform"]);
  let timeoutBudget = 0, outputBudget = 0, terminalCount = 0;
  const checks = value.checks.map((check, i) => {
    record(check, ["id", "name", "type", "command", "timeoutMs", "maxOutputBytes"], `checks[${i}]`);
    const checkId = identifier(check.id, `checks[${i}].id`);
    if (checkIds.has(checkId)) fail("checks", `duplicate or reserved id ${checkId}`);
    checkIds.add(checkId);
    const type = check.type === undefined ? "command" : check.type;
    if (!["command", "terminal"].includes(type)) fail("checks.type", "command or terminal required");
    const item = { id: checkId, name: text(check.name, "checks.name", 120).trim(), type, maxOutputBytes: integer(check.maxOutputBytes, "checks.maxOutputBytes", 256, 32768, type === "terminal" ? 12000 : 16384) };
    if (!item.name) fail("checks.name", "required");
    if (type === "command") {
      item.command = text(check.command, "checks.command", 4096);
      if (!item.command.trim() || checkId === "terminal") fail("checks.command", "nonempty command and nonreserved id required");
      substituteParameters(item.command, known);
      item.timeoutMs = integer(check.timeoutMs, "checks.timeoutMs", 100, 15000, 5000);
      timeoutBudget += item.timeoutMs;
    } else {
      if (++terminalCount > 1 || check.command !== undefined || check.timeoutMs !== undefined) fail("checks", "one terminal step allowed; no command or timeout on terminal steps");
    }
    outputBudget += item.maxOutputBytes;
    return item;
  });
  if (timeoutBudget > 60000 || outputBudget > 131072) fail("checks", "total timeout/output budget exceeded");
  if (value.analysis !== undefined) record(value.analysis, ["instructions"], "analysis");
  return { schemaVersion: 1, id, name, description: text(value.description, "description", 2000, ""), target, inputs, checks, analysis: { instructions: text(value.analysis?.instructions, "analysis.instructions", 8000, "") } };
}

export function renderProfile(definition, supplied = {}) {
  const profile = validateProfile(definition);
  record(supplied, profile.inputs.map((p) => p.id), "inputs");
  const values = Object.create(null), known = new Set(profile.inputs.map((p) => p.id));
  for (const input of profile.inputs) {
    const value = text(Object.hasOwn(supplied, input.id) ? supplied[input.id] : input.default, `inputs.${input.id}`, 256);
    if (/[\r\n]/.test(value)) fail(`inputs.${input.id}`, "single-line value required");
    if (input.required && !value.trim()) fail(`inputs.${input.id}`, "required");
    values[input.id] = value;
  }
  return { profile, inputs: values, checks: profile.checks.map((c) => ({ ...c, label: c.name, ...(c.type === "command" ? { command: substituteParameters(c.command, known, values) } : {}) })) };
}

export function builtinProfiles() {
  return DIAGNOSTIC_SCENARIOS.map((scenario) => ({
    ...validateProfile({ schemaVersion: 1, id: scenario.id, name: scenario.label, target: { os: ["linux"], transport: ["ssh", "serial", "telnet"] },
      inputs: scenario.id === "service" ? [{ id: "service", name: "服务名", required: true }] : [],
      checks: [...diagnosticChecks(scenario.id, scenario.id === "service" ? "template-service" : "").map((c) => ({ id: c.id, name: c.label.replace("：template-service", ""), command: c.command.replaceAll("'template-service'", "{{service}}") })), { id: "terminal", name: "当前终端输出末尾（可能包含更早的日志）", type: "terminal" }],
    }), builtin: true,
  }));
}

export function profileDefinition(profile) {
  const { builtin, ...definition } = profile;
  return validateProfile(definition);
}
