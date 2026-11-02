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
import { SearchAddon } from "@xterm/addon-search";
import Zmodem from "zmodem.js/src/zmodem_browser.js";
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

const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#24292f",
  cursor: "#0969da",
  cursorAccent: "#ffffff",
  selectionBackground: "#b6d7ff",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#7d4e00",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

const EMPTY_FORM = { kind: "ssh", name: "", host: "", port: "22", user: "", authKind: "password", password: "", keyPath: "", keyId: "", group: "", proxyJump: "", credentialEnv: "", x11: false, serialPath: "", baudRate: "115200", dataBits: "8", stopBits: "1", parity: "none" };

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

function TerminalPane({ terminalId, active, onCwd, onInput, prefs }) {
  const hostRef = useRef(null);
  const onCwdRef = useRef(onCwd);
  const onInputRef = useRef(onInput);
  const searchRef = useRef(null);
  const zmodemSendRef = useRef(null);
  const zfileRef = useRef(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [menu, setMenu] = useState(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    onCwdRef.current = onCwd;
  }, [onCwd]);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    const hide = () => setMenu(null);
    document.addEventListener("click", hide);
    return () => document.removeEventListener("click", hide);
  }, []);

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

    try {
      const search = new SearchAddon();
      term.loadAddon(search);
      searchRef.current = search;
    } catch {
      /* search addon unavailable */
    }

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && !e.shiftKey && String(e.key).toLowerCase() === "f") {
        setFindOpen(true);
        return false;
      }
      return true;
    });

    // OSC 7 (file://host/path) is emitted by the shell after each prompt; use it
    // to follow the terminal directory in the SFTP panel.
    let oscDisposable = null;
    try {
      oscDisposable = term.parser.registerOscHandler(7, (data) => {
        try {
          const text = String(data || "");
          const scheme = text.indexOf("//");
          const slash = scheme >= 0 ? text.indexOf("/", scheme + 2) : -1;
          if (slash >= 0 && onCwdRef.current) onCwdRef.current(decodeURIComponent(text.slice(slash)));
        } catch {
          /* malformed OSC 7 */
        }
        return true;
      });
    } catch {
      /* parser handler unsupported */
    }

    const doFit = () => {
      try {
        fit.fit();
      } catch {
        /* hidden or zero-size */
      }
    };
    const raf = requestAnimationFrame(doFit);

    // ZMODEM: detect sz/rz transfers on the raw byte stream. Remote `sz`
    // downloads are saved to disk automatically; remote `rz` asks for local
    // files through a hidden picker.
    let zsentry = null;
    try {
      zsentry = new Zmodem.Sentry({
        to_terminal: (octets) => {
          try {
            term.write(octets);
          } catch {
            /* terminal gone */
          }
        },
        sender: (octets) => {
          postJson("/term/input", { terminalId, dataB64: bytesToB64(octets) }).catch(() => {});
        },
        on_detect: (detection) => {
          let session;
          try {
            session = detection.confirm();
          } catch {
            return;
          }
          if (session.type === "send") {
            zmodemSendRef.current = session;
            if (zfileRef.current) zfileRef.current.click();
          } else {
            session.on("offer", (xfer) => {
              xfer
                .accept()
                .then(() => {
                  try {
                    Zmodem.Browser.save_to_disk(xfer.get_payloads(), xfer.get_details().name);
                  } catch {
                    /* save failed */
                  }
                })
                .catch(() => {});
            });
          }
        },
        on_retract: () => {
          zmodemSendRef.current = null;
        },
      });
    } catch {
      /* zmodem unavailable */
    }

    const es = new EventSource(PREFIX + "/term/stream?terminalId=" + encodeURIComponent(terminalId));
    es.onmessage = (e) => {
      try {
        const bytes = b64ToBytes(e.data);
        if (zsentry && zsentry.consume(bytes)) return;
        term.write(bytes);
      } catch {
        /* bad chunk */
      }
    };

    const dataDisposable = term.onData((data) => {
      if (onInputRef.current) onInputRef.current(data);
      else postJson("/term/input", { terminalId, data }).catch(() => {});
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
        oscDisposable && oscDisposable.dispose();
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
    const term = termRef.current;
    if (!term) return;
    try {
      term.options.fontSize = (prefs && prefs.fontSize) || 13;
      term.options.theme = prefs && prefs.theme === "light" ? LIGHT_THEME : XTERM_THEME;
      fitRef.current && fitRef.current.fit();
    } catch {
      /* options not ready */
    }
  }, [prefs && prefs.fontSize, prefs && prefs.theme]);

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

  function copySelection() {
    try {
      const sel = termRef.current && termRef.current.getSelection();
      if (sel) navigator.clipboard && navigator.clipboard.writeText(sel).catch(() => {});
    } catch {
      /* clipboard denied */
    }
  }

  async function pasteClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) postJson("/term/input", { terminalId, data: text }).catch(() => {});
    } catch {
      /* clipboard denied */
    }
  }

  const menuItems = [
    ["复制", copySelection],
    ["粘贴", pasteClipboard],
    ["全选", () => termRef.current && termRef.current.selectAll()],
    ["清屏", () => termRef.current && termRef.current.clear()],
    ["查找", () => setFindOpen(true)],
  ];

  return (
    <div style={{ position: "relative", display: active ? "block" : "none", flex: 1, minHeight: 0 }}>
      <div
        ref={hostRef}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{ position: "absolute", inset: 0, padding: "6px 8px", overflow: "hidden" }}
      />
      {findOpen ? (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 16,
            zIndex: 6,
            display: "flex",
            gap: 4,
            alignItems: "center",
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,.45)",
          }}
        >
          <input
            autoFocus
            value={findText}
            onChange={(e) => {
              setFindText(e.target.value);
              try {
                searchRef.current && searchRef.current.findNext(e.target.value, { incremental: true });
              } catch {
                /* no search */
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                try {
                  if (e.shiftKey) searchRef.current && searchRef.current.findPrevious(findText);
                  else searchRef.current && searchRef.current.findNext(findText);
                } catch {
                  /* no search */
                }
              }
              if (e.key === "Escape") setFindOpen(false);
            }}
            placeholder="查找…"
            style={{ ...S.input, width: 190 }}
          />
          <button style={{ ...S.btn, padding: "1px 7px" }} title="上一个" onClick={() => searchRef.current && searchRef.current.findPrevious(findText)}>↑</button>
          <button style={{ ...S.btn, padding: "1px 7px" }} title="下一个" onClick={() => searchRef.current && searchRef.current.findNext(findText)}>↓</button>
          <button style={{ ...S.btn, padding: "1px 7px" }} title="关闭" onClick={() => setFindOpen(false)}>✕</button>
        </div>
      ) : null}
      <input
        ref={zfileRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          const session = zmodemSendRef.current;
          if (session && files.length) {
            try {
              Zmodem.Browser.send_files(session, files, {})
                .catch(() => {})
                .finally(() => {
                  zmodemSendRef.current = null;
                });
            } catch {
              zmodemSendRef.current = null;
            }
          }
          e.target.value = "";
        }}
      />
      {menu ? (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            left: menu.x,
            top: menu.y,
            zIndex: 60,
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: 4,
            minWidth: 130,
            boxShadow: "0 10px 30px rgba(0,0,0,.55)",
          }}
        >
          {menuItems.map(([label, fn]) => (
            <div
              key={label}
              onClick={() => {
                setMenu(null);
                fn();
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.hover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{ padding: "5px 10px", fontSize: 12, cursor: "pointer", borderRadius: 4 }}
            >
              {label}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- sftp */

function AiPanel({ sessionId, terminalId, cwd, onExecute, onClose }) {
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function ask(text) {
    const q = String(text || prompt || "").trim();
    if (!q) return;
    setBusy(true);
    setErr(null);
    setAnswer("");
    try {
      const d = await postJson("/ai/ask", { sessionId, terminalId, cwd, prompt: q });
      if (d && d.ok) setAnswer(d.answer || "");
      else setErr((d && d.error) || "AI 调用失败");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Split the answer into text and fenced code blocks; code blocks get a run button.
  const parts = [];
  {
    const re = /```([A-Za-z0-9_-]*)\n([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = re.exec(answer))) {
      if (m.index > last) parts.push({ type: "text", text: answer.slice(last, m.index) });
      parts.push({ type: "code", text: m[2].trim() });
      last = m.index + m[0].length;
    }
    if (last < answer.length) parts.push({ type: "text", text: answer.slice(last) });
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 380,
        background: C.panel,
        borderLeft: `1px solid ${C.border}`,
        display: "flex",
        flexDirection: "column",
        zIndex: 8,
        boxShadow: "-8px 0 24px rgba(0,0,0,.35)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>AI 助手</span>
        <button style={{ ...S.btn, padding: "1px 8px", fontSize: 11 }} onClick={onClose}>✕</button>
      </div>
      <div style={{ display: "flex", gap: 6, padding: "8px 10px", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }}>
        <button style={{ ...S.btn, fontSize: 11 }} onClick={() => ask("解释终端里最近输出中的错误，并给出修复建议")} disabled={busy}>
          诊断错误
        </button>
        <button style={{ ...S.btn, fontSize: 11 }} onClick={() => ask("根据当前目录和最近命令，建议下一步可以执行的命令")} disabled={busy}>
          建议下一步
        </button>
        <button style={{ ...S.btn, fontSize: 11 }} onClick={() => ask("总结最近这段终端输出和命令做了什么")} disabled={busy}>
          总结进展
        </button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "10px 12px", fontSize: 12.5, lineHeight: 1.6 }}>
        {!answer && !busy && !err ? <div style={S.muted}>向 AI 提问，或使用上面的快捷操作。它会看到当前会话、目录、最近命令和终端输出。</div> : null}
        {busy ? <div style={S.muted}>思考中…</div> : null}
        {err ? <div style={{ color: C.danger }}>{err}</div> : null}
        {parts.map((part, i) =>
          part.type === "code" ? (
            <div key={i} style={{ margin: "8px 0", border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden" }}>
              <pre style={{ margin: 0, padding: 8, background: C.bg, whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11.5 }}>{part.text}</pre>
              <div style={{ display: "flex", justifyContent: "flex-end", padding: 4, borderTop: `1px solid ${C.border}` }}>
                <button
                  style={{ ...S.btnPrimary, padding: "1px 8px", fontSize: 11 }}
                  onClick={() => {
                    if (window.confirm("在终端执行这段命令？\n\n" + part.text)) onExecute(part.text);
                  }}
                >
                  执行
                </button>
              </div>
            </div>
          ) : (
            <div key={i} style={{ whiteSpace: "pre-wrap", marginBottom: 6 }}>{part.text}</div>
          )
        )}
      </div>
      <div style={{ display: "flex", gap: 6, padding: 10, borderTop: `1px solid ${C.border}` }}>
        <input
          style={{ ...S.input, flex: 1 }}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) ask();
          }}
          placeholder="问 AI，例如：这个报错怎么解决？"
          disabled={busy}
        />
        <button style={S.btnPrimary} onClick={() => ask()} disabled={busy}>发送</button>
      </div>
    </div>
  );
}

function MonitorPanel({ sessionId }) {
  const [m, setM] = useState(null);
  const [err, setErr] = useState(null);
  const prevNet = useRef(null);

  useEffect(() => {
    if (!sessionId) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(PREFIX + "/monitor?sessionId=" + encodeURIComponent(sessionId));
        const d = await r.json();
        if (!alive) return;
        if (d && d.ok) {
          setM(d.monitor);
          setErr(null);
        } else {
          setErr((d && d.error) || "读取失败");
        }
      } catch (e) {
        if (alive) setErr(String(e));
      }
    };
    tick();
    const timer = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionId]);

  const bar = (pct, color) => (
    <div style={{ height: 4, background: C.border, borderRadius: 2, overflow: "hidden", marginTop: 3 }}>
      <div style={{ width: Math.max(0, Math.min(100, pct || 0)) + "%", height: "100%", background: color }} />
    </div>
  );
  const pctText = (v) => (v === null || v === undefined ? "—" : Math.round(v) + "%");
  const gb = (kb) => (kb ? (kb / 1024 / 1024).toFixed(1) + "G" : "—");

  // Network rate from consecutive samples.
  let rxRate = null;
  let txRate = null;
  const nic = m && m.net && m.net[0];
  if (nic) {
    const now = Date.now();
    const prev = prevNet.current;
    if (prev && prev.iface === nic.iface && now > prev.ts) {
      const dt = (now - prev.ts) / 1000;
      rxRate = Math.max(0, (nic.rxBytes - prev.rxBytes) / dt);
      txRate = Math.max(0, (nic.txBytes - prev.txBytes) / dt);
    }
    prevNet.current = { iface: nic.iface, rxBytes: nic.rxBytes, txBytes: nic.txBytes, ts: now };
  }
  const fmtRate = (v) => {
    if (v === null) return "—";
    if (v > 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + "M/s";
    if (v > 1024) return (v / 1024).toFixed(1) + "K/s";
    return Math.round(v) + "B/s";
  };

  const cpu = m && m.cpu ? m.cpu.usage : null;
  const mem = m && m.mem ? m.mem.percent : null;
  const disk = m && m.disk ? m.disk.usePercent : null;

  return (
    <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, flex: "0 0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.dim, marginBottom: 5 }}>
        <span>资源监控</span>
        <span>{err ? err : m ? "5s 刷新" : "读取中…"}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, fontSize: 11.5 }}>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={S.muted}>CPU</span>
            <span>{pctText(cpu)}</span>
          </div>
          {bar(cpu, C.accent)}
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={S.muted}>内存</span>
            <span>{pctText(mem)}</span>
          </div>
          {bar(mem, C.ok)}
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={S.muted}>磁盘</span>
            <span>{pctText(disk)}</span>
          </div>
          {bar(disk, disk !== null && disk > 90 ? C.danger : "#d0a24a")}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.dim, marginTop: 6 }}>
        <span>负载 {m && m.load ? `${m.load.one.toFixed(2)} ${m.load.five.toFixed(2)} ${m.load.fifteen.toFixed(2)}` : "—"}</span>
        <span>↓{fmtRate(rxRate)} ↑{fmtRate(txRate)}</span>
      </div>
    </div>
  );
}

function SftpPanel({ sessionId, followPath }) {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [drag, setDrag] = useState(false);
  const [edit, setEdit] = useState(null); // { path, name, text } while editing a remote text file
  const [follow, setFollow] = useState(true);
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

  // Follow the terminal's cwd (OSC 7) when the toggle is on.
  useEffect(() => {
    if (!follow || !followPath) return;
    if (followPath === path) return;
    setPath(followPath);
    list(followPath);
  }, [follow, followPath, path, list]);

  async function sftpOp(op, extra) {
    const d = await postJson("/sftp", { sessionId, op, ...extra });
    if (!d || !d.ok) throw new Error((d && d.error) || op + " 失败");
    return d;
  }

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

  async function newDir() {
    const name = window.prompt("新建目录名");
    if (!name) return;
    try {
      setBusy(true);
      await sftpOp("mkdir", { path: joinPath(path, name) });
      setMsg({ kind: "ok", text: "已创建 " + name });
      await list(path);
    } catch (e) {
      setMsg({ kind: "err", text: String(e.message || e) });
    } finally {
      setBusy(false);
    }
  }

  async function renameEntry(entry) {
    const name = window.prompt("重命名为", entry.name);
    if (!name || name === entry.name) return;
    try {
      setBusy(true);
      await sftpOp("rename", { from: joinPath(path, entry.name), to: joinPath(path, name) });
      setMsg({ kind: "ok", text: "已重命名" });
      await list(path);
    } catch (e) {
      setMsg({ kind: "err", text: String(e.message || e) });
    } finally {
      setBusy(false);
    }
  }

  async function deleteEntry(entry) {
    if (!window.confirm("删除 " + entry.name + "？")) return;
    try {
      setBusy(true);
      await sftpOp("delete", { path: joinPath(path, entry.name) });
      setMsg({ kind: "ok", text: "已删除 " + entry.name });
      await list(path);
    } catch (e) {
      setMsg({ kind: "err", text: String(e.message || e) });
    } finally {
      setBusy(false);
    }
  }

  async function chmodEntry(entry) {
    const mode = window.prompt("权限（八进制，如 755）", "755");
    if (!mode) return;
    try {
      setBusy(true);
      await sftpOp("chmod", { path: joinPath(path, entry.name), mode: mode.trim() });
      setMsg({ kind: "ok", text: "权限已设为 " + mode });
      await list(path);
    } catch (e) {
      setMsg({ kind: "err", text: String(e.message || e) });
    } finally {
      setBusy(false);
    }
  }

  async function openEditor(entry) {
    if (entry.isDirectory) return;
    const full = joinPath(path, entry.name);
    try {
      setBusy(true);
      const r = await fetch(PREFIX + "/sftp/download?sessionId=" + encodeURIComponent(sessionId) + "&path=" + encodeURIComponent(full));
      if (!r.ok) throw new Error("读取失败");
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > 1024 * 1024) throw new Error("文件超过 1 MB，暂不支持在线编辑");
      const text = new TextDecoder("utf-8").decode(buf);
      if (text.includes("\uFFFD")) throw new Error("二进制文件，无法在线编辑");
      setEdit({ path: full, name: entry.name, text });
    } catch (e) {
      setMsg({ kind: "err", text: String(e.message || e) });
    } finally {
      setBusy(false);
    }
  }

  async function saveEditor() {
    if (!edit) return;
    try {
      setBusy(true);
      const d = await postJson("/sftp/upload", { sessionId, path: edit.path, data: bytesToB64(new TextEncoder().encode(edit.text)) });
      if (!d || !d.ok) throw new Error((d && d.error) || "保存失败");
      setMsg({ kind: "ok", text: "已保存 " + edit.name });
      setEdit(null);
      await list(path);
    } catch (e) {
      setMsg({ kind: "err", text: String(e.message || e) });
    } finally {
      setBusy(false);
    }
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
        width: "100%",
        flex: "1 1 auto",
        borderTop: `1px solid ${C.border}`,
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
          <button style={S.btn} title="新建目录" onClick={newDir} disabled={busy}>＋目录</button>
          <button style={S.btn} title="上传文件" onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>上传</button>
          <label style={{ ...S.muted, display: "flex", alignItems: "center", gap: 3, fontSize: 11, cursor: "pointer" }} title="SFTP 面板跟随终端当前目录">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            跟随
          </label>
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
              onDoubleClick={() => openEditor(it)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
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
                  style={{ ...S.btn, padding: "1px 5px" }}
                  title="下载"
                  onClick={(e) => {
                    e.stopPropagation();
                    download(it);
                  }}
                >
                  ↓
                </button>
              )}
              <button
                style={{ ...S.btn, padding: "1px 5px" }}
                title="重命名"
                onClick={(e) => {
                  e.stopPropagation();
                  renameEntry(it);
                }}
              >
                ✎
              </button>
              <button
                style={{ ...S.btn, padding: "1px 5px" }}
                title="权限"
                onClick={(e) => {
                  e.stopPropagation();
                  chmodEntry(it);
                }}
              >
                ⚙
              </button>
              <button
                style={{ ...S.btn, padding: "1px 5px", color: C.danger }}
                title="删除"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteEntry(it);
                }}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      {msg ? <div style={{ padding: "6px 12px", fontSize: 12, color: msgColor, borderTop: `1px solid ${C.border}` }}>{msg.text}</div> : null}
      <div style={{ padding: "8px 12px", fontSize: 11, color: C.dim, borderTop: `1px solid ${C.border}` }}>拖入文件即可上传 · 双击文件在线编辑</div>
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

      {edit ? (
        <div
          onClick={() => setEdit(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 760, maxWidth: "94%", height: "72vh", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>编辑 {edit.path}</div>
            <textarea
              value={edit.text}
              onChange={(e) => setEdit({ ...edit, text: e.target.value })}
              spellCheck={false}
              style={{ flex: 1, background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, fontFamily: "ui-monospace, monospace", fontSize: 12.5, resize: "none" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
              <button style={S.btn} onClick={() => setEdit(null)}>取消</button>
              <button style={S.btnPrimary} onClick={saveEditor} disabled={busy}>保存</button>
            </div>
          </div>
        </div>
      ) : null}
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
  const [fwdFor, setFwdFor] = useState(null); // session id whose forward panel is open
  const [forwards, setForwards] = useState([]);
  const [fwdForm, setFwdForm] = useState({ kind: "local", bindAddr: "127.0.0.1", bindPort: "18422", dstHost: "", dstPort: "22" });
  const [fwdBusy, setFwdBusy] = useState(false);
  const [cwdByTerminal, setCwdByTerminal] = useState({});
  const [sessionQuery, setSessionQuery] = useState("");
  const [prefs, setPrefs] = useState(() => {
    try {
      return { fontSize: 13, theme: "dark", ...(JSON.parse(localStorage.getItem("aixterm.prefs") || "{}") || {}) };
    } catch {
      return { fontSize: 13, theme: "dark" };
    }
  });
  const [showSettings, setShowSettings] = useState(false);
  const [broadcast, setBroadcast] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [keys, setKeys] = useState([]);
  const [keyForm, setKeyForm] = useState({ name: "", privateKey: "" });
  const [keyMsg, setKeyMsg] = useState(null);
  const [generatedPub, setGeneratedPub] = useState("");
  const [showIO, setShowIO] = useState(false);
  const [ioMsg, setIoMsg] = useState(null);
  const ioFileRef = useRef(null);
  const [serialPorts, setSerialPorts] = useState([]);
  const [showAi, setShowAi] = useState(false);
  const [termConfig, setTermConfig] = useState(null);

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

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch(PREFIX + "/keys");
      const d = await r.json();
      if (d && d.ok) setKeys(d.keys || []);
    } catch (e) {
      setKeyMsg({ kind: "err", text: String(e) });
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(PREFIX + "/config");
        const d = await r.json();
        if (d && d.ok) setTermConfig(d);
      } catch {
        /* config unavailable */
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(PREFIX + "/serial/ports");
        const d = await r.json();
        if (d && d.ok) setSerialPorts(d.ports || []);
      } catch {
        /* serial listing unavailable */
      }
    })();
  }, []);

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

  function updatePrefs(patchObj) {
    const next = { ...prefs, ...patchObj };
    setPrefs(next);
    try {
      localStorage.setItem("aixterm.prefs", JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  }

  function handleInput(sourceId, data) {
    const targets = broadcast ? tabs.map((t) => t.id) : [sourceId];
    for (const id of targets) {
      postJson("/term/input", { terminalId: id, data }).catch(() => {});
    }
  }

  function openKeys() {
    setShowKeys(true);
    setKeyMsg(null);
    setGeneratedPub("");
    setKeyForm({ name: "", privateKey: "" });
    loadKeys();
  }

  async function keyOp(op, extra) {
    const d = await postJson("/keys", { op, ...extra });
    if (!d || !d.ok) throw new Error((d && d.error) || op + " 失败");
    return d;
  }

  async function makeKey() {
    if (!keyForm.name) {
      setKeyMsg({ kind: "err", text: "请填写密钥名称" });
      return;
    }
    try {
      const d = await keyOp("generate", { name: keyForm.name });
      setGeneratedPub(d.key.publicKey || "");
      setKeyMsg({ kind: "ok", text: "已生成密钥，公钥见下方（复制到远端 ~/.ssh/authorized_keys）" });
      setKeyForm((f) => ({ ...f, name: "" }));
      await loadKeys();
    } catch (e) {
      setKeyMsg({ kind: "err", text: String(e.message || e) });
    }
  }

  async function importKeyMaterial() {
    if (!keyForm.name || !keyForm.privateKey.trim()) {
      setKeyMsg({ kind: "err", text: "请填写名称并粘贴私钥" });
      return;
    }
    try {
      await keyOp("import", { name: keyForm.name, privateKey: keyForm.privateKey });
      setKeyMsg({ kind: "ok", text: "已导入密钥" });
      setKeyForm({ name: "", privateKey: "" });
      await loadKeys();
    } catch (e) {
      setKeyMsg({ kind: "err", text: String(e.message || e) });
    }
  }

  async function removeKey(name) {
    if (!window.confirm("删除密钥 " + name + "？")) return;
    try {
      await keyOp("delete", { name });
      await loadKeys();
      setKeyMsg({ kind: "ok", text: "已删除 " + name });
    } catch (e) {
      setKeyMsg({ kind: "err", text: String(e.message || e) });
    }
  }

  function exportSessions(format) {
    const a = document.createElement("a");
    a.href = PREFIX + "/export?format=" + format;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function importSessions(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      const format = ext === "xsh" ? "xsh" : ext === "mxtsessions" ? "moba" : "json";
      const d = await postJson("/import", { format, data: text });
      if (!d || !d.ok) throw new Error((d && d.error) || "导入失败");
      setIoMsg({ kind: "ok", text: `已导入 ${d.created} 个会话${d.skipped ? `，跳过 ${d.skipped} 个重复` : ""}` });
      await loadSessions();
    } catch (e) {
      setIoMsg({ kind: "err", text: String(e.message || e) });
    }
  }

  async function duplicateSession(id) {
    try {
      const d = await postJson("/sessions/duplicate", { id });
      if (d && d.ok) {
        setMsg({ kind: "ok", text: "已复制会话" });
        await loadSessions();
      } else {
        setMsg({ kind: "err", text: (d && d.error) || "复制失败" });
      }
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    }
  }

  function exportLog(id, format) {
    const a = document.createElement("a");
    a.href = PREFIX + "/log/export?sessionId=" + encodeURIComponent(id) + "&format=" + (format || "html");
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function testSession(id) {
    setMsg(null);
    try {
      const d = await postJson("/test", { sessionId: id });
      setMsg(
        d && d.ok
          ? { kind: "ok", text: `连接正常${d.durationMs ? `（${d.durationMs}ms${d.jump ? "，经跳板" : ""}）` : ""}` }
          : { kind: "err", text: (d && d.error) || "连接失败" }
      );
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    }
  }

  async function loadForwards(sessionId) {
    try {
      const r = await fetch(PREFIX + "/forward?sessionId=" + encodeURIComponent(sessionId));
      const d = await r.json();
      if (d && d.ok) setForwards(d.forwards || []);
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    }
  }

  function openForwards(session) {
    setFwdFor(session.id);
    setForwards([]);
    loadForwards(session.id);
  }

  async function createForward() {
    if (!fwdFor) return;
    setFwdBusy(true);
    setMsg(null);
    try {
      const body = {
        sessionId: fwdFor,
        kind: fwdForm.kind,
        bindAddr: fwdForm.bindAddr || "127.0.0.1",
        bindPort: Number(fwdForm.bindPort) || 0,
      };
      if (fwdForm.kind !== "dynamic") {
        body.dstHost = fwdForm.dstHost;
        body.dstPort = Number(fwdForm.dstPort) || 0;
      }
      const d = await postJson("/forward", body);
      if (d && d.ok) {
        setMsg({ kind: "ok", text: "转发已启动" });
        await loadForwards(fwdFor);
      } else {
        setMsg({ kind: "err", text: (d && d.error) || "启动转发失败" });
      }
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setFwdBusy(false);
    }
  }

  async function stopForward(id) {
    try {
      await postJson("/forward/stop", { id });
      if (fwdFor) await loadForwards(fwdFor);
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    }
  }

  async function createSession() {
    if (form.kind === "serial") {
      if (!form.serialPath) {
        setMsg({ kind: "err", text: "串口设备路径必填" });
        return;
      }
    } else if (!form.host || !form.user) {
      setMsg({ kind: "err", text: "主机和用户名必填" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      if (form.kind === "serial") {
        const d = await postJson("/sessions", {
          kind: "serial",
          name: form.name || form.serialPath,
          group: form.group || "默认",
          serial: {
            path: form.serialPath,
            baudRate: Number(form.baudRate) || 115200,
            dataBits: Number(form.dataBits) || 8,
            stopBits: Number(form.stopBits) || 1,
            parity: form.parity,
          },
        });
        if (d && d.ok) {
          setShowCreate(false);
          setForm(EMPTY_FORM);
          await loadSessions();
          if (d.session) openTerminal(d.session);
        } else {
          setMsg({ kind: "err", text: (d && d.error) || "保存失败" });
        }
        return;
      }
      const body = {
        name: form.name || form.host,
        group: form.group || "默认",
        host: form.host,
        port: Number(form.port) || 22,
        user: form.user,
        auth: { kind: form.authKind },
        x11: Boolean(form.x11),
      };
      if (form.authKind === "key") {
        body.auth.keyPath = form.keyPath;
        if (form.keyId) body.auth.keyId = form.keyId;
      }
      else if (form.authKind === "password") {
        body.password = form.password;
        if (form.credentialEnv) body.auth.credentialEnv = form.credentialEnv;
      }
      if (form.proxyJump) body.proxyJump = form.proxyJump;
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

  // Group sessions by their group field (filtered by the search box).
  const groups = [];
  const ql = sessionQuery.trim().toLowerCase();
  for (const s of sessions) {
    if (ql) {
      const hay = `${s.name || ""} ${s.host || ""} ${s.user || ""} ${s.group || ""}`.toLowerCase();
      if (!hay.includes(ql)) continue;
    }
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
          <div style={{ display: "flex", gap: 6 }}>
            <button style={S.btn} title="SSH 密钥管理" onClick={openKeys}>🔑</button>
            <button style={S.btn} title="导入 / 导出会话" onClick={() => setShowIO(true)}>⇅</button>
            <button style={S.btnPrimary} onClick={() => setShowCreate(true)}>+ 新建</button>
          </div>
        </div>

        <div style={{ padding: "8px 10px" }}>
          <button style={{ ...S.btn, width: "100%", textAlign: "left", padding: "7px 10px" }} onClick={() => openTerminal(null)} disabled={busy}>
            <span style={{ color: C.accent, marginRight: 6 }}>▸</span> 本地终端
          </button>
        </div>
        <div style={{ padding: "0 10px 8px" }}>
          <input
            style={S.input}
            value={sessionQuery}
            onChange={(e) => setSessionQuery(e.target.value)}
            placeholder="搜索会话（名称/主机/用户/分组）"
          />
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
                        style={{ ...S.btn, padding: "1px 4px", fontSize: 11 }}
                        title="复制会话"
                        onClick={(e) => {
                          e.stopPropagation();
                          duplicateSession(s.id);
                        }}
                      >
                        ⧉
                      </button>
                      <button
                        style={{ ...S.btn, padding: "1px 4px", fontSize: 11 }}
                        title="导出命令日志"
                        onClick={(e) => {
                          e.stopPropagation();
                          exportLog(s.id, "html");
                        }}
                      >
                        ⤓
                      </button>
                      <button
                        style={{ ...S.btn, padding: "1px 6px", fontSize: 11 }}
                        title="端口转发"
                        onClick={(e) => {
                          e.stopPropagation();
                          openForwards(s);
                        }}
                      >
                        ⇄
                      </button>
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
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, position: "relative" }}>
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
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, padding: "0 10px", flex: "0 0 auto" }}>
            <label style={{ ...S.muted, display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, cursor: "pointer" }} title="把输入同时发送到所有已打开终端">
              <input type="checkbox" checked={broadcast} onChange={(e) => setBroadcast(e.target.checked)} />
              同步输入
            </label>
            <button style={{ ...S.btn, padding: "3px 8px", fontSize: 11.5 }} title="AI 助手（基于当前终端上下文）" onClick={() => setShowAi((v) => !v)}>
              ✦ AI
            </button>
            <button style={{ ...S.btn, padding: "3px 8px", fontSize: 11.5 }} title="终端设置" onClick={() => setShowSettings(true)}>
              ⚙ 设置
            </button>
          </div>
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
            tabs.map((t) => (
              <TerminalPane
                key={t.id}
                terminalId={t.id}
                active={t.id === activeId}
                prefs={prefs}
                onInput={(data) => handleInput(t.id, data)}
                onCwd={(p) => setCwdByTerminal((prev) => (prev[t.id] === p ? prev : { ...prev, [t.id]: p }))}
              />
            ))
          )}
        </div>

        {showAi && activeTab ? (
          <AiPanel
            sessionId={activeTab.sessionId}
            terminalId={activeTab.id}
            cwd={cwdByTerminal[activeTab.id]}
            onExecute={(cmd) => postJson("/term/input", { terminalId: activeTab.id, data: cmd + "\r" }).catch(() => {})}
            onClose={() => setShowAi(false)}
          />
        ) : null}
      </main>

      {/* right: monitor + sftp (ssh sessions only) */}
      {activeTab && activeTab.kind === "ssh" && activeTab.sessionId ? (
        <aside
          style={{
            width: 340,
            flex: "0 0 340px",
            borderLeft: `1px solid ${C.border}`,
            background: C.panel,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <MonitorPanel sessionId={activeTab.sessionId} />
          <SftpPanel key={activeTab.sessionId} sessionId={activeTab.sessionId} followPath={cwdByTerminal[activeTab.id]} />
        </aside>
      ) : null}

      {/* SSH keys modal */}
      {showKeys ? (
        <div
          onClick={() => setShowKeys(false)}
          style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 620, maxWidth: "94%", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>SSH 密钥管理</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
              {keys.length === 0 ? (
                <div style={S.muted}>还没有密钥</div>
              ) : (
                keys.map((k) => (
                  <div key={k.name} style={{ display: "flex", alignItems: "center", gap: 8, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 8px", fontSize: 12 }}>
                    <span style={{ flex: 1 }}>
                      <b>{k.name}</b> <span style={S.muted}>· {k.type} · {k.fingerprint}</span>
                    </span>
                    <button style={{ ...S.btn, padding: "1px 8px", fontSize: 11, color: C.danger }} onClick={() => removeKey(k.name)}>
                      删除
                    </button>
                  </div>
                ))
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={S.muted}>名称</span>
                <input style={S.input} value={keyForm.name} onChange={(e) => setKeyForm((f) => ({ ...f, name: e.target.value }))} placeholder="例如 x2600-key" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={S.muted}>操作</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button style={S.btnPrimary} onClick={makeKey}>生成 ed25519</button>
                  <button style={S.btn} onClick={importKeyMaterial}>导入粘贴的私钥</button>
                </div>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / span 2" }}>
                <span style={S.muted}>粘贴私钥（仅导入时使用；不会显示在会话里）</span>
                <textarea
                  value={keyForm.privateKey}
                  onChange={(e) => setKeyForm((f) => ({ ...f, privateKey: e.target.value }))}
                  spellCheck={false}
                  style={{ height: 90, background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: 8, fontFamily: "ui-monospace, monospace", fontSize: 11.5, resize: "vertical" }}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </label>
            </div>
            {generatedPub ? (
              <div style={{ marginTop: 10 }}>
                <div style={S.muted}>公钥（复制到远端 authorized_keys）</div>
                <textarea readOnly value={generatedPub} style={{ width: "100%", height: 56, background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: 8, fontFamily: "ui-monospace, monospace", fontSize: 11 }} />
              </div>
            ) : null}
            {keyMsg ? <div style={{ marginTop: 8, fontSize: 12, color: keyMsg.kind === "err" ? C.danger : C.ok }}>{keyMsg.text}</div> : null}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <button style={S.btn} onClick={() => setShowKeys(false)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* import / export modal */}
      {showIO ? (
        <div
          onClick={() => setShowIO(false)}
          style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 520, maxWidth: "94%", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>导入 / 导出会话</div>
            <div style={{ ...S.muted, marginBottom: 6 }}>导出（不含密码；跳板按名称保留）</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <button style={S.btn} onClick={() => exportSessions("json")}>导出 JSON</button>
              <button style={S.btn} onClick={() => exportSessions("moba")}>导出 MobaXterm</button>
            </div>
            <div style={{ ...S.muted, marginBottom: 6 }}>导入（支持 .json / .xsh / .mxtsessions）</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={S.btnPrimary} onClick={() => ioFileRef.current && ioFileRef.current.click()}>选择文件导入</button>
              <input
                ref={ioFileRef}
                type="file"
                accept=".json,.xsh,.mxtsessions,.ini,.txt"
                style={{ display: "none" }}
                onChange={(e) => {
                  importSessions(e.target.files && e.target.files[0]);
                  e.target.value = "";
                }}
              />
            </div>
            {ioMsg ? <div style={{ marginTop: 10, fontSize: 12, color: ioMsg.kind === "err" ? C.danger : C.ok }}>{ioMsg.text}</div> : null}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <button style={S.btn} onClick={() => setShowIO(false)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* settings modal */}
      {showSettings ? (
        <div
          onClick={() => setShowSettings(false)}
          style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 420, maxWidth: "92%", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>终端设置</div>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              <span style={S.muted}>字号：{prefs.fontSize}px</span>
              <input type="range" min="10" max="20" step="1" value={prefs.fontSize} onChange={(e) => updatePrefs({ fontSize: Number(e.target.value) })} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={S.muted}>主题</span>
              <select style={S.input} value={prefs.theme} onChange={(e) => updatePrefs({ theme: e.target.value })}>
                <option value="dark">深色</option>
                <option value="light">浅色</option>
              </select>
            </label>
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}`, fontSize: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={S.muted}>终端输出本地保存</span>
                <span style={{ color: termConfig && termConfig.saveScrollback ? C.ok : C.dim }}>
                  {termConfig ? (termConfig.saveScrollback ? "已开启" : "已关闭") : "—"}
                </span>
              </div>
              <div style={{ ...S.muted, marginTop: 4, wordBreak: "break-all" }}>{termConfig ? termConfig.scrollbackDir : ""}</div>
              <div style={{ ...S.muted, marginTop: 6, fontSize: 11 }}>
                用于 AI 分析历史输出；在插件配置中修改 saveScrollback / scrollbackDir
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
              <button style={S.btnPrimary} onClick={() => setShowSettings(false)}>完成</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* port-forward panel */}
      {fwdFor ? (
        <div
          onClick={() => setFwdFor(null)}
          style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 560, maxWidth: "94%", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>端口转发</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={S.muted}>类型</span>
                <select style={S.input} value={fwdForm.kind} onChange={(e) => setFwdForm((f) => ({ ...f, kind: e.target.value }))}>
                  <option value="local">本地转发 (-L)</option>
                  <option value="remote">远程转发 (-R)</option>
                  <option value="dynamic">动态 SOCKS5 (-D)</option>
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={S.muted}>监听端口</span>
                <input style={S.input} value={fwdForm.bindPort} onChange={(e) => setFwdForm((f) => ({ ...f, bindPort: e.target.value }))} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={S.muted}>监听地址</span>
                <input style={S.input} value={fwdForm.bindAddr} onChange={(e) => setFwdForm((f) => ({ ...f, bindAddr: e.target.value }))} />
              </label>
              {fwdForm.kind !== "dynamic" ? (
                <>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={S.muted}>目标主机</span>
                    <input style={S.input} value={fwdForm.dstHost} onChange={(e) => setFwdForm((f) => ({ ...f, dstHost: e.target.value }))} placeholder="127.0.0.1" />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={S.muted}>目标端口</span>
                    <input style={S.input} value={fwdForm.dstPort} onChange={(e) => setFwdForm((f) => ({ ...f, dstPort: e.target.value }))} />
                  </label>
                </>
              ) : (
                <div style={{ ...S.muted, gridColumn: "1 / span 2" }}>动态模式在本机提供 SOCKS5 代理，目标由客户端指定。</div>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button style={S.btnPrimary} onClick={createForward} disabled={fwdBusy}>{fwdBusy ? "启动中…" : "启动转发"}</button>
            </div>
            <div style={{ marginTop: 14 }}>
              <div style={{ ...S.muted, marginBottom: 6 }}>运行中的转发</div>
              {forwards.length === 0 ? (
                <div style={S.muted}>暂无</div>
              ) : (
                forwards.map((f) => (
                  <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6, marginBottom: 6, fontSize: 12 }}>
                    <span style={{ color: f.state === "running" ? C.ok : C.danger }}>●</span>
                    <span style={{ flex: 1 }}>
                      {f.kind} {f.bindAddr}:{f.bindPort}
                      {f.kind !== "dynamic" ? ` → ${f.dstHost}:${f.dstPort}` : " (SOCKS5)"}
                      {f.state !== "running" && f.error ? ` — ${f.error}` : ""}
                    </span>
                    <button style={{ ...S.btn, padding: "1px 8px", fontSize: 11 }} onClick={() => stopForward(f.id)}>停止</button>
                  </div>
                ))
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button style={S.btn} onClick={() => setFwdFor(null)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}

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
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>{form.kind === "serial" ? "新建串口会话" : "新建 SSH 会话"}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button style={form.kind === "ssh" ? S.btnPrimary : S.btn} onClick={() => patch("kind", "ssh")}>SSH</button>
              <button style={form.kind === "serial" ? S.btnPrimary : S.btn} onClick={() => patch("kind", "serial")}>串口</button>
            </div>
            {form.kind === "serial" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={S.muted}>名称</span>
                  <input style={S.input} value={form.name} onChange={(e) => patch("name", e.target.value)} placeholder="例如 板子串口" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={S.muted}>分组</span>
                  <input style={S.input} value={form.group} onChange={(e) => patch("group", e.target.value)} placeholder="默认" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / span 2" }}>
                  <span style={S.muted}>串口设备</span>
                  <input list="aixterm-serial-ports" style={S.input} value={form.serialPath} onChange={(e) => patch("serialPath", e.target.value)} placeholder="/dev/ttyUSB0 或 COM3" />
                  <datalist id="aixterm-serial-ports">
                    {serialPorts.map((p) => (
                      <option key={p.path} value={p.path}>
                        {p.manufacturer || p.serialNumber || ""}
                      </option>
                    ))}
                  </datalist>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={S.muted}>波特率</span>
                  <input list="aixterm-baud" style={S.input} value={form.baudRate} onChange={(e) => patch("baudRate", e.target.value)} />
                  <datalist id="aixterm-baud">
                    {["9600", "19200", "38400", "57600", "115200", "230400", "460800", "921600", "1500000"].map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={S.muted}>数据位 / 停止位 / 校验</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <select style={S.input} value={form.dataBits} onChange={(e) => patch("dataBits", e.target.value)}>
                      {["8", "7", "6", "5"].map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                    <select style={S.input} value={form.stopBits} onChange={(e) => patch("stopBits", e.target.value)}>
                      {["1", "1.5", "2"].map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                    <select style={S.input} value={form.parity} onChange={(e) => patch("parity", e.target.value)}>
                      {["none", "even", "odd"].map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </div>
                </label>
              </div>
            ) : (
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
              <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / span 2" }}>
                <span style={S.muted}>跳板机（可选，经已保存会话中转）</span>
                <select style={S.input} value={form.proxyJump} onChange={(e) => patch("proxyJump", e.target.value)}>
                  <option value="">直连</option>
                  {sessions.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}（{x.user}@{x.host}:{x.port}）
                    </option>
                  ))}
                </select>
              </label>
              {form.authKind === "password" ? (
                <>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / span 2" }}>
                    <span style={S.muted}>密码</span>
                    <input style={S.input} type="password" value={form.password} onChange={(e) => patch("password", e.target.value)} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / span 2" }}>
                    <span style={S.muted}>凭据引用（可选：dsh 凭据服务中的名称，优先于密码）</span>
                    <input style={S.input} value={form.credentialEnv} onChange={(e) => patch("credentialEnv", e.target.value)} placeholder="例如 X2600_SSH_PASSWORD" />
                  </label>
                </>
              ) : form.authKind === "key" ? (
                <>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / span 2" }}>
                    <span style={S.muted}>已存密钥（密钥管理里生成/导入的）</span>
                    <select style={S.input} value={form.keyId} onChange={(e) => patch("keyId", e.target.value)}>
                      <option value="">（使用下面的路径）</option>
                      {keys.map((k) => (
                        <option key={k.name} value={k.name}>
                          {k.name}（{k.type}）
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / span 2" }}>
                    <span style={S.muted}>私钥路径（本机绝对路径，未选已存密钥时使用）</span>
                    <input style={S.input} value={form.keyPath} onChange={(e) => patch("keyPath", e.target.value)} placeholder="/home/you/.ssh/id_ed25519" />
                  </label>
                </>
              ) : (
                <div style={{ ...S.muted, gridColumn: "1 / span 2" }}>使用 ssh-agent（SSH_AUTH_SOCK）</div>
              )}
              <label style={{ display: "flex", alignItems: "center", gap: 6, gridColumn: "1 / span 2", ...S.muted, cursor: "pointer" }} title="需要本机运行 X server（DISPLAY）">
                <input type="checkbox" checked={form.x11} onChange={(e) => patch("x11", e.target.checked)} />
                X11 转发（需要本机运行 X server）
              </label>
            </div>
            )}
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
