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
 *
 * Agent tools (aixterm_list_sessions / aixterm_run / aixterm_sftp_list /
 * aixterm_test) register when the runtime serves a tool registry.
 */
import z from "@deepseek-ai/schemastery";
import { SessionStore, dataDirOf } from "./store.js";
import { exec, sftpList, testConnection } from "./ssh.js";

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

function makeRoutes({ store, logs, run }) {
  const requireSession = (id) => {
    const s = store.get(id);
    return s ? { session: s } : { error: "session-not-found" };
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
        if (op !== "list") return writeJson(res, 400, { ok: false, error: "unsupported-op" });
        try {
          const entries = await sftpList(found.session, store.credential(body.sessionId), body?.path);
          writeJson(res, 200, { ok: true, path: body?.path || ".", entries });
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
  ];
}

export async function apply(ctx, config) {
  const dataDir = dataDirOf(config);
  const store = new SessionStore(dataDir);
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
  };

  // Web routes (best-effort; never throw from apply).
  try {
    if (ctx?.webServer && typeof ctx.webServer.register === "function") {
      const register = () => {
        const disposers = makeRoutes({ store, logs, run }).map((route) => {
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
