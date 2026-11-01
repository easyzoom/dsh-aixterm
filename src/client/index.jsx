/**
 * dsh-aixterm — client UI (source; bundled to lib/client.js by
 * scripts/build-client.mjs).
 *
 * A sidebar page shared by the human and the agent:
 *   - connection list (saved SSH sessions + local shells)
 *   - real xterm.js terminals (SSE down, POST input up)
 *   - an SFTP file browser with drag-and-drop upload / download
 *
 * React comes from the web shell (external); @xterm/* is bundled here.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import xtermCss from "@xterm/xterm/css/xterm.css";

const PREFIX = "/dsh-aixterm";
const CSS_ID = "dsh-aixterm-xterm-css";

if (typeof document !== "undefined" && !document.getElementById(CSS_ID)) {
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = xtermCss;
  document.head.appendChild(style);
}

const C = {
  bg: "#0d1117",
  panel: "#141a23",
  panel2: "#1b2330",
  hover: "#1f2937",
  border: "#283243",
  text: "#c9d1d9",
  dim: "#8b949e",
  accent: "#58a6ff",
  accentBg: "#1f6feb",
  danger: "#f85149",
  ok: "#3fb950",
  warn: "#d29922",
};

const mono = '"Cascadia Code", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const XTERM_THEME = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  cursorAccent: "#0d1117",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

const EMPTY_FORM = { name: "", host: "", port: "22", user: "", authKind: "password", password: "", keyPath: "", group: "" };

const S = {
  btn: {
    border: `1px solid ${C.border}`,
    background: C.panel2,
    color: C.text,
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  btnPrimary: {
    border: `1px solid ${C.accentBg}`,
    background: C.accentBg,
    color: "#fff",
    borderRadius: 6,
    padding: "5px 12px",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 600,
  },
  input: {
    border: `1px solid ${C.border}`,
    background: C.bg,
    color: C.text,
    borderRadius: 6,
    padding: "6px 9px",
    fontSize: 13,
    width: "100%",
    boxSizing: "border-box",
    outline: "none",
  },
  muted: { color: C.dim, fontSize: 12 },
};

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function postJson(path, body) {
  return fetch(PREFIX + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());
}

function fmtSize(n) {
  if (n == null || isNaN(n)) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}

function joinPath(base, name) {
  if (!base || base === ".") return name;
  if (base.endsWith("/")) return base + name;
  return base + "/" + name;
}

function parentPath(p) {
  if (!p || p === "." || p === "/") return ".";
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  if (i <= 0) return t.startsWith("/") ? "/" : ".";
  return t.slice(0, i) || "/";
}

/* ---------------------------------------------------------------- terminal */

function TerminalPane({ terminalId, active }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: mono,
      lineHeight: 1.15,
      scrollback: 8000,
      convertEol: true,
      theme: XTERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    try {
      term.loadAddon(new WebLinksAddon());
    } catch {
      /* optional */
    }
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const doFit = () => {
      try {
        fit.fit();
      } catch {
        /* hidden or zero-size */
      }
    };
    const raf = requestAnimationFrame(doFit);

    const es = new EventSource(PREFIX + "/term/stream?terminalId=" + encodeURIComponent(terminalId));
    es.onmessage = (e) => {
      try {
        term.write(b64ToBytes(e.data));
      } catch {
        /* bad chunk */
      }
    };

    const dataDisposable = term.onData((data) => {
      postJson("/term/input", { terminalId, data }).catch(() => {});
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      postJson("/term/resize", { terminalId, cols, rows }).catch(() => {});
    });

    let ro = null;
    try {
      ro = new ResizeObserver(doFit);
      ro.observe(host);
    } catch {
      /* no ResizeObserver */
    }

    return () => {
      cancelAnimationFrame(raf);
      try {
        ro && ro.disconnect();
      } catch {
        /* ignore */
      }
      try {
        es.close();
      } catch {
        /* ignore */
      }
      try {
        dataDisposable.dispose();
      } catch {
        /* ignore */
      }
      try {
        resizeDisposable.dispose();
      } catch {
        /* ignore */
      }
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId]);

  useEffect(() => {
    if (!active) return undefined;
    const t = setTimeout(() => {
      try {
        fitRef.current && fitRef.current.fit();
        termRef.current && termRef.current.focus();
      } catch {
        /* ignore */
      }
    }, 40);
    return () => clearTimeout(t);
  }, [active]);

  return (
    <div
      ref={hostRef}
      style={{
        display: active ? "block" : "none",
        flex: 1,
        minHeight: 0,
        padding: "6px 8px",
        overflow: "hidden",
      }}
    />
  );
}

