// lib/import.js — parse/export saved sessions for JSON, Xshell (.xsh) and
// MobaXterm (.mxtsessions). Parsing never touches credentials.
const isSsh = (v) => !v || String(v).toLowerCase() === "ssh";

/** Parse an Xshell .xsh (INI) document into session drafts. */
export function parseXshell(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      if (/^\[CONNECTION\]$/i.test(line)) {
        cur = { name: "", host: "", port: 22, user: "" };
        out.push(cur);
      } else if (!/^\[CONNECTION:/i.test(line)) {
        cur = null;
      }
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^([^=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (key === "host") cur.host = value;
    else if (key === "port") cur.port = Number(value) || 22;
    else if (key === "username") cur.user = value;
    else if (key === "protocol" && !isSsh(value)) cur.skip = true;
  }
  return out
    .filter((s) => s.host && s.user && !s.skip)
    .map((s) => ({
      name: s.name || `${s.user}@${s.host}`,
      group: "Xshell",
      host: s.host,
      port: s.port || 22,
      user: s.user,
    }));
}

/** Parse a MobaXterm .mxtsessions (INI) document into session drafts. */
export function parseMoba(text) {
  const out = [];
  let group = "MobaXterm";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (/^SubRep=/i.test(line)) {
      const value = line.slice(7).trim();
      if (value) group = value;
      continue;
    }
    const m = line.match(/^(.+?)=#109#\d+%(.*)$/);
    if (!m) continue;
    const name = m[1].trim();
    const parts = m[2].split("%");
    const host = (parts[0] || "").trim();
    const port = Number(parts[1]) || 22;
    const user = (parts[2] || "").trim();
    if (host && user) out.push({ name: name || `${user}@${host}`, group, host, port, user });
  }
  return out;
}

/** Parse this plugin's own JSON export. */
export function parseJsonSessions(text) {
  const data = JSON.parse(String(text || "{}"));
  const list = Array.isArray(data) ? data : Array.isArray(data.sessions) ? data.sessions : [];
  return list
    .filter((s) => s && s.host && s.user)
    .map((s) => ({
      name: String(s.name || `${s.user}@${s.host}`),
      group: String(s.group || "导入"),
      host: String(s.host),
      port: Number(s.port) || 22,
      user: String(s.user),
      auth: s.auth && s.auth.kind === "key" ? { kind: "key", keyPath: String(s.auth.keyPath || "") } : { kind: "password", credentialEnv: String((s.auth && s.auth.credentialEnv) || "") },
      proxyJumpName: s.proxyJumpName ? String(s.proxyJumpName) : "",
    }));
}

/** Export sessions as this plugin's JSON (no secrets; jump hosts by name). */
export function exportJson(sessions) {
  const byId = new Map(sessions.map((s) => [s.id, s.name]));
  return JSON.stringify(
    {
      format: "dsh-aixterm-sessions",
      version: 1,
      exportedAt: new Date().toISOString(),
      sessions: sessions.map((s) => ({
        name: s.name,
        group: s.group || "",
        host: s.host,
        port: s.port,
        user: s.user,
        auth: s.auth && s.auth.kind === "key" ? { kind: "key", keyPath: s.auth.keyPath || "" } : { kind: "password", credentialEnv: (s.auth && s.auth.credentialEnv) || "" },
        proxyJumpName: (s.proxyJump && byId.get(s.proxyJump)) || "",
      })),
    },
    null,
    2
  );
}

/** Export sessions in MobaXterm's .mxtsessions shape (passwords excluded). */
export function exportMoba(sessions) {
  const lines = ["[Bookmarks]"];
  for (const s of sessions) {
    if (s.group) lines.push(`SubRep=${s.group}`);
    lines.push(`${s.name}=#109#0%${s.host}%${s.port}%${s.user}%%%22%%0%0%0%%%-1%0%0%0%%1080%%0%0%1%0%0%0%%%${s.group || ""}%`);
  }
  return lines.join("\r\n") + "\r\n";
}

/** Parse a SecureCRT session .ini (Hostname/Port/Username). */
export function parseSecureCRT(text) {
  const out = [];
  let cur = {};
  const flush = () => {
    if (cur.host && cur.user) {
      out.push({ name: cur.name || `${cur.user}@${cur.host}`, group: "SecureCRT", host: cur.host, port: cur.port || 22, user: cur.user });
    }
    cur = {};
  };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      flush();
      continue;
    }
    const m = line.match(/^([^=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (key === "hostname" || key === "host") cur.host = value;
    else if (key === "port") cur.port = Number(value) || 22;
    else if (key === "username") cur.user = value;
    else if (key === "sessionname") cur.name = value;
  }
  flush();
  return out;
}

const HOST_KEYS = ["host", "hostname", "address", "ip", "server", "hostName"];
const USER_KEYS = ["username", "user", "user_name", "userName", "login", "account"];
const PORT_KEYS = ["port", "sshPort", "port_ssh", "portNumber"];
const NAME_KEYS = ["name", "label", "title", "sessionName", "alias", "displayName"];

const pick = (obj, keys) => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") return String(obj[k]).trim();
  }
  return "";
};

/**
 * Generic JSON session parser: walks any termius/electerm/finalshell/windterm/
 * nyaterm-style export and collects objects carrying a host and a user.
 */
export function parseGenericJson(text) {
  let data;
  try {
    data = JSON.parse(String(text || ""));
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  const visit = (node, group) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, group);
      return;
    }
    const nextGroup = typeof node.group === "string" ? node.group : typeof node.folder === "string" ? node.folder : group;
    const host = pick(node, HOST_KEYS);
    const user = pick(node, USER_KEYS);
    if (host && user) {
      const port = Number(pick(node, PORT_KEYS)) || 22;
      const key = `${host}:${port}:${user}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          name: pick(node, NAME_KEYS) || `${user}@${host}`,
          group: nextGroup || "导入",
          host,
          port,
          user,
        });
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value, nextGroup);
    }
  };
  visit(data, "");
  return out;
}

/**
 * Detect the format from the filename and content, then parse.
 * Covers Xshell, MobaXterm, SecureCRT, WindTerm, FinalShell, Termius,
 * Electerm, NyaTerm and this plugin's own JSON.
 */
export function parseAuto(text, filename) {
  const source = String(text || "");
  const ext = String(filename || "").toLowerCase().split(".").pop();
  if (ext === "xsh") return parseXshell(source);
  if (ext === "mxtsessions") return parseMoba(source);
  if (ext === "ini" || ext === "crt") {
    if (/^hostname=/im.test(source)) return parseSecureCRT(source);
    return parseXshell(source);
  }
  if (/^\[CONNECTION\]/im.test(source)) return parseXshell(source);
  if (/#109#0%/.test(source)) return parseMoba(source);
  if (/^hostname=/im.test(source)) return parseSecureCRT(source);
  if (ext === "json" || /^\s*[\[{]/.test(source)) {
    const own = parseJsonSessions(source);
    if (own.length) return own;
    return parseGenericJson(source);
  }
  return [];
}
