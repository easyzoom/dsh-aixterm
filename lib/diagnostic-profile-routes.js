import { PROFILE_FILE_LIMIT } from "./diagnostic-profiles.js";

export function diagnosticProfileRoutes({ store, diagnose, readJsonBody, writeJson, isJson, query }) {
  const route = (path, methods, action) => ({
    kind: "exact", path: "/dsh-aixterm" + path,
    handler: async (req, res) => {
      if (!methods.includes(req.method)) return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
      if (req.method === "POST" && !isJson(req)) return writeJson(res, 415, { ok: false, error: "json-required" });
      try {
        const body = req.method === "POST" ? await readJsonBody(req, PROFILE_FILE_LIMIT * 2 + 1024) : undefined;
        const result = await action(req, body);
        return writeJson(res, result.ok === false ? (result.error === "locked" ? 423 : 400) : 200, result);
      } catch (error) { return writeJson(res, 400, { ok: false, error: String(error?.message || error) }); }
    },
  });
  return [
    route("/diagnostic-profiles", ["GET", "POST"], (req, body) => req.method === "GET" ? { ok: true, profiles: store.list() } : { ok: true, profile: store.save(body) }),
    route("/diagnostic-profiles/delete", ["POST"], (_req, body) => {
      if (typeof body?.id !== "string") throw new Error("profile-id-required");
      return { ok: true, removed: store.remove(body.id) };
    }),
    route("/diagnostic-profiles/import", ["POST"], (_req, body) => ({ ok: true, ...store.import(body?.data) })),
    route("/diagnostic-profiles/export", ["GET"], (req) => ({ ok: true, data: store.export(query(req, "id") || undefined) })),
    route("/diagnose/preview", ["POST"], (_req, body) => diagnose(body?.sessionId, body?.scenario, body?.service, body?.terminalId, { profileId: body?.profileId, inputs: body?.inputs, preview: true })),
  ];
}
