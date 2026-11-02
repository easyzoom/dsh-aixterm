/**
 * dsh-aixterm — host plugin for DeepSeek Harness.
 *
 * Saved SSH sessions shared by the human (Web UI) and the agent (tools). Every
 * run — from the UI or a tool — is appended to a per-session shared log, so
 * both sides see the same activity. Routes:
 *   GET    /dsh-aixterm/sessions        list
 *   POST   /dsh-aixterm/sessions        create { name, group, host, port, user, auth, password }
 *   POST   /dsh-aixterm/sessions/update update a saved session (id + fields)
 *   DELETE /dsh-aixterm/sessions?id=    remove
 *   POST   /dsh-aixterm/exec            { sessionId, command, timeoutMs }
 *   POST   /dsh-aixterm/sftp            { sessionId, op: "list", path }
 *   GET    /dsh-aixterm/log?sessionId=   shared per-session log
 *   POST   /dsh-aixterm/test            { sessionId }
 *   GET    /dsh-aixterm/forward?sessionId=  list port forwards
 *   POST   /dsh-aixterm/forward         { sessionId, kind: local|remote|dynamic, bindAddr, bindPort, dstHost, dstPort }
 *   POST   /dsh-aixterm/forward/stop    { id }
 *   GET    /dsh-aixterm/monitor?sessionId=  CPU / memory / load / disk / network snapshot
 *   POST   /dsh-aixterm/sessions/duplicate  { id }
 *   GET    /dsh-aixterm/log/export?sessionId=&format=txt|html  shared log download
 *   GET    /dsh-aixterm/keys            list managed SSH keys
 *   POST   /dsh-aixterm/keys/generate   { name } -> { publicKey }
 *   POST   /dsh-aixterm/keys/import     { name, privateKey }
 *   POST   /dsh-aixterm/keys/delete     { name }
 *   GET    /dsh-aixterm/export?format=json|moba   download sessions
 *   POST   /dsh-aixterm/import          { format: json|xsh|moba, data }
 *   GET    /dsh-aixterm/serial/ports    list local serial ports
 *   GET    /dsh-aixterm/macros          list recorded macros
 *   POST   /dsh-aixterm/macros          { id?, name, description, steps[] }
 *   POST   /dsh-aixterm/macros/delete   { id }
 *   GET    /dsh-aixterm/tmux?sessionId=  detect + list remote tmux sessions
 *   POST   /dsh-aixterm/tmux            { sessionId, op: new|kill, name }
 *   POST   /dsh-aixterm/ai/ask          { sessionId?, terminalId?, cwd?, prompt } -> { answer }
 *
 * Agent tools (aixterm_list_sessions / aixterm_run / aixterm_sftp_list /
 * aixterm_test) register when the runtime serves a tool registry.
 */
import z from "@deepseek-ai/schemastery";
import { SessionStore, dataDirOf } from "./store.js";
import { exec, sftpList, sftpListResolved, testConnection, sftpRead, sftpWrite, sftpMkdir, sftpRename, sftpRemove, sftpChmod, startForward, listForwards, stopForward, dropSharedConnection } from "./ssh.js";
import { TerminalManager } from "./terminal.js";
import fs from "node:fs";
import path from "node:path";
import { isDangerous, DEFAULT_DANGER_PATTERNS } from "./policy.js";
import { LockManager } from "./lock.js";
import { SettingsStore } from "./settings.js";
import { MacroStore } from "./macros.js";
import { HistoryStore } from "./history.js";
import { TransferManager } from "./transfer.js";
import { listKeys, generateKey, importKey, deleteKey, keysDirOf } from "./keys.js";
import { parseXshell, parseMoba, parseJsonSessions, parseAuto, parseSecureCRT, parseGenericJson, exportJson, exportMoba } from "./import.js";

export const name = "dsh-aixterm";

/** The web server serves the client UI's routes. */
export const inject = ["webServer", "llm"];

export const Config = z.object({
  dataDir: z
    .string()
    .default("")
    .description("会话数据目录（默认 $DSH_HOME/aixterm）；密钥与加密凭据也在这里"),
  requireApproval: z.boolean().default(true).description("agent 执行危险命令/终端输入前是否请求用户批准"),
  dangerPatterns: z
    .array(z.string())
    .default(DEFAULT_DANGER_PATTERNS)
    .description("命中任一子串的命令需要用户批准"),
  aiProvider: z.string().default("").description("AI 助手使用的 provider（留空自动选择第一个）"),
  aiModel: z.string().default("").description("AI 助手使用的模型（留空自动选择第一个）"),
  saveScrollback: z.boolean().default(true).description("默认：是否把终端输出保存到本地文件（可在界面设置里修改）"),
  scrollbackDir: z.string().default("").description("默认保存目录（可在界面设置里修改；空= <dataDir>/terminals）"),
  bufferLines: z.number().default(2000).description("终端内存循环 buffer 行数（可在界面设置里修改）"),
  lockIdleMinutes: z.number().default(15).description("空闲自动锁定分钟数（0 关闭；需先设置主密码）"),
});

const PREFIX = "/dsh-aixterm";
const REPO_URL = "https://github.com/easyzoom/dsh-aixterm";
let VERSION = "";
try {
  VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "";
} catch {
  VERSION = "";
}
const LOG_LIMIT = 500;

function writeJson(res, status, body) {
  try {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(body));
  } catch {
    /* response already finished */
  }
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        try {
          req.destroy();
        } catch {
          /* already destroyed */
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const TMUX_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const TMUX_LIST_CMD =
  "command -v tmux >/dev/null 2>&1 || { echo NO_TMUX; exit 0; }; " +
  "tmux ls -F '#{session_name}|#{session_windows}|#{session_attached}|#{session_created}' 2>/dev/null || echo NO_SESSIONS";

/** Parse `tmux ls -F` output into { available, sessions }. */
function parseTmuxList(text) {
  const raw = String(text || "").trim();
  if (raw.startsWith("NO_TMUX")) return { available: false, sessions: [] };
  const sessions = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("NO_SESSIONS"))
    .map((line) => {
      const [name, windows, attached, created] = line.split("|");
      return { name, windows: Number(windows) || 0, attached: Number(attached) || 0, created: Number(created) || 0 };
    });
  return { available: true, sessions };
}

const MONITOR_CMD = [
  "awk '/^cpu /{printf \"cpu %s\\n\",$0}' /proc/stat",
  "sleep 1",
  "awk '/^cpu /{printf \"cpu2 %s\\n\",$0}' /proc/stat",
  "awk '/^(MemTotal|MemAvailable|MemFree):/{print}' /proc/meminfo",
  "printf 'load '; cat /proc/loadavg",
  "printf 'disk '; df -k / | tail -1",
  "printf 'net '; grep -E ':' /proc/net/dev | grep -v -E '^ *(lo|sit[0-9]*|Inter)' | head -4 | tr '\\n' '|'; echo",
  "printf 'uptime '; cat /proc/uptime",
  "printf 'users '; who 2>/dev/null | awk '{print $1}' | sort -u | tr '\\n' ','; echo",
  "printf 'sessions '; who 2>/dev/null | wc -l",
  "echo",
  "printf 'host '; uname -n",
  "printf 'kernel '; uname -r",
  "printf 'temp '; cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null",
  "echo",
].join("; ");

/** Read up to `maxBytes` from the end of a file; "" when unreadable. */
function readTailFile(file, maxBytes) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - Math.max(1, maxBytes));
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