/* ------------------------------------------------------------------- sftp */

function SftpPanel({ sessionId }) {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);

  const list = useCallback(
    async (p) => {
      if (!sessionId) return;
      setBusy(true);
      try {
        const d = await postJson("/sftp", { sessionId, op: "list", path: p || "." });
        if (d && d.ok) {
          setEntries(d.entries || []);
          if (typeof d.path === "string" && d.path) setPath(d.path);
          setMsg(null);
        } else {
          setMsg({ kind: "err", text: (d && d.error) || "列目录失败" });
        }
      } catch (e) {
        setMsg({ kind: "err", text: String(e) });
      } finally {
        setBusy(false);
      }
    },
    [sessionId]
  );

  useEffect(() => {
    setPath(".");
    setEntries(null);
    list(".");
  }, [sessionId, list]);

  async function uploadFiles(files) {
    if (!sessionId || !files || !files.length) return;
    setBusy(true);
    setMsg({ kind: "info", text: "上传中…" });
    try {
      let ok = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const buf = new Uint8Array(await f.arrayBuffer());
        const dest = joinPath(path, f.name);
        const d = await postJson("/sftp/upload", { sessionId, path: dest, data: bytesToB64(buf) });
        if (!d || !d.ok) throw new Error((d && d.error) || "上传失败：" + f.name);
        ok++;
      }
      setMsg({ kind: "ok", text: "已上传 " + ok + " 个文件" });
      await list(path);
    } catch (e) {
      setMsg({ kind: "err", text: String(e && e.message ? e.message : e) });
    } finally {
      setBusy(false);
    }
  }

  function download(entry) {
    const full = joinPath(path, entry.name);
    const url = PREFIX + "/sftp/download?sessionId=" + encodeURIComponent(sessionId) + "&path=" + encodeURIComponent(full);
    const a = document.createElement("a");
    a.href = url;
    a.download = entry.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function enter(entry) {
    const next = joinPath(path, entry.name);
    setPath(next);
    list(next);
  }

  function up() {
    const next = parentPath(path);
    setPath(next);
    list(next);
  }

  const msgColor = msg?.kind === "err" ? C.danger : msg?.kind === "ok" ? C.ok : C.dim;

  return (
    <aside
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        uploadFiles(e.dataTransfer.files);
      }}
      style={{
        width: 320,
        flex: "0 0 320px",
        borderLeft: `1px solid ${C.border}`,
        background: C.panel,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        outline: drag ? `2px dashed ${C.accent}` : "none",
        outlineOffset: -6,
      }}
    >
      <div style={{ padding: "10px 12px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>文件 (SFTP)</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={S.btn} title="上级目录" onClick={up} disabled={busy}>↑</button>
          <button style={S.btn} title="刷新" onClick={() => list(path)} disabled={busy}>⟳</button>
          <button style={S.btn} title="上传文件" onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>上传</button>
        </div>
      </div>

      <div style={{ padding: "8px 10px" }}>
        <input
          style={S.input}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") list(path);
          }}
          placeholder="远程目录，例如 /home/user"
        />
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "0 8px 8px" }}>
        {entries === null ? (
          <div style={{ ...S.muted, padding: "8px 4px" }}>{busy ? "读取中…" : "—"}</div>
        ) : entries.length === 0 ? (
          <div style={{ ...S.muted, padding: "8px 4px" }}>空目录</div>
        ) : (
          entries.map((it) => (
            <div
              key={it.name}
              onClick={() => (it.isDirectory ? enter(it) : null)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 6px",
                borderRadius: 5,
                cursor: it.isDirectory ? "pointer" : "default",
                fontSize: 12.5,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.hover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span>{it.isDirectory ? "📁" : "📄"}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={it.name}>
                {it.name}
              </span>
              {it.isDirectory ? null : <span style={S.muted}>{fmtSize(it.size)}</span>}
              {it.isDirectory ? null : (
                <button
                  style={{ ...S.btn, padding: "1px 7px" }}
                  title="下载"
                  onClick={(e) => {
                    e.stopPropagation();
                    download(it);
                  }}
                >
                  ↓
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {msg ? <div style={{ padding: "6px 12px", fontSize: 12, color: msgColor, borderTop: `1px solid ${C.border}` }}>{msg.text}</div> : null}
      <div style={{ padding: "8px 12px", fontSize: 11, color: C.dim, borderTop: `1px solid ${C.border}` }}>拖入文件即可上传</div>
      <input
        ref={fileRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          uploadFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </aside>
  );
}

/* --------------------------------------------------------------------- app */

function AixtermApp() {
  const [sessions, setSessions] = useState([]);
  const [tabs, setTabs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch(PREFIX + "/sessions");
      const d = await r.json();
      if (d && d.ok) setSessions(d.sessions || []);
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const activeTab = tabs.find((t) => t.id === activeId) || null;

  async function openTerminal(session) {
    // Focus an existing tab for the same session instead of opening a duplicate.
    if (session) {
      const existing = tabs.find((t) => t.sessionId === session.id);
      if (existing) {
        setActiveId(existing.id);
        return;
      }
    }
    setBusy(true);
    setMsg(null);
    try {
      const body = session ? { sessionId: session.id, cols: 120, rows: 30 } : { cols: 120, rows: 30 };
      const d = await postJson("/term/open", body);
      if (!d || !d.ok) {
        setMsg({ kind: "err", text: (d && d.error) || "打开终端失败" });
        return;
      }
      const tab = {
        id: d.terminalId,
        sessionId: session ? session.id : null,
        kind: d.kind || (session ? "ssh" : "local"),
        title: session ? session.name : "本地终端",
      };
      setTabs((ts) => [...ts, tab]);
      setActiveId(tab.id);
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  function closeTab(id) {
    postJson("/term/close", { terminalId: id }).catch(() => {});
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (activeId === id) {
      setActiveId(next.length ? next[Math.min(idx, next.length - 1)].id : null);
    }
  }

  async function removeSession(id) {
    try {
      await fetch(PREFIX + "/sessions?id=" + encodeURIComponent(id), { method: "DELETE" });
      // Close any terminals attached to the removed session.
      for (const t of tabs) {
        if (t.sessionId === id) closeTab(t.id);
      }
      loadSessions();
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    }
  }

  async function testSession(id) {
    setMsg(null);
    try {
      const d = await postJson("/test", { sessionId: id });
      setMsg(d && d.ok ? { kind: "ok", text: "连接正常" } : { kind: "err", text: (d && d.error) || "连接失败" });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    }
  }

  async function createSession() {
    if (!form.host || !form.user) {
      setMsg({ kind: "err", text: "主机和用户名必填" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const body = {
        name: form.name || form.host,
        group: form.group || "默认",
        host: form.host,
        port: Number(form.port) || 22,
        user: form.user,
        auth: { kind: form.authKind },
      };
      if (form.authKind === "key") body.auth.keyPath = form.keyPath;
      else if (form.authKind === "password") body.password = form.password;
      const d = await postJson("/sessions", body);
      if (d && d.ok) {
        setShowCreate(false);
        setForm(EMPTY_FORM);
        await loadSessions();
        if (d.session) openTerminal(d.session);
      } else {
        setMsg({ kind: "err", text: (d && d.error) || "保存失败" });
      }
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  function patch(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // Group sessions by their group field.
  const groups = [];
  for (const s of sessions) {
    const g = s.group || "默认";
    let bucket = groups.find((x) => x.name === g);
    if (!bucket) {
      bucket = { name: g, items: [] };
      groups.push(bucket);
    }
    bucket.items.push(s);
  }

  const msgColor = msg?.kind === "err" ? C.danger : msg?.kind === "ok" ? C.ok : C.dim;

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        minHeight: 520,
        background: C.bg,
        color: C.text,
        borderRadius: 10,
        border: `1px solid ${C.border}`,
        overflow: "hidden",
        position: "relative",
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      }}
    >
      {/* left: connections */}
      <aside style={{ width: 250, flex: "0 0 250px", borderRight: `1px solid ${C.border}`, background: C.panel, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "10px 12px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: 0.2 }}>连接</span>
          <button style={S.btnPrimary} onClick={() => setShowCreate(true)}>+ 新建</button>
        </div>

        <div style={{ padding: "8px 10px" }}>
          <button style={{ ...S.btn, width: "100%", textAlign: "left", padding: "7px 10px" }} onClick={() => openTerminal(null)} disabled={busy}>
            <span style={{ color: C.accent, marginRight: 6 }}>▸</span> 本地终端
          </button>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "0 8px 8px" }}>
          {groups.length === 0 ? (
            <div style={{ ...S.muted, padding: "10px 6px", lineHeight: 1.6 }}>
              还没有连接。点「新建」添加 SSH 会话，或直接打开本地终端。
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.name} style={{ marginBottom: 8 }}>
                <div style={{ ...S.muted, padding: "6px 6px 4px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>{g.name}</div>
                {g.items.map((s) => {
                  const isActive = activeTab && activeTab.sessionId === s.id;
                  return (
                    <div
                      key={s.id}
                      onClick={() => openTerminal(s)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "7px 8px",
                        borderRadius: 6,
                        cursor: "pointer",
                        background: isActive ? C.panel2 : "transparent",
                        border: `1px solid ${isActive ? C.border : "transparent"}`,
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) e.currentTarget.style.background = C.hover;
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span style={{ color: isActive ? C.ok : C.dim, fontSize: 11 }}>●</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                        <div style={{ fontSize: 11, color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {s.user}@{s.host}:{s.port}
                        </div>
                      </div>
                      <button
                        style={{ ...S.btn, padding: "1px 6px", fontSize: 11 }}
                        title="测试连接"
                        onClick={(e) => {
                          e.stopPropagation();
                          testSession(s.id);
                        }}
                      >
                        ⟳
                      </button>
                      <button
                        style={{ ...S.btn, padding: "1px 6px", fontSize: 11, color: C.danger }}
                        title="删除会话"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeSession(s.id);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {msg ? <div style={{ padding: "8px 12px", fontSize: 12, color: msgColor, borderTop: `1px solid ${C.border}` }}>{msg.text}</div> : null}
      </aside>

      {/* center: tabs + terminals */}
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "stretch", borderBottom: `1px solid ${C.border}`, background: C.panel, minHeight: 38, overflowX: "auto" }}>
          {tabs.length === 0 ? (
            <div style={{ ...S.muted, padding: "0 12px", display: "flex", alignItems: "center" }}>未打开终端</div>
          ) : (
            tabs.map((t) => (
              <div
                key={t.id}
                onClick={() => setActiveId(t.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "0 10px",
                  cursor: "pointer",
                  borderRight: `1px solid ${C.border}`,
                  background: t.id === activeId ? C.bg : "transparent",
                  borderBottom: t.id === activeId ? `2px solid ${C.accent}` : "2px solid transparent",
                  fontSize: 12.5,
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ color: t.kind === "ssh" ? C.accent : C.ok, fontSize: 11 }}>{t.kind === "ssh" ? "🖥" : "▸"}</span>
                <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                  style={{ border: "none", background: "transparent", color: C.dim, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}
                  title="关闭"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex" }}>
          {tabs.length === 0 ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: C.dim }}>
              <div style={{ fontSize: 40, opacity: 0.5 }}>▚</div>
              <div style={{ fontSize: 13 }}>选择左侧会话，或打开一个本地终端</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={S.btnPrimary} onClick={() => openTerminal(null)} disabled={busy}>打开本地终端</button>
                <button style={S.btn} onClick={() => setShowCreate(true)}>新建 SSH 会话</button>
              </div>
            </div>
          ) : (
            tabs.map((t) => <TerminalPane key={t.id} terminalId={t.id} active={t.id === activeId} />)
          )}
        </div>
      </main>

      {/* right: sftp (ssh sessions only) */}
      {activeTab && activeTab.kind === "ssh" && activeTab.sessionId ? <SftpPanel key={activeTab.sessionId} sessionId={activeTab.sessionId} /> : null}

      {/* create modal */}
      {showCreate ? (
        <div
          onClick={() => setShowCreate(false)}
          style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 520, maxWidth: "92%", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>新建 SSH 会话</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={S.muted}>名称</span>
                <input style={S.input} value={form.name} onChange={(e) => patch("name", e.target.value)} placeholder="例如 测试机" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={S.muted}>分组</span>
                <input style={S.input} value={form.group} onChange={(e) => patch("group", e.target.value)} placeholder="默认" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={S.muted}>主机</span>
                <input style={S.input} value={form.host} onChange={(e) => patch("host", e.target.value)} placeholder="192.168.1.10" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={S.muted}>端口</span>
                <input style={S.input} value={form.port} onChange={(e) => patch("port", e.target.value)} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={S.muted}>用户名</span>
                <input style={S.input} value={form.user} onChange={(e) => patch("user", e.target.value)} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={S.muted}>认证方式</span>
                <select style={S.input} value={form.authKind} onChange={(e) => patch("authKind", e.target.value)}>
                  <option value="password">密码</option>
                  <option value="key">私钥文件</option>
                  <option value="agent">ssh-agent</option>
                </select>
              </label>
              {form.authKind === "password" ? (
                <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / span 2" }}>
                  <span style={S.muted}>密码</span>
                  <input style={S.input} type="password" value={form.password} onChange={(e) => patch("password", e.target.value)} />
                </label>
              ) : form.authKind === "key" ? (
                <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / span 2" }}>
                  <span style={S.muted}>私钥路径（本机绝对路径）</span>
                  <input style={S.input} value={form.keyPath} onChange={(e) => patch("keyPath", e.target.value)} placeholder="C:\Users\you\.ssh\id_ed25519" />
                </label>
              ) : (
                <div style={{ ...S.muted, gridColumn: "1 / span 2" }}>使用 ssh-agent（SSH_AUTH_SOCK）</div>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button style={S.btn} onClick={() => setShowCreate(false)}>取消</button>
              <button style={S.btnPrimary} onClick={createSession} disabled={busy}>{busy ? "保存中…" : "保存并打开"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ registration */

function AixtermIcon(props) {
  const size = (props && props.size) || 16;
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-dsh-panel-entry="dsh-aixterm">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6l2 2-2 2" />
      <path d="M8.5 10h3" />
    </svg>
  );
}

export function apply(ctx) {
  try {
    const slots = ctx && ctx.slots;
    if (!slots || typeof slots.register !== "function") return;

    // Full app on the sidebar page: a row under Plugins + its center page.
    const disposers = [];
    if (typeof slots.inject === "function") {
      disposers.push(
        slots.inject("sidebar.panellist", () => {
          try {
            return slots.register({ name: "sidebar.panellist", id: "dsh-aixterm", order: 30, label: () => "SSH 会话" }, AixtermIcon);
          } catch (e) {
            console.warn("[dsh-aixterm] sidebar row failed", e);
            return undefined;
          }
        })
      );
      disposers.push(
        slots.inject("main", () => {
          try {
            return slots.register({ name: "main", key: "dsh-aixterm" }, AixtermApp);
          } catch (e) {
            console.warn("[dsh-aixterm] main page failed", e);
            return undefined;
          }
        })
      );
    }

    if (typeof ctx.effect === "function") {
      ctx.effect(
        () => () => {
          for (const d of disposers) {
            try {
              d && d();
            } catch {
              /* already disposed */
            }
          }
        },
        "dsh-aixterm: sidebar page"
      );
    }
  } catch (e) {
    console.warn("[dsh-aixterm] client registration failed", e);
  }
}

export const inject = ["slots"];
