/**
 * dsh-aixterm — host plugin for DeepSeek Harness.
 *
 * Saved SSH sessions shared by the human (Web UI) and the agent (tools). Every
 * run — from the UI or a tool — is appended to a per-session shared log, so
 * both sides see the same activity. Routes:
 *   GET    /dsh-aixterm/sessions        list
 *   POST   /dsh-aixterm/sessions        create { name, group, host, port, user, auth, password }
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
 *
 * Agent tools (aixterm_list_sessions / aixterm_run / aixterm_sftp_list /
 * aixterm_test) register when the runtime serves a tool registry.
 */
import z from "@deepseek-ai/schemastery";
import { SessionStore, dataDirOf } from "./store.js";
import { exec, sftpList, sftpListResolved, testConnection, sftpRead, sftpWrite, sftpMkdir, sftpRename, sftpRemove, sftpChmod, startForward, listForwards, stopForward, dropSharedConnection } from "./ssh.js";
import { TerminalManager } from "./terminal.js";

export const name = "dsh-aixterm";

/** The web server serves the client UI's routes. */
export const inject = ["webServer"];

export const Config = z.object({
  dataDir: z
    .string()
    .default("")
    .description("会话数据目录（默认 $DSH_HOME/aixterm）；密钥与加密凭据也在这里"),
});

const PREFIX = "/dsh-aixterm";
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

function makeRoutes({ store, logs, run, terminals, appendLog }) {
  const requireSession = (id) => {
    const s = store.get(id);
    return s ? { session: s } : { error: "session-not-found" };
  };

  // Resolve a session's jump host (another saved session) into { session, secret }.
  const jumpFor = (session) => {
    if (!session || !session.proxyJump) return undefined;
    const jump = store.get(session.proxyJump);
    if (!jump || jump.id === session.id) return undefined;
    return { session: jump, secret: store.credential(jump.id) };
  };

  return [
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
          if (!body || !body.host || !body.user) return writeJson(res, 400, { ok: false, error: "host-and-user-required" });
          return writeJson(res, 200, { ok: true, session: store.create(body) });
        }
        writeJson(res, 405, { ok: false, error: "method-not-allowed" });
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
        const secret = store.credential(body.sessionId);
        const session = found.session;
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
        const session = id ? store.get(id) : undefined;
        if (!session || !p) return writeJson(res, 400, { ok: false, error: "session-and-path-required" });
        try {
          const data = await sftpRead(session, store.credential(id), p);
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
        const session = body && body.sessionId ? store.get(body.sessionId) : undefined;
        if (!session || !body.path || typeof body.data !== "string") return writeJson(res, 400, { ok: false, error: "session-path-data-required" });
        try {
          await sftpWrite(session, store.credential(body.sessionId), body.path, Buffer.from(body.data, "base64"));
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
          await testConnection(found.session, store.credential(body.sessionId));
          writeJson(res, 200, { ok: true });
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
            const session = store.get(body.sessionId);
            if (!session) return writeJson(res, 404, { ok: false, error: "session-not-found" });
            const id = await terminals.open({ session, secret: store.credential(body.sessionId), cols, rows });
            return writeJson(res, 200, { ok: true, terminalId: id, kind: "ssh" });
          }
          const id = await terminals.open({ local: { shell: body && body.shell }, cols, rows });
          writeJson(res, 200, { ok: true, terminalId: id, kind: "local" });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
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
        terminals.input(body.terminalId, body.data || "");
        writeJson(res, 200, { ok: true });
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
        const cmd = [
          "awk '/^cpu /{printf \"cpu %s\\n\",$0}' /proc/stat",
          "sleep 1",
          "awk '/^cpu /{printf \"cpu2 %s\\n\",$0}' /proc/stat",
          "awk '/^(MemTotal|MemAvailable|MemFree):/{print}' /proc/meminfo",
          "printf 'load '; cat /proc/loadavg",
          "printf 'disk '; df -k / | tail -1",
          "printf 'net '; grep -E ':' /proc/net/dev | grep -v -E '^ *(lo|sit[0-9]*|Inter)' | head -4 | tr '\\n' '|'",
          "echo",
        ].join("; ");
        try {
          const r = await exec(session, store.credential(id), cmd, { timeoutMs: 10000 });
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
          secret: store.credential(session.id),
          jump: jumpFor(session),
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
}

export async function apply(ctx, config) {
  const dataDir = dataDirOf(config);
  const store = new SessionStore(dataDir);
  const terminals = new TerminalManager({ dataDir });
  const logs = new Map();

  const appendLog = (sessionId, entry) => {
    const arr = logs.get(sessionId) || [];
    arr.push(entry);
    if (arr.length > LOG_LIMIT) arr.splice(0, arr.length - LOG_LIMIT);
    logs.set(sessionId, arr);
  };

  const run = async (sessionId, command, source, timeoutMs) => {
    const session = sessionId ? store.get(sessionId) : undefined;
    if (!session) return { ok: false, error: "session-not-found" };
    if (typeof command !== "string" || command.trim() === "") return { ok: false, error: "empty-command" };
    const secret = store.credential(sessionId);
    const t0 = Date.now();
    const result = await exec(session, secret, command, {
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000,
    });
    const durationMs = Date.now() - t0;
    appendLog(sessionId, { ts: Date.now(), source, command, stdout: result.stdout, stderr: result.stderr, code: result.code, durationMs });
    return { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr, durationMs };
  };

  const host = {
    listSessions: () => store.list(),
    run,
    sftpList: async (sessionId, p) => {
      const session = store.get(sessionId);
      if (!session) return { ok: false, error: "session-not-found" };
      try {
        return { ok: true, path: p || ".", entries: await sftpList(session, store.credential(sessionId), p) };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
    test: async (sessionId) => {
      const session = store.get(sessionId);
      if (!session) return { ok: false, error: "session-not-found" };
      try {
        await testConnection(session, store.credential(sessionId));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
    termOpen: async ({ sessionId, local } = {}) => {
      try {
        if (sessionId) {
          const session = store.get(sessionId);
          if (!session) return { ok: false, error: "session-not-found" };
          const id = await terminals.open({ session, secret: store.credential(sessionId) });
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
    termSend: (terminalId, data) => {
      if (!terminals.get(terminalId)) return { ok: false, error: "terminal-not-found" };
      terminals.input(terminalId, data);
      return { ok: true };
    },
  };

  // Web routes (best-effort; never throw from apply).
  try {
    if (ctx?.webServer && typeof ctx.webServer.register === "function") {
      const register = () => {
        const disposers = makeRoutes({ store, logs, run, terminals, appendLog }).map((route) => {
          try {
            return ctx.webServer.register(route);
          } catch {
            return undefined;
          }
        });
        return () => {
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