/** Newest scrollback file for a session label, or "". */
function newestScrollback(dir, label) {
  try {
    const prefix = String(label || "").replace(/[^\w.@-]+/g, "_").slice(0, 60) + "-";
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files[0] ? path.join(dir, files[0].f) : "";
  } catch {
    return "";
  }
}

/** Parse the combined /proc + df output produced by the monitor command. */
function parseMonitor(text) {
  const out = { cpu: null, mem: null, load: null, disk: null, net: [], ts: Date.now() };
  let cpu1 = null;
  let cpu2 = null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("cpu ")) {
      const f = line.split(/\s+/).slice(1).map(num);
      cpu1 = f;
    } else if (line.startsWith("cpu2 ")) {
      const f = line.split(/\s+/).slice(1).map(num);
      cpu2 = f;
    } else if (line.startsWith("MemTotal:")) {
      out.mem = { ...(out.mem || {}), totalKb: num(line.split(/\s+/)[1]) };
    } else if (line.startsWith("MemAvailable:")) {
      out.mem = { ...(out.mem || {}), availableKb: num(line.split(/\s+/)[1]) };
    } else if (line.startsWith("MemFree:")) {
      out.mem = { ...(out.mem || {}), freeKb: num(line.split(/\s+/)[1]) };
    } else if (line.startsWith("load ")) {
      const f = line.split(/\s+/).slice(1);
      const run = String(f[3] || "").split("/");
      out.load = { one: num(f[0]), five: num(f[1]), fifteen: num(f[2]), running: num(run[0]), total: num(run[1]) };
    } else if (line.startsWith("disk ")) {
      const f = line.split(/\s+/).slice(1);
      out.disk = { fs: f[0] || "", totalKb: num(f[1]), usedKb: num(f[2]), availableKb: num(f[3]), usePercent: num(String(f[4] || "").replace("%", "")), mount: f[5] || "/" };
    } else if (line.startsWith("uptime ")) {
      out.uptimeSec = num(line.split(/\s+/)[1]);
    } else if (line.startsWith("users ")) {
      out.users = line.slice(6).split(",").map((u) => u.trim()).filter(Boolean);
    } else if (line.startsWith("sessions ")) {
      out.sessions = num(line.slice(9).trim());
    } else if (line.startsWith("host ")) {
      out.hostname = line.slice(5).trim();
    } else if (line.startsWith("kernel ")) {
      out.kernel = line.slice(7).trim();
    } else if (line.startsWith("temp ")) {
      const raw = line.slice(5).trim();
      out.tempC = raw ? num(raw) / 1000 : null;
    } else if (line.startsWith("net ")) {
      for (const part of line.slice(4).split("|")) {
        const m = part.match(/^\s*([^:]+):\s*(.*)$/);
        if (!m) continue;
        const vals = m[2].trim().split(/\s+/).map(num);
        out.net.push({ iface: m[1].trim(), rxBytes: vals[0] || 0, txBytes: vals[8] || 0 });
      }
    }
  }
  if (cpu1 && cpu2) {
    const idle1 = cpu1[3] + (cpu1[4] || 0);
    const idle2 = cpu2[3] + (cpu2[4] || 0);
    const total = (a) => a.reduce((x, y) => x + y, 0);
    const t1 = total(cpu1);
    const t2 = total(cpu2);
    const dt = t2 - t1;
    const di = idle2 - idle1;
    out.cpu = { usage: dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : null };
  }
  if (out.mem && out.mem.totalKb) {
    const used = out.mem.totalKb - (out.mem.availableKb || out.mem.freeKb || 0);
    out.mem.usedKb = used;
    out.mem.percent = (used / out.mem.totalKb) * 100;
  }
  return out;
}

function isJson(req) {
  return String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json");
}

function query(req, key) {
  try {
    return new URL(req.url || "/", "http://localhost").searchParams.get(key);
  } catch {
    return null;
  }
}

function makeRoutes({ store, logs, run, terminals, appendLog, secretFor, materialize, dataDir, config, getLlm, locker, settings, macros, history, transfers }) {
  const requireSession = (id) => {
    const s = store.get(id);
    return s ? { session: materialize(s) } : { error: "session-not-found" };
  };

  // Resolve a session's jump host (another saved session) into { session, secret }.
  const jumpFor = async (session) => {
    if (!session || !session.proxyJump) return undefined;
    const jump = materialize(store.get(session.proxyJump));
    if (!jump || jump.id === session.id) return undefined;
    return { session: jump, secret: await secretFor(jump) };
  };

  const routes = [
    {
      kind: "exact",
      path: `${PREFIX}/sessions`,
      handler: async (req, res) => {
        if (req.method === "GET") {
          writeJson(res, 200, { ok: true, sessions: store.list() });
          return;
        }
        if (req.method === "DELETE") {
          const id = query(req, "id");
          if (!id) return writeJson(res, 400, { ok: false, error: "missing-id" });
          const removed = store.remove(id);
          logs.delete(id);
          for (const f of listForwards(id)) stopForward(f.id);
          dropSharedConnection(id);
          return writeJson(res, removed ? 200 : 404, { ok: removed });
        }
        if (req.method === "POST") {
          if (!isJson(req)) return writeJson(res, 415, { ok: false, error: "json-required" });
          let body;
          try {
            body = await readJsonBody(req);
          } catch {
            return writeJson(res, 400, { ok: false, error: "invalid-body" });
          }
          const isSerial = Boolean(body && body.kind === "serial");
          const isTelnet = Boolean(body && body.kind === "telnet");
          if (isSerial) {
            if (!body.serial || !body.serial.path) return writeJson(res, 400, { ok: false, error: "serial-path-required" });
          } else if (isTelnet) {
            if (!body.host) return writeJson(res, 400, { ok: false, error: "host-required" });
          } else if (!body || !body.host || !body.user) {
            return writeJson(res, 400, { ok: false, error: "host-and-user-required" });
          }
          return writeJson(res, 200, { ok: true, session: store.create(body) });
        }
        writeJson(res, 405, { ok: false, error: "method-not-allowed" });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/sessions/update`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!isJson(req)) return writeJson(res, 415, { ok: false, error: "json-required" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        if (!body || !body.id) return writeJson(res, 400, { ok: false, error: "id-required" });
        const existing = store.get(body.id);
        if (!existing) return writeJson(res, 404, { ok: false, error: "session-not-found" });
        const kind = body.kind || existing.kind;
        if (kind === "serial") {
          const path = (body.serial && body.serial.path) || (existing.serial && existing.serial.path);
          if (!path) return writeJson(res, 400, { ok: false, error: "serial-path-required" });
        } else if (kind === "telnet") {
          if (!(body.host || existing.host)) return writeJson(res, 400, { ok: false, error: "host-required" });
        } else if (!(body.host || existing.host) || !(body.user || existing.user)) {
          return writeJson(res, 400, { ok: false, error: "host-and-user-required" });
        }
        const updated = store.update(body.id, body);
        return writeJson(res, 200, { ok: Boolean(updated), session: updated });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/sessions/duplicate`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const copy = store.duplicate(body && body.id);
        return writeJson(res, copy ? 200 : 404, { ok: Boolean(copy), session: copy });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/exec`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!isJson(req)) return writeJson(res, 415, { ok: false, error: "json-required" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const result = await run(body?.sessionId, body?.command, "human", body?.timeoutMs);
        writeJson(res, result.ok || result.code !== undefined ? 200 : 400, result);
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/sftp`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!isJson(req)) return writeJson(res, 415, { ok: false, error: "json-required" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const found = requireSession(body?.sessionId);
        if (found.error) return writeJson(res, 404, { ok: false, error: found.error });
        const op = body?.op || "list";
        const session = found.session;
        const secret = await secretFor(session);
        try {
          if (op === "list") {
            const listed = await sftpListResolved(session, secret, body?.path);
            return writeJson(res, 200, { ok: true, path: listed.path, entries: listed.entries });
          }
          if (op === "mkdir") {
            if (!body.path) return writeJson(res, 400, { ok: false, error: "path-required" });
            await sftpMkdir(session, secret, body.path);
            return writeJson(res, 200, { ok: true, path: body.path });
          }
          if (op === "rename") {
            if (!body.from || !body.to) return writeJson(res, 400, { ok: false, error: "from-and-to-required" });
            await sftpRename(session, secret, body.from, body.to);
            return writeJson(res, 200, { ok: true, from: body.from, to: body.to });
          }
          if (op === "delete") {
            if (!body.path) return writeJson(res, 400, { ok: false, error: "path-required" });
            await sftpRemove(session, secret, body.path);
            return writeJson(res, 200, { ok: true, path: body.path });
          }
          if (op === "chmod") {
            const mode = typeof body.mode === "string" ? parseInt(body.mode, 8) : Number(body.mode);
            if (!body.path || !Number.isFinite(mode)) return writeJson(res, 400, { ok: false, error: "path-and-mode-required" });
            await sftpChmod(session, secret, body.path, mode);
            return writeJson(res, 200, { ok: true, path: body.path, mode });
          }
          return writeJson(res, 400, { ok: false, error: "unsupported-op" });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/sftp/download`,
      handler: async (req, res) => {
        if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        const id = query(req, "sessionId");
        const p = query(req, "path");
        const session = id ? materialize(store.get(id)) : undefined;
        if (!session || !p) return writeJson(res, 400, { ok: false, error: "session-and-path-required" });
        try {
          const data = await sftpRead(session, await secretFor(session), p);
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="' + String(p).split("/").pop() + '"',
            "cache-control": "no-store",
          });
          res.end(data);
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/sftp/upload`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!isJson(req)) return writeJson(res, 415, { ok: false, error: "json-required" });
        let body;
        try {
          body = await readJsonBody(req, 32 * 1024 * 1024);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const session = body && body.sessionId ? materialize(store.get(body.sessionId)) : undefined;
        if (!session || !body.path || typeof body.data !== "string") return writeJson(res, 400, { ok: false, error: "session-path-data-required" });
        try {
          await sftpWrite(session, await secretFor(session), body.path, Buffer.from(body.data, "base64"));
          writeJson(res, 200, { ok: true });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/log`,
      handler: (req, res) => {
        if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        const id = query(req, "sessionId");
        writeJson(res, 200, { ok: true, sessionId: id, entries: (id && logs.get(id)) || [] });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/log/export`,
      handler: (req, res) => {
        if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        const id = query(req, "sessionId");
        const format = (query(req, "format") || "txt").toLowerCase();
        const entries = (id && logs.get(id)) || [];
        const session = id ? store.get(id) : undefined;
        const label = session ? `${session.user}@${session.host}:${session.port}` : String(id || "aixterm");
        const esc = (v) =>
          String(v ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        let body;
        let type;
        let ext;
        if (format === "html") {
          type = "text/html; charset=utf-8";
          ext = "html";
          const rows = entries
            .map(
              (e) => `<section><div class="meta">${esc(new Date(e.ts).toISOString())} · ${esc(e.source)} · exit ${esc(e.code)} · ${esc(e.durationMs)}ms</div><pre class="cmd">$ ${esc(e.command)}</pre>${e.stdout ? `<pre>${esc(e.stdout)}</pre>` : ""}${e.stderr ? `<pre class="err">${esc(e.stderr)}</pre>` : ""}</section>`
            )
            .join("\n");
          body = `<!doctype html><meta charset="utf-8"><title>aixterm log — ${esc(label)}</title><style>body{background:#0d1117;color:#c9d1d9;font:13px/1.5 ui-monospace,monospace;padding:24px}h1{font-size:16px}section{border-bottom:1px solid #283243;padding:10px 0}.meta{color:#8b949e;font-size:11px}.cmd{color:#58a6ff}pre{white-space:pre-wrap;word-break:break-all;margin:4px 0}.err{color:#f85149}</style><h1>aixterm — ${esc(label)}</h1>${rows}`;
        } else {
          type = "text/plain; charset=utf-8";
          ext = "txt";
          body = entries
            .map(
              (e) =>
                `# ${new Date(e.ts).toISOString()} [${e.source}] exit=${e.code} ${e.durationMs}ms\n$ ${e.command}\n${e.stdout || ""}${e.stderr ? `\n[stderr]\n${e.stderr}` : ""}`
            )
            .join("\n\n");
        }
        const safe = label.replace(/[^\w.@-]+/g, "_");
        res.writeHead(200, {
          "content-type": type,
          "content-disposition": `attachment; filename="aixterm-${safe}-log.${ext}"`,
          "cache-control": "no-store",
        });
        res.end(body);
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/test`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!isJson(req)) return writeJson(res, 415, { ok: false, error: "json-required" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const found = requireSession(body?.sessionId);
        if (found.error) return writeJson(res, 404, { ok: false, error: found.error });
        try {
          const started = Date.now();
          await testConnection(found.session, await secretFor(found.session));
          writeJson(res, 200, { ok: true, durationMs: Date.now() - started, jump: Boolean(found.session.proxyJump) });
        } catch (error) {
          writeJson(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/term/open`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!isJson(req)) return writeJson(res, 415, { ok: false, error: "json-required" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const cols = Number(body && body.cols) || 120;
        const rows = Number(body && body.rows) || 30;
        try {
          if (body && body.sessionId) {
            const session = materialize(store.get(body.sessionId));
            if (!session) return writeJson(res, 404, { ok: false, error: "session-not-found" });
            const tmuxName = body && typeof body.tmuxName === "string" && TMUX_NAME_RE.test(body.tmuxName) ? body.tmuxName : "";
            const id = await terminals.open({ session, secret: await secretFor(session), cols, rows, tmuxName });
            return writeJson(res, 200, {
              ok: true,
              terminalId: id,
              kind: session.kind === "serial" ? "serial" : session.kind === "telnet" ? "telnet" : "ssh",
              tmux: tmuxName || undefined,
            });
          }
          const id = await terminals.open({ local: { shell: body && body.shell }, cols, rows });
          writeJson(res, 200, { ok: true, terminalId: id, kind: "local" });
        } catch (error) {
          writeJson(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/term/stream`,
      handler: (req, res) => {
        if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        const id = query(req, "terminalId");
        const term = id ? terminals.get(id) : undefined;
        if (!term) return writeJson(res, 404, { ok: false, error: "terminal-not-found" });
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        const send = (buf) => {
          try {
            res.write("data: " + Buffer.from(buf).toString("base64") + "\n\n");
          } catch {
            /* closed */
          }
        };
        if (term.buffer) send(Buffer.from(term.buffer, "utf8"));
        const unsub = terminals.subscribe(id, send);
        const ka = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {
            /* closed */
          }
        }, 15000);
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          clearInterval(ka);
          unsub();
          try {
            res.end();
          } catch {
            /* closed */
          }
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
        req.on("error", cleanup);
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/term/input`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!isJson(req)) return writeJson(res, 415, { ok: false, error: "json-required" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        if (!body || !body.terminalId || !terminals.get(body.terminalId)) return writeJson(res, 404, { ok: false, error: "terminal-not-found" });
        // dataB64 carries binary input (ZMODEM negotiation bytes); data is text.
        if (typeof body.dataB64 === "string") terminals.input(body.terminalId, Buffer.from(body.dataB64, "base64"));
        else terminals.input(body.terminalId, body.data || "");
        writeJson(res, 200, { ok: true });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/term/log`,
      handler: (req, res) => {
        if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        const terminalId = query(req, "terminalId");
        const term = terminalId ? terminals.get(terminalId) : undefined;
        if (!term) return writeJson(res, 404, { ok: false, error: "terminal-not-found" });
        const body = term.logPath ? readTailFile(term.logPath, 20 * 1024 * 1024) : term.buffer || "";
        const safe = String(term.label || "terminal").replace(/[^\w.@-]+/g, "_").slice(0, 60);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${safe}-${stamp}.log"`,
          "cache-control": "no-store",
        });
        res.end(body);
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/term/resize`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!isJson(req)) return writeJson(res, 415, { ok: false, error: "json-required" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        if (!body || !body.terminalId) return writeJson(res, 404, { ok: false, error: "terminal-not-found" });
        terminals.resize(body.terminalId, body.cols, body.rows);
        writeJson(res, 200, { ok: true });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/monitor`,
      handler: async (req, res) => {
        if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        const id = query(req, "sessionId");
        const session = id ? store.get(id) : undefined;
        if (!session) return writeJson(res, 404, { ok: false, error: "session-not-found" });
        const cmd = MONITOR_CMD;
        try {
          const r = await exec(session, await secretFor(session), cmd, { timeoutMs: 10000 });
          return writeJson(res, 200, { ok: true, monitor: parseMonitor(r.stdout) });
        } catch (error) {
          return writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/forward`,
      handler: async (req, res) => {
        if (req.method === "GET") {
          return writeJson(res, 200, { ok: true, forwards: listForwards(query(req, "sessionId")) });
        }
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!isJson(req)) return writeJson(res, 415, { ok: false, error: "json-required" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const { session } = requireSession(body && body.sessionId);
        if (!session) return writeJson(res, 404, { ok: false, error: "session-not-found" });
        const kind = body.kind === "remote" || body.kind === "dynamic" ? body.kind : "local";
        if (kind !== "dynamic" && (!body.dstHost || !Number(body.dstPort))) {
          return writeJson(res, 400, { ok: false, error: "dstHost-and-dstPort-required" });
        }
        const entry = await startForward({
          session,
          secret: await secretFor(session),
          jump: await jumpFor(session),
          kind,
          bindAddr: body.bindAddr,
          bindPort: body.bindPort,
          dstHost: body.dstHost,
          dstPort: body.dstPort,
        });
        if (entry.state !== "running") return writeJson(res, 502, { ok: false, forward: entry, error: entry.error });
        appendLog(session.id, {
          ts: Date.now(),
          source: "human",
          command: `[forward ${kind}] ${entry.bindAddr}:${entry.bindPort} -> ${entry.dstHost || "socks"}:${entry.dstPort || ""}`,
          stdout: "",
          stderr: "",
          code: 0,
          durationMs: 0,
        });
        return writeJson(res, 200, { ok: true, forward: entry });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/forward/stop`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const stopped = stopForward(body && body.id);
        return writeJson(res, stopped ? 200 : 404, { ok: stopped });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/ai/ask`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req, 256 * 1024);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        let llm;
        try {
          llm = getLlm ? getLlm() : undefined;
        } catch {
          llm = undefined;
        }
        if (!llm || typeof llm.stream !== "function") {
          return writeJson(res, 503, { ok: false, error: "llm-unavailable" });
        }
        try {
          let provider = (config && config.aiProvider) || "";
          let model = (config && config.aiModel) || "";
          const providers = typeof llm.listProviders === "function" ? llm.listProviders() || [] : [];
          if (!provider) {
            // Pick the first provider that actually exposes models.
            for (const p of providers) {
              try {
                const models = await llm.listModels(p.id);
                if (models && models.length) {
                  provider = p.id;
                  if (!model) {
                    const preferred = models.find((m) => /deepseek/i.test(String(m.id)));
                    model = (preferred || models[0]).id;
                  }
                  break;
                }
              } catch {
                /* provider unavailable */
              }
            }
            if (!provider) {
              return writeJson(res, 503, { ok: false, error: "no-llm-provider", providers: providers.map((p) => p.id) });
            }
          } else if (!model) {
            const models = await llm.listModels(provider);
            if (!models || !models.length) return writeJson(res, 503, { ok: false, error: "no-llm-model", provider });
            const preferred = models.find((m) => /deepseek/i.test(String(m.id)));
            model = (preferred || models[0]).id;
          }
          const sessionId = body && body.sessionId;
          const session = sessionId ? store.get(sessionId) : undefined;
          const terminalId = body && body.terminalId;
          let tail = "";
          const liveTerm = terminalId ? terminals.get(terminalId) : undefined;
          if (liveTerm && liveTerm.logPath) tail = readTailFile(liveTerm.logPath, 6000);
          if (!tail && terminalId) tail = terminals.read(terminalId, 6000);
          if (!tail && session) {
            const file = newestScrollback(terminals.dir, session.kind === "serial" ? `serial-${session.name}` : session.name);
            if (file) tail = readTailFile(file, 6000);
          }
          const recent = ((sessionId && logs.get(sessionId)) || [])
            .slice(-8)
            .map((e) => `$ ${e.command}\n${String(e.stdout || "").slice(0, 800)}${e.stderr ? `\n[stderr] ${String(e.stderr).slice(0, 400)}` : ""}`)
            .join("\n---\n");
          const cwd = body && body.cwd ? String(body.cwd) : "";
          const target = session
            ? `${session.name}（${session.kind === "serial" ? "串口" : "SSH"}${
                session.kind === "serial"
                  ? ` ${session.serial ? `${session.serial.path}@${session.serial.baudRate}` : ""}`
                  : ` ${session.user}@${session.host}:${session.port}`
              }）`
            : "未知会话";
          const context = [
            `会话：${target}`,
            cwd ? `当前目录：${cwd}` : "",
            recent ? `最近命令记录：\n${recent}` : "",
            tail ? `终端最近输出（含终端转义码，可忽略）：\n${tail}` : "",
          ]
            .filter(Boolean)
            .join("\n\n");
          const system =
            "你是 dsh-aixterm 的终端 AI 助手，用户正在一个远程 Linux 终端里工作。基于给出的会话信息、当前目录、命令历史和终端输出来回答。需要给出命令时，用 ```sh 代码块包裹，并简要说明风险或前提。回答简洁、准确，使用中文。";
          const messages = [
            { role: "user", content: [{ type: "text", text: `${context}\n\n问题：${String((body && body.prompt) || "")}` }] },
          ];
          let answer = "";
          let failure = null;
          for await (const chunk of llm.stream({ provider, model, system, messages })) {
            if (!chunk) continue;
            if (chunk.type === "text-delta" && chunk.text) answer += chunk.text;
            if (chunk.type === "finish" && chunk.reason && chunk.reason.kind === "error") failure = chunk.reason.failure;
          }
          if (!answer && failure) {
            return writeJson(res, 200, { ok: false, error: String(failure.message || failure.code || "llm-error"), provider, model });
          }
          if (answer) {
            pushAiHistory(sessionId, {
              ts: Date.now(),
              prompt: String((body && body.prompt) || ""),
              answer,
            });
          }
          return writeJson(res, 200, { ok: true, answer, provider, model });
        } catch (error) {
          return writeJson(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/tmux`,
      handler: async (req, res) => {
        let body = null;
        if (req.method === "POST") {
          try {
            body = await readJsonBody(req);
          } catch {
            return writeJson(res, 400, { ok: false, error: "invalid-body" });
          }
        }
        const id = query(req, "sessionId") || (body && body.sessionId);
        const session = id ? materialize(store.get(id)) : undefined;
        if (!session) return writeJson(res, 404, { ok: false, error: "session-not-found" });
        if (session.kind !== "ssh") return writeJson(res, 400, { ok: false, error: "ssh-only" });
        const secret = await secretFor(session);
        if (req.method === "GET") {
          try {
            const r = await exec(session, secret, TMUX_LIST_CMD, { timeoutMs: 8000 });
            return writeJson(res, 200, { ok: true, ...parseTmuxList(r.stdout) });
          } catch (error) {
            return writeJson(res, 200, { ok: false, error: String(error?.message ?? error) });
          }
        }
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        const name = String((body && body.name) || "");
        if (!TMUX_NAME_RE.test(name)) return writeJson(res, 400, { ok: false, error: "invalid-tmux-name" });
        const op = body && body.op;
        const command =
          op === "new"
            ? `tmux new-session -d -s '${name}'`
            : op === "kill"
              ? `tmux kill-session -t '${name}'`
              : "";
        if (!command) return writeJson(res, 400, { ok: false, error: "unsupported-op" });
        try {
          const r = await exec(session, secret, command, { timeoutMs: 8000 });
          if (r.code !== 0) return writeJson(res, 200, { ok: false, error: String(r.stderr || "tmux-failed") });
          return writeJson(res, 200, { ok: true, name });
        } catch (error) {
          return writeJson(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/transfers`,
      handler: async (req, res) => {
        if (req.method === "GET") return writeJson(res, 200, { ok: true, transfers: transfers.list() });
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req, 256 * 1024 * 1024);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const found = requireSession(body && body.sessionId);
        if (found.error) return writeJson(res, 404, { ok: false, error: found.error });
        const secret = await secretFor(found.session);
        try {
          if (body.kind === "upload") {
            if (!body.remotePath || typeof body.dataB64 !== "string") {
              return writeJson(res, 400, { ok: false, error: "remotePath-and-dataB64-required" });
            }
            const task = transfers.createUpload({
              session: found.session,
              secret,
              name: body.name,
              remotePath: body.remotePath,
              dataB64: body.dataB64,
              policy: body.policy,
            });
            return writeJson(res, 200, { ok: true, transfer: task });
          }
          if (body.kind === "download") {
            if (!body.remotePath) return writeJson(res, 400, { ok: false, error: "remotePath-required" });
            const task = transfers.createDownload({
              session: found.session,
              secret,
              remotePath: body.remotePath,
              localName: body.name,
              policy: body.policy,
            });
            return writeJson(res, 200, { ok: true, transfer: task });
          }
          return writeJson(res, 400, { ok: false, error: "unsupported-kind" });
        } catch (error) {
          return writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/transfers/action`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const ok = body && body.id ? transfers.action(body.id, body.action) : false;
        return writeJson(res, ok ? 200 : 404, { ok, transfers: transfers.list() });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/transfers/file`,
      handler: (req, res) => {
        if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        const id = query(req, "id");
        const task = id ? transfers.tasks.get(id) : undefined;
        if (!task || task.kind !== "download" || task.status !== "done") {
          return writeJson(res, 404, { ok: false, error: "file-not-ready" });
        }
        try {
          const data = fs.readFileSync(task.localPath);
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="' + String(task.name).replace(/"/g, "") + '"',
            "cache-control": "no-store",
          });
          return res.end(data);
        } catch (error) {
          return writeJson(res, 404, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/history`,
      handler: (req, res) => {
        if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        const id = query(req, "sessionId");
        if (!id) return writeJson(res, 400, { ok: false, error: "sessionId-required" });
        return writeJson(res, 200, { ok: true, sessionId: id, commands: history.list(id) });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/history/clear`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        if (!body || !body.sessionId) return writeJson(res, 400, { ok: false, error: "sessionId-required" });
        history.clear(body.sessionId);
        return writeJson(res, 200, { ok: true });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/macros`,
      handler: async (req, res) => {
        if (req.method === "GET") return writeJson(res, 200, { ok: true, macros: macros.list() });
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req, 256 * 1024);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        try {
          const saved = macros.save(body);
          return writeJson(res, 200, { ok: true, macro: saved });
        } catch (error) {
          return writeJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/macros/delete`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const removed = macros.remove(body && body.id);
        return writeJson(res, removed ? 200 : 404, { ok: removed });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/settings`,
      handler: async (req, res) => {
        if (req.method === "GET") return writeJson(res, 200, { ok: true, settings: { ...settings.get(), scrollbackDir: terminals.dir } });
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        try {
          const next = settings.update(body);
          terminals.applySettings();
          return writeJson(res, 200, { ok: true, settings: { ...next, scrollbackDir: terminals.dir } });
        } catch (error) {
          return writeJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/config`,
      handler: (req, res) => {
        if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        const live = settings.get();
        return writeJson(res, 200, {
          ok: true,
          dataDir,
          scrollbackDir: terminals.dir,
          saveScrollback: live.saveScrollback,
          bufferLines: live.bufferLines,
          requireApproval: !config || config.requireApproval !== false,
          version: VERSION,
          repo: REPO_URL,
        });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/lock/status`,
      handler: (req, res) => {
        if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        writeJson(res, 200, { ok: true, locked: locker.locked, hasMaster: locker.hasMaster, idleMinutes: locker.idleMinutes });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/lock/setup`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        try {
          locker.setup(body && body.password);
          locker.setIdle(body && body.idleMinutes !== undefined ? body.idleMinutes : locker.idleMinutes);
          return writeJson(res, 200, { ok: true });
        } catch (error) {
          return writeJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/lock/lock`,
      handler: (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        try {
          locker.lock();
          return writeJson(res, 200, { ok: true, locked: true });
        } catch (error) {
          return writeJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/lock/unlock`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const ok = locker.unlock(body && body.password);
        return writeJson(res, ok ? 200 : 401, { ok, error: ok ? undefined : "wrong-password" });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/lock/idle`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        locker.setIdle(body && body.minutes);
        return writeJson(res, 200, { ok: true, idleMinutes: locker.idleMinutes });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/lock/touch`,
      handler: (req, res) => {
        locker.touch();
        writeJson(res, 200, { ok: true });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/serial/ports`,
      handler: async (req, res) => {
        if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        try {
          const { SerialPort } = await import("serialport");
          const ports = await SerialPort.list();
          return writeJson(res, 200, {
            ok: true,
            ports: ports.map((p) => ({
              path: p.path,
              manufacturer: p.manufacturer || "",
              serialNumber: p.serialNumber || "",
              vendorId: p.vendorId || "",
              productId: p.productId || "",
            })),
          });
        } catch (error) {
          return writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/keys`,
      handler: async (req, res) => {
        if (req.method === "GET") return writeJson(res, 200, { ok: true, keys: listKeys(dataDir) });
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const op = body && body.op;
        try {
          if (op === "generate") {
            const made = generateKey(dataDir, body.name);
            return writeJson(res, 200, { ok: true, key: made });
          }
          if (op === "import") {
            const made = importKey(dataDir, body.name, body.privateKey);
            return writeJson(res, 200, { ok: true, key: made });
          }
          if (op === "delete") {
            return writeJson(res, 200, { ok: deleteKey(dataDir, body.name) });
          }
          return writeJson(res, 400, { ok: false, error: "unsupported-op" });
        } catch (error) {
          return writeJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/export`,
      handler: (req, res) => {
        if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        const format = (query(req, "format") || "json").toLowerCase();
        const sessions = store.list();
        if (format === "moba") {
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": 'attachment; filename="aixterm-sessions.mxtsessions"',
            "cache-control": "no-store",
          });
          return res.end(exportMoba(sessions));
        }
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": 'attachment; filename="aixterm-sessions.json"',
          "cache-control": "no-store",
        });
        return res.end(exportJson(sessions));
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/import`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        let body;
        try {
          body = await readJsonBody(req, 4 * 1024 * 1024);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        const format = String((body && body.format) || "json").toLowerCase();
        let drafts;
        try {
          if (format === "auto") drafts = parseAuto(body.data, body.filename || "");
          else if (format === "xsh") drafts = parseXshell(body.data);
          else if (format === "moba") drafts = parseMoba(body.data);
          else if (format === "crt") drafts = parseSecureCRT(body.data);
          else if (format === "generic") drafts = parseGenericJson(body.data);
          else drafts = parseJsonSessions(body.data);
        } catch (error) {
          return writeJson(res, 400, { ok: false, error: `parse-failed: ${error?.message ?? error}` });
        }
        const existing = new Set(store.list().map((x) => `${x.host}:${x.port}:${x.user}`));
        const created = [];
        const skipped = [];
        for (const draft of drafts) {
          const key = `${draft.host}:${draft.port}:${draft.user}`;
          if (existing.has(key)) {
            skipped.push({ name: draft.name, reason: "duplicate" });
            continue;
          }
          const made = store.create({
            name: draft.name,
            group: draft.group,
            host: draft.host,
            port: draft.port,
            user: draft.user,
            auth: draft.auth || { kind: "password" },
          });
          existing.add(key);
          created.push({ id: made.id, name: made.name, proxyJumpName: draft.proxyJumpName || "" });
        }
        // Resolve jump-host names to ids in a second pass.
        const byName = new Map(store.list().map((x) => [x.name, x.id]));
        for (const item of created) {
          if (item.proxyJumpName && byName.has(item.proxyJumpName) && byName.get(item.proxyJumpName) !== item.id) {
            store.update(item.id, { proxyJump: byName.get(item.proxyJumpName) });
          }
        }
        return writeJson(res, 200, { ok: true, created: created.length, skipped: skipped.length, names: created.map((c) => c.name) });
      },
    },
    {
      kind: "exact",
      path: `${PREFIX}/term/close`,
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!isJson(req)) return writeJson(res, 415, { ok: false, error: "json-required" });
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return writeJson(res, 400, { ok: false, error: "invalid-body" });
        }
        if (body && body.terminalId) terminals.close(body.terminalId);
        writeJson(res, 200, { ok: true });
      },
    },
  ];

  // Gate every route behind the lock, except the lock APIs themselves.
  const lockPaths = new Set([
    `${PREFIX}/lock/status`,
    `${PREFIX}/lock/setup`,
    `${PREFIX}/lock/lock`,
    `${PREFIX}/lock/unlock`,
    `${PREFIX}/lock/idle`,
    `${PREFIX}/lock/touch`,
  ]);
  return routes.map((route) => ({
    ...route,
    handler: async (req, res) => {
      if (!lockPaths.has(route.path)) {
        if (locker && locker.locked) return writeJson(res, 423, { ok: false, error: "locked" });
        if (locker) locker.touch();
      }
      return route.handler(req, res);
    },
  }));
}

export async function apply(ctx, config) {
  const dataDir = dataDirOf(config);
  // LLM service for the AI assistant panel (lazy: the service may mount later).
  let llmService;
  try {
    try {
    } catch (e) {
    }
    if (typeof ctx?.inject === "function") {
      ctx.inject(["llm"], (llmCtx) => {
        llmService = llmCtx.llm;
      });
    }
  } catch (e) {
  }

  const locker = new LockManager(dataDir, {
    idleMinutes: config && config.lockIdleMinutes !== undefined ? config.lockIdleMinutes : 15,
  });
  const idleTimer = setInterval(() => {
    try {
      locker.checkIdle();
    } catch {
      /* idle check failed */
    }
  }, 15000);
  idleTimer.unref && idleTimer.unref();

  // Embedded skill: teaches the chat agent how to drive this plugin.
  try {
    ctx?.inject?.(["skills"], (skillCtx) => {
      try {
        const disposeSkill = skillCtx.skills.register({
          name: "aixterm",
          description:
            "Operate saved SSH/Telnet/serial sessions: list sessions, read logs, analyze hosts, run commands, drive tmux and shared terminals.",
          content: [
            "# dsh-aixterm",
            "",
            "The user keeps saved SSH / Telnet / serial sessions in this plugin. Each tool accepts a session **id or exact name**.",
            "",
            "## When the user references a terminal",
            'If the message says "@name", "on name", "the box", "that server", or asks about recent output, resolve it with `aixterm_list_sessions` (or pass the name directly).',
            "",
            "## Tools",
            "- `aixterm_list_sessions` — saved sessions (id, name, host, port, user, kind).",
            "- `aixterm_read_log` — recent commands + terminal scrollback tail.",
            "- `aixterm_analyze` — connection facts + resource monitor (CPU/mem/load/disk/network/uptime/users) + recent output.",
            "- `aixterm_run` — run one non-interactive command. Dangerous commands automatically ask the user for approval.",
            "- `aixterm_term_open` / `aixterm_term_read` / `aixterm_term_send` — the shared interactive terminal.",
            "- `aixterm_tmux_sessions` — remote tmux sessions (create/enter them from the UI or via `aixterm_run`).",
            "- `aixterm_create_session` — save a new session (host/user are required; a password is optional).",
            "- `aixterm_term_read` / `aixterm_term_send` — also accept `session` (id or name) to read/write the session's currently open terminal, no terminalId needed.",
            "- `aixterm_ai_history` — the AI panel's recent Q&A for a session.",
            "- `aixterm_command_history` — recent commands typed in a session (shared with the UI suggestion bar).",
            "- `aixterm_run_all` — run one command on several sessions (default: all SSH sessions); dangerous commands ask for one batch approval.",
            "- `aixterm_run_macro` — replay a saved macro on several sessions; stops each session at the first failing step.",
            "",
            "## Rules",
            "- Prefer read-only commands; explain destructive ones before running them.",
            "- Never fabricate output: call a tool and quote what it returned.",
            "- The human sees the same terminal and shared log; summarize what you did.",
          ].join("\n"),
        });
        if (typeof disposeSkill === "function") {
          try {
            ctx?.effect?.(() => disposeSkill, "dsh-aixterm: skill");
          } catch {
            /* effect unavailable */
          }
        }
      } catch (error) {
        ctx?.logger?.warn?.(`dsh-aixterm: 注册 skill 失败：${error?.message ?? error}`);
      }
    });
  } catch {
    /* skills service unavailable */
  }

  const store = new SessionStore(dataDir);
  const settings = new SettingsStore(dataDir, {
    saveScrollback: !config || config.saveScrollback !== false,
    scrollbackDir: (config && config.scrollbackDir) || "",
    bufferLines: (config && config.bufferLines) || 2000,
  });
  const terminals = new TerminalManager({
    dataDir,
    settings,
    onCommand: (sessionId, command) => history.add(sessionId, command),
  });
  const macros = new MacroStore(dataDir);
  const history = new HistoryStore(dataDir);
  const transfers = new TransferManager(dataDir);
  const logs = new Map();

  // Resolve a session secret: dsh credential service (credentialEnv) first,
  // then the encrypted per-session store. Never logs the value.
  const secretFor = async (session) => {
    if (!session) return undefined;
    const env = session.auth && session.auth.credentialEnv;
    if (env) {
      try {
        const svc = ctx && ctx.credentials;
        if (svc && typeof svc.resolve === "function") {
          const hit = await svc.resolve(env);
          if (hit && hit.value) return hit.value;
        }
      } catch {
        /* credential service unavailable */
      }
      if (process.env[env]) return process.env[env];
    }
    return store.credential(session.id);
  };

  // Ask the human before an agent-initiated dangerous action. Deny when the
  // approval surface is unavailable (fail closed).
  const askApproval = async (execCtx, session, text, kind) => {
    if (!config || config.requireApproval === false) return { allowed: true };
    if (!isDangerous(text, config && config.dangerPatterns)) return { allowed: true };
    const uq = (ctx && ctx.userQuestions) || (typeof ctx?.get === "function" ? ctx.get("userQuestions") : undefined);
    if (!uq || typeof uq.ask !== "function") return { allowed: false, error: "approval-unavailable" };
    try {
      const req = {
        questions: [
          {
            id: "aixterm-danger",
            header: "dsh-aixterm 危险操作",
            question: `确认在 ${session.name}（${session.user}@${session.host}:${session.port}）上执行${kind === "terminal" ? "终端输入" : "命令"}？`,
            detail: String(text),
            options: [{ label: "允许执行" }, { label: "拒绝" }],
          },
        ],
      };
      if (execCtx && execCtx.callId) req.wait = { callId: execCtx.callId };
      const result = await uq.ask(req);
      const answer = result && result.answers && result.answers[0];
      const ok = answer && Array.isArray(answer.selected) && answer.selected.includes("允许执行");
      return ok ? { allowed: true } : { allowed: false, error: "denied-by-user" };
    } catch (error) {
      return { allowed: false, error: `approval-failed: ${error?.message ?? error}` };
    }
  };

  // Managed key ids resolve to files under <dataDir>/keys at connect time.
  const materialize = (session) => {
    if (!session || !session.auth || session.auth.kind !== "key" || !session.auth.keyId) return session;
    return { ...session, auth: { ...session.auth, keyPath: path.join(keysDirOf(dataDir), session.auth.keyId) } };
  };

  // AI-panel conversation history (per session; in-memory, last 50 entries).
  const aiHistory = new Map();
  const pushAiHistory = (sessionId, entry) => {
    const key = sessionId || "global";
    const arr = aiHistory.get(key) || [];
    arr.push(entry);
    if (arr.length > 50) arr.splice(0, arr.length - 50);
    aiHistory.set(key, arr);
  };

  const appendLog = (sessionId, entry) => {
    const arr = logs.get(sessionId) || [];
    arr.push(entry);
    if (arr.length > LOG_LIMIT) arr.splice(0, arr.length - LOG_LIMIT);
    logs.set(sessionId, arr);
  };

  const run = async (sessionId, command, source, timeoutMs, execCtx) => {
    const session = sessionId ? materialize(store.get(sessionId)) : undefined;
    if (!session) return { ok: false, error: "session-not-found" };
    if (typeof command !== "string" || command.trim() === "") return { ok: false, error: "empty-command" };
    if (source === "agent") {
      const verdict = await askApproval(execCtx, session, command, "command");
      if (!verdict.allowed) {
        appendLog(sessionId, { ts: Date.now(), source, command, stdout: "", stderr: verdict.error, code: -1, durationMs: 0 });
        return { ok: false, error: verdict.error, denied: true };
      }
    }
    const secret = await secretFor(session);
    const t0 = Date.now();
    const result = await exec(session, secret, command, {
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000,
    });
    const durationMs = Date.now() - t0;
    appendLog(sessionId, { ts: Date.now(), source, command, stdout: result.stdout, stderr: result.stderr, code: result.code, durationMs });
    return { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr, durationMs };
  };

  const findSession = (ref) => {
    if (!ref) return undefined;
    const key = String(ref);
    return store.get(key) || store.list().find((s) => s.name === key);
  };

  const findLiveTerminal = (session) => {
    for (const term of terminals.terms.values()) {
      if (!term.closed && term.params && term.params.session && term.params.session.id === session.id) return term;
    }
    return null;
  };

  const sessionBrief = (session) => ({
    id: session.id,
    name: session.name,
    kind: session.kind,
    host: session.host,
    port: session.port,
    user: session.user,
    serial: session.serial,
  });

  const host = {
    listSessions: () => store.list(),
    readLog: async (ref, maxBytes) => {
      const session = findSession(ref);
      if (!session) return { ok: false, error: "session-not-found" };
      const label = session.kind === "serial" ? `serial-${session.name}` : session.name;
      const file = newestScrollback(terminals.dir, label);
      const scrollback = file ? readTailFile(file, Number(maxBytes) > 0 ? Number(maxBytes) : 12000) : "";
      return {
        ok: true,
        session: sessionBrief(session),
        entries: (logs.get(session.id) || []).slice(-20),
        scrollback,
        scrollbackFile: file,
      };
    },
    createSession: (input) => {
      const draft = input || {};
      if (!draft.host || !draft.user) return { ok: false, error: "host-and-user-required" };
      try {
        const session = store.create({
          name: draft.name || `${draft.user}@${draft.host}`,
          group: draft.group || "AI",
          host: draft.host,
          port: Number(draft.port) || 22,
          user: draft.user,
          auth: { kind: "password", credentialEnv: draft.credentialEnv || "" },
          password: draft.password || undefined,
        });
        return { ok: true, session };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
    tmuxList: async (ref) => {
      const session = findSession(ref);
      if (!session) return { ok: false, error: "session-not-found" };
      if (session.kind !== "ssh") return { ok: false, error: "ssh-only" };
      try {
        const r = await exec(materialize(session), await secretFor(session), TMUX_LIST_CMD, { timeoutMs: 8000 });
        return { ok: true, ...parseTmuxList(r.stdout) };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
    analyze: async (ref) => {
      const session = findSession(ref);
      if (!session) return { ok: false, error: "session-not-found" };
      const label = session.kind === "serial" ? `serial-${session.name}` : session.name;
      const file = newestScrollback(terminals.dir, label);
      let monitor = null;
      if (session.kind === "ssh") {
        try {
          const r = await exec(materialize(session), await secretFor(session), MONITOR_CMD, { timeoutMs: 10000 });
          monitor = parseMonitor(r.stdout);
        } catch {
          monitor = null;
        }
      }
      return {
        ok: true,
        session: sessionBrief(session),
        monitor,
        entries: (logs.get(session.id) || []).slice(-20),
        scrollback: file ? readTailFile(file, 16000) : "",
        scrollbackFile: file,
      };
    },
    run,
    sftpList: async (sessionId, p) => {
      const session = materialize(store.get(sessionId));
      if (!session) return { ok: false, error: "session-not-found" };
      try {
        return { ok: true, path: p || ".", entries: await sftpList(session, await secretFor(session), p) };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
    test: async (sessionId) => {
      const session = materialize(store.get(sessionId));
      if (!session) return { ok: false, error: "session-not-found" };
      try {
        const started = Date.now();
        await testConnection(session, await secretFor(session));
        return { ok: true, durationMs: Date.now() - started };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
    termOpen: async ({ sessionId, local } = {}) => {
      try {
        if (sessionId) {
          const session = materialize(store.get(sessionId));
          if (!session) return { ok: false, error: "session-not-found" };
          const id = await terminals.open({ session, secret: await secretFor(session) });
          return { ok: true, terminalId: id, kind: "ssh" };
        }
        const id = await terminals.open({ local: local || {} });
        return { ok: true, terminalId: id, kind: "local" };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
    termRead: (terminalId, maxBytes) => {
      const output = terminals.read(terminalId, maxBytes);
      return output === undefined ? { ok: false, error: "terminal-not-found" } : { ok: true, terminalId, output };
    },
    termReadSession: (ref, maxBytes) => {
      const session = findSession(ref);
      if (!session) return { ok: false, error: "session-not-found" };
      const term = findLiveTerminal(session);
      if (!term) return { ok: false, error: "no-open-terminal" };
      const output = terminals.read(term.id, maxBytes);
      return output === undefined ? { ok: false, error: "terminal-not-found" } : { ok: true, terminalId: term.id, output };
    },
    termSendSession: async (ref, data, execCtx) => {
      const session = findSession(ref);
      if (!session) return { ok: false, error: "session-not-found" };
      const term = findLiveTerminal(session);
      if (!term) return { ok: false, error: "no-open-terminal" };
      const verdict = await askApproval(execCtx, session, data, "terminal");
      if (!verdict.allowed) {
        appendLog(session.id, { ts: Date.now(), source: "agent", command: String(data), stdout: "", stderr: verdict.error, code: -1, durationMs: 0 });
        return { ok: false, error: verdict.error, denied: true };
      }
      terminals.input(term.id, data);
      return { ok: true, terminalId: term.id };
    },
    commandHistory: (ref) => {
      const session = findSession(ref);
      if (!session) return { ok: false, error: "session-not-found" };
      return { ok: true, session: sessionBrief(session), commands: history.list(session.id).slice(-50) };
    },
    aiHistory: (ref) => {
      const session = findSession(ref);
      if (!session) return { ok: false, error: "session-not-found" };
      return { ok: true, session: sessionBrief(session), entries: (aiHistory.get(session.id) || []).slice(-20) };
    },
    runAll: async (refs, command, timeoutMs, execCtx) => {
      const list =
        Array.isArray(refs) && refs.length
          ? refs.map((r) => findSession(r)).filter(Boolean)
          : store.list().filter((s) => s.kind === "ssh");
      if (!list.length) return { ok: false, error: "no-sessions" };
      if (isDangerous(command, config && config.dangerPatterns)) {
        const verdict = await askApproval(
          execCtx,
          { name: `${list.length} 个会话`, user: "", host: "", port: "" },
          command,
          "command"
        );
        if (!verdict.allowed) return { ok: false, error: verdict.error, denied: true };
      }
      const perTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000;
      const results = [];
      for (const target of list) {
        try {
          const r = await exec(materialize(target), await secretFor(target), command, { timeoutMs: perTimeout });
          results.push({
            session: target.name,
            ok: r.code === 0,
            code: r.code,
            stdout: String(r.stdout || "").slice(0, 2000),
            stderr: String(r.stderr || "").slice(0, 1000),
          });
        } catch (error) {
          results.push({ session: target.name, ok: false, error: String(error?.message ?? error) });
        }
      }
      return { ok: true, count: results.length, results };
    },
    runMacro: async (macroRef, refs, timeoutMs, execCtx) => {
      const macro = macros.list().find((m) => m.id === macroRef || m.name === macroRef);
      if (!macro) return { ok: false, error: "macro-not-found" };
      const list =
        Array.isArray(refs) && refs.length
          ? refs.map((r) => findSession(r)).filter(Boolean)
          : store.list().filter((s) => s.kind === "ssh");
      if (!list.length) return { ok: false, error: "no-sessions" };
      const risky = macro.steps.filter((step) => isDangerous(step, config && config.dangerPatterns));
      if (risky.length) {
        const verdict = await askApproval(
          execCtx,
          { name: `${list.length} 个会话`, user: "", host: "", port: "" },
          `${macro.name}: ${risky.join(" ; ")}`,
          "command"
        );
        if (!verdict.allowed) return { ok: false, error: verdict.error, denied: true };
      }
      const perTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000;
      const results = [];
      for (const target of list) {
        const steps = [];
        for (const step of macro.steps) {
          try {
            const r = await exec(materialize(target), await secretFor(target), step, { timeoutMs: perTimeout });
            steps.push({ step, ok: r.code === 0, code: r.code, stdout: String(r.stdout || "").slice(0, 800), stderr: String(r.stderr || "").slice(0, 400) });
            if (r.code !== 0) break;
          } catch (error) {
            steps.push({ step, ok: false, error: String(error?.message ?? error) });
            break;
          }
        }
        results.push({ session: target.name, ok: steps.every((x) => x.ok), steps });
      }
      return { ok: true, count: results.length, results };
    },
    termSend: async (terminalId, data, execCtx) => {
      const term = terminals.get(terminalId);
      if (!term) return { ok: false, error: "terminal-not-found" };
      const session = term.params && term.params.session;
      if (session) {
        const verdict = await askApproval(execCtx, session, data, "terminal");
        if (!verdict.allowed) {
          appendLog(session.id, { ts: Date.now(), source: "agent", command: String(data), stdout: "", stderr: verdict.error, code: -1, durationMs: 0 });
          return { ok: false, error: verdict.error, denied: true };
        }
      }
      terminals.input(terminalId, data);
      return { ok: true };
    },
  };

  // Web routes (best-effort; never throw from apply).
  try {
    if (ctx?.webServer && typeof ctx.webServer.register === "function") {
      const register = () => {
        const disposers = makeRoutes({ store, logs, run, terminals, appendLog, secretFor, materialize, dataDir, config, getLlm: () => llmService, locker, settings, macros, history, transfers }).map((route) => {
          try {
            return ctx.webServer.register(route);
          } catch {
            return undefined;
          }
        });
        return () => {
          try {
            clearInterval(idleTimer);
          } catch {
            /* already cleared */
          }
          for (const d of disposers) {
            try {
              d?.();
            } catch {
              /* already disposed */
            }
          }
          for (const id of [...terminals.terms.keys()]) terminals.close(id);
        };
      };
      if (typeof ctx.effect === "function") ctx.effect(register, "dsh-aixterm: routes");
      else register();
    }
  } catch (error) {
    ctx?.logger?.warn?.(`dsh-aixterm: 注册 web 路由失败：${error?.message ?? error}`);
  }

  // Agent tools (optional; the registry may be absent, and dsh-tools may not resolve).
  try {
    const tools = typeof ctx?.get === "function" ? ctx.get("tools") : undefined;
    if (tools && typeof tools.register === "function") {
      const mod = await import("./tools.js").catch(() => null);
      if (mod && typeof mod.buildTools === "function") {
        const disposers = mod.buildTools(host).map((tool) => {
          try {
            return tools.register(tool);
          } catch {
            return undefined;
          }
        });
        if (typeof ctx.effect === "function") {
          ctx.effect(
            () => () => {
              for (const d of disposers) {
                try {
                  d?.();
                } catch {
                  /* already disposed */
                }
              }
            },
            "dsh-aixterm: tools"
          );
        }
      }
    }
  } catch (error) {
    ctx?.logger?.warn?.(`dsh-aixterm: 注册 agent 工具失败：${error?.message ?? error}`);
  }
}
