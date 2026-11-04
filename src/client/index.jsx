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

const THEMES = {
  dark: XTERM_THEME,
  light: LIGHT_THEME,
  solarized: {
    background: "#002b36", foreground: "#839496", cursor: "#93a1a1", selectionBackground: "#073642",
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2",
    magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5", brightBlack: "#002b36", brightRed: "#cb4b16",
    brightGreen: "#586e75", brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
  },
  dracula: {
    background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", selectionBackground: "#44475a",
    black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#bd93f9",
    magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2", brightBlack: "#6272a4", brightRed: "#ff6e6e",
    brightGreen: "#69ff94", brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
    brightCyan: "#a4ffff", brightWhite: "#ffffff",
  },
  contrast: {
    background: "#000000", foreground: "#00ff00", cursor: "#00ff00", selectionBackground: "#005500",
    black: "#000000", red: "#ff5555", green: "#00ff00", yellow: "#ffff00", blue: "#55aaff",
    magenta: "#ff55ff", cyan: "#55ffff", white: "#ffffff", brightBlack: "#555555", brightRed: "#ff8888",
    brightGreen: "#88ff88", brightYellow: "#ffff88", brightBlue: "#88bbff", brightMagenta: "#ff88ff",
    brightCyan: "#88ffff", brightWhite: "#ffffff",
  },
};

const FONT_CHOICES = [
  ["", "默认等宽字体"],
  ["'Cascadia Code', monospace", "Cascadia Code"],
  ["'JetBrains Mono', monospace", "JetBrains Mono"],
  ["Consolas, monospace", "Consolas"],
  ["Menlo, monospace", "Menlo"],
  ["'Source Code Pro', monospace", "Source Code Pro"],
  ["ui-monospace, monospace", "系统等宽"],
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

/** Build a text transformer that colors keyword matches (ANSI apart). */
function buildHighlighter(rules) {
  const valid = (rules || []).filter((r) => r && String(r.pattern || "").trim() && HEX_RE.test(String(r.color || "")));
  if (!valid.length) return null;
  const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(valid.map((r) => escapeRe(r.pattern.trim())).join("|"), "gi");
  const colorOf = (match) => {
    const lower = match.toLowerCase();
    const hit = valid.find((r) => r.pattern.trim().toLowerCase() === lower);
    return (hit || valid[0]).color;
  };
  return (text) => {
    const parts = String(text).split(/(\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07)/);
    return parts
      .map((part, i) => {
        if (i % 2 === 1) return part;
        return part.replace(re, (m) => `\x1b[38;2;${hexToRgb(colorOf(m))}m${m}\x1b[39m`);
      })
      .join("");
  };
}

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

function TerminalPane({ terminalId, sessionId, active, visible = true, onCwd, onInput, onAiAsk, sessionOptions = [], prefs }) {
  const tr = (zh, en) => ((prefs && prefs.lang) === "en" ? en : zh);
  const hostRef = useRef(null);
  const onCwdRef = useRef(onCwd);
  const onInputRef = useRef(onInput);
  const prefsRef = useRef(prefs);
  const hlRef = useRef({ key: "", fn: null });
  const searchRef = useRef(null);
  const historyRef = useRef([]);
  const lineRef = useRef("");
  const escRef = useRef(0);
  const suggestionRef = useRef(null);
  const lineTimesRef = useRef(new Map());
  const lastFilledLineRef = useRef(0);
  const gutterRafRef = useRef(0);
  const gutterUpdateRef = useRef(null);
  const [suggestion, setSuggestion] = useState(null);
  const [gutterRows, setGutterRows] = useState([]);
  const [gutterLineH, setGutterLineH] = useState(0);
  const zmodemSendRef = useRef(null);
  const zfileRef = useRef(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [menu, setMenu] = useState(null);
  const [askBox, setAskBox] = useState(null);
  const [askText, setAskText] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const askRef = useRef(null);
  const copyTimerRef = useRef(null);

  function showNotice(text) {
    setCopyNotice(text);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyNotice(""), 2000);
  }
  const termRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    onCwdRef.current = onCwd;
  }, [onCwd]);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  useEffect(() => {
    if (!sessionId) return;
    (async () => {
      try {
        const r = await fetch(PREFIX + "/history?sessionId=" + encodeURIComponent(sessionId));
        const d = await r.json();
        if (d && d.ok) historyRef.current = d.commands || [];
      } catch {
        /* history unavailable */
      }
    })();
  }, [sessionId]);

  useEffect(() => {
    const hide = () => setMenu(null);
    document.addEventListener("click", hide);
    return () => document.removeEventListener("click", hide);
  }, []);

  useEffect(() => {
    if (!askBox) return undefined;
    const onDoc = (e) => {
      if (askRef.current && !askRef.current.contains(e.target)) setAskBox(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [askBox]);

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
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && String(e.key).toLowerCase() === "c") {
        copySelection();
        return false;
      }
      if (e.type === "keydown" && e.ctrlKey && !e.shiftKey && String(e.key).toLowerCase() === "f") {
        setFindOpen(true);
        return false;
      }
      if (e.type === "keydown" && e.key === "Tab" && suggestionRef.current && suggestionRef.current.list.length) {
        const target = suggestionRef.current.list[0];
        const input = suggestionRef.current.input;
        const rest = target.startsWith(input) ? target.slice(input.length) : "";
        lineRef.current = target;
        suggestionRef.current = null;
        setSuggestion(null);
        if (rest && onInputRef.current) onInputRef.current(rest);
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
    // Decode bytes to text (streaming, multi-byte safe), apply keyword
    // highlighting, then write to the terminal.
    const decoder = new TextDecoder("utf-8");
    const writeOut = (octets) => {
      try {
        const bytes = octets instanceof Uint8Array ? octets : Uint8Array.from(octets);
        const text = decoder.decode(bytes, { stream: true });
        const rules = prefsRef.current && prefsRef.current.highlights;
        const key = rules && rules.length ? JSON.stringify(rules) : "";
        if (hlRef.current.key !== key) hlRef.current = { key, fn: key ? buildHighlighter(rules) : null };
        term.write(hlRef.current.fn ? hlRef.current.fn(text) : text);
        // Record the first-seen time per physical buffer line for the gutter.
        try {
          const now = Date.now();
          const buf = term.buffer.active;
          const baseY = buf.baseY;
          if (baseY < lastFilledLineRef.current) {
            lineTimesRef.current.clear();
            lastFilledLineRef.current = 0;
          }
          // Fill missing timestamps for new lines and for the visible viewport,
          // so on-screen lines carry a time too.
          const start = Math.min(lastFilledLineRef.current, buf.viewportY);
          const end = Math.max(baseY, buf.viewportY + term.rows - 1);
          for (let l = start; l <= end; l += 1) {
            if (!lineTimesRef.current.has(l)) lineTimesRef.current.set(l, now);
          }
          lastFilledLineRef.current = Math.max(lastFilledLineRef.current, baseY + 1);
          scheduleGutter();
        } catch {
          /* gutter bookkeeping failed */
        }
      } catch {
        /* terminal gone */
      }
    };

    let zsentry = null;
    try {
      zsentry = new Zmodem.Sentry({
        to_terminal: (octets) => writeOut(octets),
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

    const updateGutterNow = () => {
      const mode = prefsRef.current && prefsRef.current.gutter;
      if (!mode || mode === "off") {
        setGutterRows([]);
        return;
      }
      const buf = term.buffer.active;
      const top = buf.viewportY;
      const rows = [];
      for (let i = 0; i < term.rows; i += 1) {
        const line = top + i;
        rows.push({ no: line + 1, time: lineTimesRef.current.get(line) || "" });
      }
      setGutterRows(rows);
      const screen = term.element && term.element.querySelector(".xterm-screen");
      if (screen) {
        const h = screen.getBoundingClientRect().height;
        if (h > 0 && term.rows > 0) setGutterLineH(h / term.rows);
      }
    };
    const scheduleGutter = () => {
      if (gutterRafRef.current) return;
      gutterRafRef.current = requestAnimationFrame(() => {
        gutterRafRef.current = 0;
        try {
          updateGutterNow();
        } catch {
          /* terminal disposed */
        }
      });
    };
    gutterUpdateRef.current = () => scheduleGutter();
    const renderDisposable = term.onRender(() => scheduleGutter());
    const scrollDisposable = term.onScroll(() => scheduleGutter());
    const gutterResizeDisposable = term.onResize(() => scheduleGutter());

    const es = new EventSource(PREFIX + "/term/stream?terminalId=" + encodeURIComponent(terminalId));
    es.onmessage = (e) => {
      try {
        const bytes = b64ToBytes(e.data);
        // With ZMODEM detection active, the Sentry owns the output path: it
        // forwards ordinary traffic to to_terminal() itself (consume() returns
        // undefined in that case, so a second write here would duplicate it).
        if (zsentry) zsentry.consume(bytes);
        else writeOut(bytes);
      } catch {
        /* bad chunk */
      }
    };

    const updateSuggestion = () => {
      const enabled = !prefsRef.current || prefsRef.current.suggestions !== false;
      const alt = term.buffer && term.buffer.active && term.buffer.active.type === "alternate";
      const input = lineRef.current;
      if (!enabled || alt || !input) {
        suggestionRef.current = null;
        setSuggestion(null);
        return;
      }
      const matches = [];
      const seen = new Set();
      for (let i = historyRef.current.length - 1; i >= 0 && matches.length < 5; i -= 1) {
        const cmd = historyRef.current[i];
        if (!cmd || cmd === input || seen.has(cmd)) continue;
        if (cmd.startsWith(input) || cmd.includes(input)) {
          seen.add(cmd);
          matches.push(cmd);
        }
      }
      const next = matches.length ? { input, list: matches } : null;
      suggestionRef.current = next;
      setSuggestion(next);
    };

    const updateLine = (data) => {
      for (const ch of String(data)) {
        const code = ch.charCodeAt(0);
        if (escRef.current === 1) {
          escRef.current = code === 91 ? 2 : 0;
          continue;
        }
        if (escRef.current === 2) {
          if (code >= 64 && code <= 126) escRef.current = 0;
          continue;
        }
        if (code === 27) {
          escRef.current = 1;
          continue;
        }
        if (ch === "\r" || ch === "\n") {
          const cmd = lineRef.current.trim();
          lineRef.current = "";
          if (cmd) {
            historyRef.current.push(cmd);
            if (historyRef.current.length > 500) historyRef.current.shift();
          }
          continue;
        }
        if (code === 127 || code === 8) {
          lineRef.current = lineRef.current.slice(0, -1);
          continue;
        }
        if (code === 3 || code === 21) {
          lineRef.current = "";
          continue;
        }
        if (code >= 32 && code < 127) lineRef.current += ch;
      }
      updateSuggestion();
    };

    const dataDisposable = term.onData((data) => {
      if (typeof data === "string") updateLine(data);
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
        renderDisposable.dispose();
        scrollDisposable.dispose();
        gutterResizeDisposable.dispose();
        if (gutterRafRef.current) cancelAnimationFrame(gutterRafRef.current);
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
      gutterUpdateRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      term.options.fontSize = (prefs && prefs.fontSize) || 13;
      term.options.fontFamily = (prefs && prefs.fontFamily) || mono;
      term.options.lineHeight = Number(prefs && prefs.lineHeight) || 1.15;
      term.options.theme = THEMES[(prefs && prefs.theme) || "dark"] || XTERM_THEME;
      fitRef.current && fitRef.current.fit();
    } catch {
      /* options not ready */
    }
  }, [prefs && prefs.fontSize, prefs && prefs.theme, prefs && prefs.fontFamily, prefs && prefs.lineHeight]);

  useEffect(() => {
    try {
      gutterUpdateRef.current && gutterUpdateRef.current();
    } catch {
      /* terminal not ready */
    }
  }, [prefs && prefs.gutter, prefs && prefs.fontSize, prefs && prefs.lineHeight]);

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

  function completeWith(cmd) {
    const input = lineRef.current;
    if (cmd.startsWith(input)) {
      const rest = cmd.slice(input.length);
      if (rest && onInputRef.current) onInputRef.current(rest);
    } else if (onInputRef.current) {
      // Replace the whole line: Ctrl+U then the command.
      onInputRef.current("\x15" + cmd);
    }
    lineRef.current = cmd;
    suggestionRef.current = null;
    setSuggestion(null);
  }

  function execCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  function copySelection() {
    try {
      const sel = termRef.current && termRef.current.getSelection();
      if (!sel) {
        showNotice(tr("未选中内容", "Nothing selected"));
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(sel)
          .then(() => showNotice(tr("已复制", "Copied")))
          .catch(() => showNotice(execCopy(sel) ? tr("已复制", "Copied") : tr("复制失败", "Copy failed")));
      } else {
        showNotice(execCopy(sel) ? tr("已复制", "Copied") : tr("复制失败", "Copy failed"));
      }
    } catch {
      showNotice(tr("复制失败", "Copy failed"));
    }
  }

  async function pasteClipboard() {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        showNotice(tr("请用 Ctrl+Shift+V 粘贴", "Use Ctrl+Shift+V to paste"));
        return;
      }
      const text = await navigator.clipboard.readText();
      if (text) {
        postJson("/term/input", { terminalId, data: text }).catch(() => {});
        showNotice(tr("已粘贴", "Pasted"));
      }
    } catch {
      showNotice(tr("请用 Ctrl+Shift+V 粘贴", "Use Ctrl+Shift+V to paste"));
    }
  }

  function downloadLog() {
    const a = document.createElement("a");
    a.href = PREFIX + "/term/log?terminalId=" + encodeURIComponent(terminalId);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function clearScrollback() {
    try {
      // CSI 3 J: erase the saved scrollback, keeping the visible screen.
      termRef.current && termRef.current.write("\x1b[3J");
    } catch {
      /* terminal gone */
    }
  }

  function resetTerminal() {
    try {
      termRef.current && termRef.current.reset();
    } catch {
      /* terminal gone */
    }
  }

  function submitAsk() {
    const q = String(askText || "").trim();
    if (!q && !(askBox && askBox.sel)) return;
    const withSel =
      askBox && askBox.sel && !q.includes(askBox.sel.slice(0, 40))
        ? `${q || "解释这段输出"}\n\n（选中的终端内容：\n${askBox.sel.slice(0, 2000)}\n）`
        : q;
    const target = (askBox && askBox.target) || "";
    setAskBox(null);
    setAskText("");
    if (onAiAsk) onAiAsk(withSel, target);
  }

  const menuItems = [
    ["AI 提问", () => {
      const sel = (termRef.current && termRef.current.getSelection()) || "";
      setAskBox({ x: menu ? menu.x : 100, y: menu ? menu.y : 100, sel, target: "" });
    }],
    ["复制", copySelection],
    ["粘贴", pasteClipboard],
    ["全选", () => termRef.current && termRef.current.selectAll()],
    ["查找", () => setFindOpen(true)],
    ["下载日志", downloadLog],
    ["清屏", () => termRef.current && termRef.current.clear()],
    ["清除回滚", clearScrollback],
    ["重置终端", resetTerminal],
  ];

  const gutterMode = (prefs && prefs.gutter) || "off";
  const gutterWidth = gutterMode === "off" ? 0 : gutterMode === "both" ? 96 : 64;
  const fmtGutterTime = (ts) => {
    if (!ts) return "";
    try {
      return new Date(ts).toTimeString().slice(0, 8);
    } catch {
      return "";
    }
  };
  const gutterLines = gutterRows.map((r, i) => {
    const label =
      gutterMode === "time" ? fmtGutterTime(r.time) : gutterMode === "line" ? String(r.no) : `${r.no} ${fmtGutterTime(r.time)}`;
    return (
      <div
        key={i}
        style={{
          height: gutterLineH || 16,
          lineHeight: `${gutterLineH || 16}px`,
          paddingRight: 6,
          textAlign: gutterMode === "line" ? "right" : "left",
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {label}
      </div>
    );
  });

  return (
    <div style={{ position: "relative", display: visible ? "block" : "none", flex: 1, minHeight: 0 }}>
      {gutterWidth ? (
        <div
          data-aixterm-gutter="1"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: gutterWidth,
            background: C.panel,
            borderRight: `1px solid ${C.border}`,
            paddingTop: 6,
            fontFamily: "ui-monospace, monospace",
            fontSize: 10.5,
            color: C.dim,
            overflow: "hidden",
            userSelect: "none",
          }}
        >
          {gutterLines}
        </div>
      ) : null}
      <div
        ref={hostRef}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{ position: "absolute", top: 0, bottom: 0, right: 0, left: gutterWidth, padding: "6px 8px", overflow: "hidden" }}
      />
      {copyNotice ? (
        <div
          style={{
            position: "absolute",
            top: 10,
            left: "50%",
            transform: "translateX(-50%)",
            background: C.panel2,
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            padding: "3px 10px",
            fontSize: 11,
            zIndex: 6,
          }}
        >
          {copyNotice}
        </div>
      ) : null}
      {suggestion ? (
        <div
          style={{
            position: "absolute",
            left: (gutterMode !== "off" ? (gutterMode === "both" ? 96 : 64) : 0) + 16,
            bottom: 10,
            zIndex: 5,
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: 4,
            maxWidth: "70%",
            boxShadow: "0 8px 24px rgba(0,0,0,.45)",
          }}
        >
          {suggestion.list.map((cmd, i) => (
            <div
              key={cmd}
              onClick={() => completeWith(cmd)}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.hover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{
                padding: "3px 8px",
                fontSize: 11.5,
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: "ui-monospace, monospace",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              <span style={{ color: C.accent, marginRight: 4 }}>{i === 0 ? "↹" : " "}</span>
              {cmd}
            </div>
          ))}
        </div>
      ) : null}
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
      {askBox ? (() => {
        const popW = 380;
        const popH = 220;
        const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
        const vh = typeof window !== "undefined" ? window.innerHeight : 800;
        const left = Math.min(Math.max(8, askBox.x + 4), Math.max(8, vw - popW - 8));
        const top = askBox.y + 4 + popH > vh - 8 ? Math.max(8, askBox.y - popH - 4) : askBox.y + 4;
        return (
        <div
          ref={askRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            left,
            top,
            zIndex: 80,
            width: popW,
            boxSizing: "border-box",
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: 10,
            boxShadow: "0 12px 36px rgba(0,0,0,.55)",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            AI 提问{askBox.sel ? "（已附选中的终端内容）" : ""}
          </div>
          <select
            style={{ ...S.input, width: "100%", boxSizing: "border-box", padding: "2px 6px", fontSize: 11, marginBottom: 6 }}
            value={askBox.target || ""}
            onChange={(e) => setAskBox((b) => (b ? { ...b, target: e.target.value } : b))}
          >
            <option value="">{tr("当前 / 默认会话", "Current / default session")}</option>
            <option value="__new__">{tr("＋ 新建会话（dsh 默认模型，可在主界面调整）", "+ New session (dsh default model)")}</option>
            {sessionOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
          <textarea
            autoFocus
            value={askText}
            onChange={(e) => setAskText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAskBox(null);
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submitAsk();
            }}
            placeholder={tr("问什么？（Ctrl+Enter 发送到主会话 AI）", "Ask (Ctrl+Enter to send)")}
            style={{
              width: "100%",
              boxSizing: "border-box",
              height: 72,
              background: C.bg,
              color: C.text,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: 8,
              fontSize: 12,
              resize: "vertical",
            }}
          />
          {askBox.sel ? (
            <div style={{ ...S.muted, fontSize: 10, marginTop: 4, maxHeight: 34, overflow: "hidden" }}>
              {tr("选中：", "Sel: ")}{askBox.sel.slice(0, 90)}
            </div>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 8 }}>
            <button style={S.btn} onClick={() => setAskBox(null)}>取消</button>
            <button style={S.btnPrimary} onClick={submitAsk}>{tr("发送到 AI", "Send")}</button>
          </div>
        </div>
        );
      })() : null}
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

const RIGHT_TOOLS = [
  { id: "files", icon: "📁", label: "文件 (SFTP)" },
  { id: "monitor", icon: "📊", label: "资源监控" },
  { id: "network", icon: "🌐", label: "网络工具" },
  { id: "system", icon: "🧰", label: "系统工具" },
  { id: "process", icon: "📋", label: "进程管理" },
  { id: "logs", icon: "📜", label: "日志查看" },
  { id: "forward", icon: "🔁", label: "端口转发" },
  { id: "diagnose", icon: "🔍", label: "连接诊断" },
];

const TOOL_PLANS = {
  network: ["ping / traceroute", "端口连通检测", "网络接口详情", "路由表", "DNS 解析", "端口扫描"],
  system: ["系统信息", "磁盘与挂载", "磁盘占用分析", "服务/自启管理", "软件包管理", "时间同步"],
  process: ["进程列表（按 CPU/内存排序）", "进程树", "查找进程", "终止进程（审批）", "进程详情"],
  logs: ["命令历史日志（人/AI）", "终端滚动日志", "远端系统日志（dmesg/syslog）", "日志高亮与过滤"],
  forward: ["全局转发视图（-L/-R/-D）", "增删查与状态", "字节流量统计"],
  diagnose: ["DNS → TCP → SSH → 认证 → 跳板", "各阶段延迟", "一键诊断报告"],
};

function ToolPlaceholder({ tool }) {
  const tr = (zh, en) => zh;
  const title = (RIGHT_TOOLS.find((t) => t.id === tool) || {}).label || tool;
  const items = TOOL_PLANS[tool] || [];
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 12, fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <div style={S.muted}>{tr("规划中，后续填充（见 docs/tools-roadmap.md）：", "Planned (see docs/tools-roadmap.md):")}</div>
      <ul style={{ paddingLeft: 18, margin: "8px 0 0" }}>
        {items.map((x) => (
          <li key={x} style={{ margin: "3px 0", color: C.dim }}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function FloatingTool({ tool, sessionId, index, onClose }) {
  const [pos, setPos] = useState(() => ({ x: 60 + index * 24, y: 60 + index * 24 }));
  const dragRef = useRef(null);
  const label = (RIGHT_TOOLS.find((t) => t.id === tool) || {}).label || tool;
  const onMouseDown = (e) => {
    e.preventDefault();
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    const move = (ev) => setPos({ x: ev.clientX - dragRef.current.dx, y: ev.clientY - dragRef.current.dy });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return (
    <div
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: 300,
        maxHeight: 520,
        zIndex: 90,
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        boxShadow: "0 12px 40px rgba(0,0,0,.5)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        onMouseDown={onMouseDown}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderBottom: `1px solid ${C.border}`, cursor: "move", userSelect: "none", fontSize: 12, fontWeight: 600 }}
      >
        <span>{label}</span>
        <button style={{ border: "none", background: "transparent", color: C.dim, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }} onClick={onClose} title="关闭">✕</button>
      </div>
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {tool === "monitor" ? (
          <MonitorPanel sessionId={sessionId} />
        ) : tool === "files" ? (
          <SftpPanel sessionId={sessionId} />
        ) : (
          <ToolPlaceholder tool={tool} />
        )}
      </div>
    </div>
  );
}

function TransferPanel({ onClose }) {
  const [list, setList] = useState([]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(PREFIX + "/transfers");
        const d = await r.json();
        if (alive && d && d.ok) setList(d.transfers || []);
      } catch {
        /* unavailable */
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  async function act(id, action) {
    try {
      await postJson("/transfers/action", { id, action });
    } catch {
      /* ignore */
    }
  }

  function saveFile(task) {
    const a = document.createElement("a");
    a.href = PREFIX + "/transfers/file?id=" + encodeURIComponent(task.id);
    a.download = task.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const fmtBytes = (n) => {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
    if (v >= 1024) return (v / 1024).toFixed(1) + " KB";
    return v + " B";
  };
  const fmtSpeed = (v) => {
    const n = Number(v) || 0;
    if (!n) return "";
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB/s";
    if (n >= 1024) return (n / 1024).toFixed(1) + " KB/s";
    return Math.round(n) + " B/s";
  };
  const statusLabel = (st) =>
    ({ queued: "排队", running: "传输中", paused: "已暂停", done: "完成", failed: "失败", canceled: "已取消" }[st] || st);

  return (
    <div
      onClick={onClose}
      style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 680, maxWidth: "94%", maxHeight: "80%", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>传输队列</div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {list.length === 0 ? (
            <div style={S.muted}>暂无传输任务（在文件面板上传/下载会加入队列）</div>
          ) : (
            list.map((t) => {
              const pct = t.size ? Math.min(100, Math.round((t.transferred / t.size) * 100)) : 0;
              return (
                <div key={t.id} style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span style={{ color: t.kind === "upload" ? C.accent : C.ok }}>{t.kind === "upload" ? "↑" : "↓"}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.remotePath || t.name}>
                      {t.name}
                    </span>
                    <span style={S.muted}>{fmtBytes(t.transferred)} / {fmtBytes(t.size)}</span>
                    <span style={{ color: t.status === "failed" ? C.danger : t.status === "done" ? C.ok : C.dim }}>
                      {statusLabel(t.status)}
                      {t.status === "running" && t.speed ? ` · ${fmtSpeed(t.speed)}` : ""}
                    </span>
                  </div>
                  <div style={{ height: 4, background: C.border, borderRadius: 2, marginTop: 6, overflow: "hidden" }}>
                    <div style={{ width: pct + "%", height: "100%", background: t.status === "failed" ? C.danger : C.accent }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 6 }}>
                    {t.status === "running" || t.status === "queued" ? (
                      <button style={{ ...S.btn, padding: "1px 8px", fontSize: 11 }} onClick={() => act(t.id, "pause")}>暂停</button>
                    ) : null}
                    {t.status === "paused" ? (
                      <button style={{ ...S.btnPrimary, padding: "1px 8px", fontSize: 11 }} onClick={() => act(t.id, "resume")}>继续</button>
                    ) : null}
                    {t.status === "failed" || t.status === "canceled" ? (
                      <button style={{ ...S.btn, padding: "1px 8px", fontSize: 11 }} onClick={() => act(t.id, "retry")}>重试</button>
                    ) : null}
                    {t.status !== "done" && t.status !== "canceled" ? (
                      <button style={{ ...S.btn, padding: "1px 8px", fontSize: 11, color: C.danger }} onClick={() => act(t.id, "cancel")}>取消</button>
                    ) : null}
                    {t.status === "done" && t.kind === "download" && !t.skipped ? (
                      <button style={{ ...S.btnPrimary, padding: "1px 8px", fontSize: 11 }} onClick={() => saveFile(t)}>保存到本机</button>
                    ) : null}
                  </div>
                  {t.error ? <div style={{ color: C.danger, fontSize: 11, marginTop: 4 }}>{t.error}</div> : null}
                </div>
              );
            })
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <button style={S.btn} onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/** Flatten a message content array to plain text (text blocks only). */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("")
    .trim();
}

/** Project session events into a small chat transcript. */
function projectTranscript(entries) {
  const out = [];
  for (const entry of entries || []) {
    const ev = entry && entry.event;
    if (!ev || !ev.type) continue;
    const payload = ev.data || ev;
    if (ev.type === "user/message") {
      const src = payload.source;
      const injected = src && src.kind && String(src.kind).startsWith("agent");
      const text = contentText(payload.content);
      if (!injected && text) out.push({ role: "user", text });
    } else if (ev.type === "assistant/message") {
      const text = contentText((payload.message && payload.message.content) || payload.content);
      if (text) out.push({ role: "assistant", text });
    } else if (ev.type === "tool/call") {
      out.push({ role: "tool", text: String(payload.name || ev.name || "tool") });
    } else if (ev.type === "turn/end") {
      const reason = payload.reason || ev.reason || {};
      if (reason.kind === "error" && reason.error) {
        out.push({ role: "error", text: String(reason.error.message || reason.error.code || "turn failed") });
      }
    }
  }
  return out.slice(-40);
}

function AiPanel({ hostCtx, lang, sessionId, terminalId, cwd, initialPrompt, initialSessionTarget, aiModelPolicy, aiProvider, aiModel, aiEffort, onInitialConsumed, onClose }) {
  const tr = (zh, en) => (lang === "en" ? en : zh);
  const [prompt, setPrompt] = useState("");
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState("");
  const [pendingImage, setPendingImage] = useState(null);
  const [sessionChoices, setSessionChoices] = useState([]);
  const [chosenSession, setChosenSession] = useState("");
  const [workspaceChoices, setWorkspaceChoices] = useState([]);
  const [chosenWorkspace, setChosenWorkspace] = useState("");
  const [presetText, setPresetText] = useState("");
  const [lastSentSession, setLastSentSession] = useState("");
  const [transcript, setTranscript] = useState([]);
  const imgFileRef = useRef(null);
  const scrollRef = useRef(null);

  function readImage(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setErr("图片超过 8MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const b64 = dataUrl.split(",")[1] || "";
      setPendingImage({ b64, type: file.type || "image/png", name: file.name || "pasted.png", dataUrl });
    };
    reader.readAsDataURL(file);
  }

  function onPaste(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        const file = it.getAsFile && it.getAsFile();
        if (file) {
          e.preventDefault();
          readImage(file);
        }
      }
    }
  }

  useEffect(() => {
    let sessions;
    try {
      sessions = hostCtx && typeof hostCtx.get === "function" ? hostCtx.get("sessions") : undefined;
    } catch {
      sessions = undefined;
    }
    if (!sessions || !sessions.list) return undefined;
    const read = () => {
      try {
        const snap = sessions.list.getSnapshot();
        const ids = (snap && snap.ids) || [];
        const byId = (snap && snap.byId) || {};
        setSessionChoices(
          ids.map((id) => ({
            id,
            title: (byId[id] && (byId[id].title || byId[id].name || byId[id].displayTitle)) || String(id).slice(0, 8),
          }))
        );
      } catch {
        /* snapshot unavailable */
      }
    };
    read();
    let unsub;
    try {
      unsub = sessions.list.subscribe ? sessions.list.subscribe(read) : undefined;
    } catch {
      unsub = undefined;
    }
    return () => {
      try {
        unsub && unsub();
      } catch {
        /* ignore */
      }
    };
  }, [hostCtx]);

  useEffect(() => {
    let workspaces;
    try {
      workspaces = hostCtx && typeof hostCtx.get === "function" ? hostCtx.get("workspaces") : undefined;
    } catch {
      workspaces = undefined;
    }
    if (!workspaces || !workspaces.list) return undefined;
    const read = () => {
      try {
        const snap = workspaces.list.getSnapshot();
        const list = Array.isArray(snap) ? snap : (snap && snap.workspaces) || [];
        setWorkspaceChoices(
          list.map((w) => ({ id: w.id || w.workspaceId, title: w.title || w.name || String(w.id || "").slice(0, 8) }))
        );
      } catch {
        /* snapshot unavailable */
      }
    };
    read();
    let unsub;
    try {
      unsub = workspaces.list.subscribe ? workspaces.list.subscribe(read) : undefined;
    } catch {
      unsub = undefined;
    }
    return () => {
      try {
        unsub && unsub();
      } catch {
        /* ignore */
      }
    };
  }, [hostCtx]);

  function resolveTargetSession(sessions) {
    let target = chosenSession;
    if (target === "__new__") return "";
    if (!target && typeof sessions.scopeOf === "function") {
      try {
        target = sessions.scopeOf(hostCtx) || "";
      } catch {
        target = "";
      }
    }
    if (!target) {
      try {
        const snap = sessions.list.getSnapshot();
        target = (snap && snap.ids && snap.ids[0]) || "";
      } catch {
        target = "";
      }
    }
    return target;
  }

  useEffect(() => {
    if (!hostCtx || typeof hostCtx.get !== "function") return undefined;
    let sessions;
    try {
      sessions = hostCtx.get("sessions");
    } catch {
      sessions = undefined;
    }
    if (!sessions || typeof sessions.retain !== "function") return undefined;
    const target = resolveTargetSession(sessions);
    if (!target) {
      setTranscript([]);
      return undefined;
    }
    let ref;
    try {
      ref = sessions.retain(target, { source: "controllerOperation" });
    } catch {
      return undefined;
    }
    let cancelled = false;
    let unsub;
    (async () => {
      try {
        await ref.ready;
        if (cancelled) return;
        const source = ref.binding.eventSource;
        const read = () => {
          try {
            setTranscript(projectTranscript(source.getSnapshot().entries));
          } catch {
            /* snapshot unavailable */
          }
        };
        read();
        unsub = source.subscribe ? source.subscribe(read) : undefined;
      } catch {
        /* retain failed */
      }
    })();
    return () => {
      cancelled = true;
      try {
        unsub && unsub();
      } catch {
        /* ignore */
      }
      try {
        ref && ref.release();
      } catch {
        /* ignore */
      }
    };
  }, [hostCtx, chosenSession]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  useEffect(() => {
    if (initialPrompt) {
      send(initialPrompt, initialSessionTarget || "");
      if (onInitialConsumed) onInitialConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  async function send(textOverride, targetOverride) {
    const q = String(textOverride || prompt || "").trim();
    if (!q && !pendingImage) return;
    setErr(null);
    setNotice("");
    let sessions;
    try {
      sessions = hostCtx && typeof hostCtx.get === "function" ? hostCtx.get("sessions") : undefined;
    } catch {
      sessions = undefined;
    }
    if (!sessions || typeof sessions.retain !== "function") {
      setErr(tr("主会话服务不可用", "Main session service unavailable"));
      return;
    }
    let target = targetOverride || chosenSession;
    let created = false;
    if (target === "__new__" || (!target && !sessionChoices.length)) {
      try {
        target = await sessions.create({
          ...(chosenWorkspace ? { workspaceId: chosenWorkspace } : {}),
          ...(presetText.trim() ? { agentPreset: presetText.trim() } : {}),
        });
        created = true;
      } catch (e) {
        setErr(tr("新建主会话失败：", "Create session failed: ") + String((e && e.message) || e));
        return;
      }
    }
    if (!target) target = resolveTargetSession(sessions);
    if (!target) {
      setErr(tr("没有可用的主会话", "No main session available"));
      return;
    }
    let ref;
    try {
      ref = sessions.retain(target, { source: "controllerOperation" });
      await ref.ready;
    if (aiModelPolicy === "override" && aiProvider && aiModel) {
      let dirs;
      try {
        dirs = hostCtx && typeof hostCtx.get === "function" ? hostCtx.get("modelDirectories") : undefined;
      } catch {
        dirs = undefined;
      }
      if (!dirs || typeof dirs.directoryFor !== "function") {
        setErr(tr("模型目录服务不可用", "Model directory service unavailable"));
        return;
      }
      try {
        const directory = dirs.directoryFor(target);
        const switched = await directory.select({
          provider: aiProvider,
          model: aiModel,
          ...(aiEffort ? { reasoningEffort: aiEffort } : {}),
        });
        if (switched && switched.ok === false) {
          const detail = switched.error && (switched.error.message || switched.error.code);
          setErr(tr("切换模型失败：", "Model switch failed: ") + String(detail || "unknown"));
          return;
        }
      } catch (e) {
        setErr(tr("切换模型失败：", "Model switch failed: ") + String((e && e.message) || e));
        return;
      }
    }
      const text = q || tr("（请分析这张图片）", "(please analyze this image)");
      const parts = [{ type: "text", text }];
      if (pendingImage) {
        parts.push({ type: "image", mediaType: pendingImage.type, data: pendingImage.b64, name: pendingImage.name });
      }
      await ref.binding.session.prompt(parts, "queue");
      setPrompt("");
      setPendingImage(null);
      setLastSentSession(target);
      if (created || targetOverride) setChosenSession(target);
      if (created) {
        setNotice(tr("已新建主会话（dsh 默认模型，可在主界面调整）并发送", "New session created (dsh default model)"));
      }
    } catch (e) {
      setErr(tr("发送失败：", "Send failed: ") + String((e && e.message) || e));
    } finally {
      try {
        ref && ref.release();
      } catch {
        /* ignore */
      }
    }
  }

  function quickAsk(text) {
    setPrompt(text);
  }

  function openMainSession() {
    const target = lastSentSession || (chosenSession && chosenSession !== "__new__" ? chosenSession : "");
    if (!target) {
      setErr(tr("先发送一次或选择一个主会话", "Send once or pick a session first"));
      return;
    }
    try {
      const ui = hostCtx && typeof hostCtx.get === "function" ? hostCtx.get("uiWorkspace") : undefined;
      if (ui && typeof ui.openSession === "function") {
        ui.openSession(target);
      } else {
        setErr(tr("主工作区导航不可用", "Main workspace navigation unavailable"));
      }
    } catch (e) {
      setErr(tr("打开主会话失败：", "Open failed: ") + String((e && e.message) || e));
    }
  }

  const roleStyle = {
    user: { label: tr("我", "Me"), color: C.accent },
    assistant: { label: "AI", color: C.ok },
    tool: { label: tr("工具", "Tool"), color: C.warn },
    error: { label: tr("错误", "Error"), color: C.danger },
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 400,
        background: C.panel,
        borderLeft: `1px solid ${C.border}`,
        display: "flex",
        flexDirection: "column",
        zIndex: 8,
        boxShadow: "-8px 0 24px rgba(0,0,0,.35)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{tr("AI 助手 · 主会话", "AI · main session")}</span>
        <button style={{ ...S.btn, padding: "1px 8px", fontSize: 11 }} onClick={onClose}>✕</button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: `1px solid ${C.border}`, fontSize: 11 }}>
        <select
          style={{ ...S.input, flex: 1, padding: "2px 6px", fontSize: 11 }}
          value={chosenSession}
          onChange={(e) => setChosenSession(e.target.value)}
        >
          <option value="">{tr("当前 / 默认会话", "Current / default")}</option>
          <option value="__new__">{tr("＋ 新建会话（按下方工作区/模式）", "+ New session (below)")}</option>
          {sessionChoices.map((sc) => (
            <option key={sc.id} value={sc.id}>
              {sc.title}
            </option>
          ))}
        </select>
        <button style={{ ...S.btn, padding: "1px 8px", fontSize: 11 }} onClick={openMainSession} title={tr("在主工作区打开该会话", "Open in the main workspace")}>
          ↗
        </button>
      </div>
      {chosenSession === "__new__" || (!chosenSession && !sessionChoices.length) ? (
        <div style={{ display: "flex", gap: 6, padding: "4px 10px", borderBottom: `1px solid ${C.border}`, fontSize: 11 }}>
          <select
            style={{ ...S.input, flex: 1, padding: "2px 6px", fontSize: 11 }}
            value={chosenWorkspace}
            onChange={(e) => setChosenWorkspace(e.target.value)}
          >
            <option value="">{tr("默认工作区", "Default workspace")}</option>
            {workspaceChoices.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title}
              </option>
            ))}
          </select>
          <input
            style={{ ...S.input, width: 120, padding: "2px 6px", fontSize: 11 }}
            value={presetText}
            onChange={(e) => setPresetText(e.target.value)}
            placeholder={tr("模式（如 standard）", "Preset (e.g. standard)")}
          />
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, padding: "6px 10px", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }}>
        <button style={{ ...S.btn, fontSize: 11 }} onClick={() => quickAsk(tr("解释终端里最近输出中的错误，并给出修复建议", "Explain the latest terminal error and suggest fixes"))}>
          {tr("诊断错误", "Diagnose")}
        </button>
        <button style={{ ...S.btn, fontSize: 11 }} onClick={() => quickAsk(tr("根据当前目录和最近命令，建议下一步可以执行的命令", "Suggest the next commands based on cwd and history"))}>
          {tr("建议下一步", "Next step")}
        </button>
        <button style={{ ...S.btn, fontSize: 11 }} onClick={() => quickAsk(tr("总结最近这段终端输出和命令做了什么", "Summarize the recent terminal output"))}>
          {tr("总结进展", "Summarize")}
        </button>
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "10px 12px", fontSize: 12.5, lineHeight: 1.6 }}>
        {transcript.length === 0 ? (
          <div style={S.muted}>
            {tr(
              "这里是 dsh 主会话的实时对话。发送的问题会由主 agent 处理（工具、审批、会话管理与主界面完全一致）；也可直接粘贴截图。",
              "This mirrors the main dsh session live. Questions go to the main agent (tools, approvals and session management match the main UI); paste screenshots directly."
            )}
          </div>
        ) : (
          transcript.map((m, i) => {
            const style = roleStyle[m.role] || { label: m.role, color: C.dim };
            return (
              <div key={i} style={{ marginBottom: 6 }}>
                <span style={{ marginRight: 6, fontSize: 11, color: style.color }}>{style.label}</span>
                <span
                  style={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    color: m.role === "tool" ? C.dim : m.role === "error" ? C.danger : C.text,
                    fontStyle: m.role === "tool" ? "italic" : "normal",
                  }}
                >
                  {m.text.length > 900 ? m.text.slice(0, 900) + "…" : m.text}
                </span>
              </div>
            );
          })
        )}
      </div>
      {err ? <div style={{ padding: "4px 12px", fontSize: 11.5, color: C.danger }}>{err}</div> : null}
      {notice ? <div style={{ padding: "4px 12px", fontSize: 11.5, color: C.ok }}>{notice}</div> : null}
      {pendingImage ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px 0" }}>
          <img src={pendingImage.dataUrl} alt="" style={{ height: 48, borderRadius: 4, border: `1px solid ${C.border}` }} />
          <span style={{ ...S.muted, fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {pendingImage.name}
          </span>
          <button style={{ ...S.btn, padding: "1px 8px" }} onClick={() => setPendingImage(null)}>✕</button>
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, padding: 10, borderTop: `1px solid ${C.border}` }}>
        <button style={{ ...S.btn, padding: "4px 8px" }} title={tr("附加图片（或直接 Ctrl+V 粘贴截图）", "Attach image (or Ctrl+V)")} onClick={() => imgFileRef.current && imgFileRef.current.click()}>
          📎
        </button>
        <input
          style={{ ...S.input, flex: 1 }}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) send();
          }}
          onPaste={onPaste}
          placeholder={tr("发送到主会话（可粘贴截图）", "Send to the main session (paste images)")}
        />
        <button style={S.btnPrimary} onClick={send}>{tr("发送", "Send")}</button>
        <input
          ref={imgFileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          style={{ display: "none" }}
          onChange={(e) => {
            readImage(e.target.files && e.target.files[0]);
            e.target.value = "";
          }}
        />
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
  const fmtUptime = (sec) => {
    if (sec === null || sec === undefined) return "—";
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    if (days > 0) return `${days}天${hours}时`;
    if (hours > 0) return `${hours}时${mins}分`;
    return `${mins}分`;
  };
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
        <span>
          ↓{fmtRate(rxRate)} ↑{fmtRate(txRate)}
          {m && m.tempC ? ` · ${m.tempC.toFixed(1)}°C` : ""}
        </span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.dim, marginTop: 3 }}>
        <span title={`${(m && m.hostname) || ""} ${(m && m.kernel) || ""}`}>
          {m && m.hostname ? m.hostname : "—"} · {m && m.kernel ? m.kernel : "—"}
        </span>
        <span title={m && m.users && m.users.length ? m.users.join(", ") : ""}>
          开机 {m ? fmtUptime(m.uptimeSec) : "—"} · 用户 {m && m.users ? m.users.length : 0}
          {m && m.sessions !== undefined ? ` · 会话 ${m.sessions}` : ""}
        </span>
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
    try {
      let queued = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f.size > 100 * 1024 * 1024) throw new Error("文件超过 100MB，暂不支持：" + f.name);
        const buf = new Uint8Array(await f.arrayBuffer());
        const d = await postJson("/transfers", {
          kind: "upload",
          sessionId,
          name: f.name,
          remotePath: joinPath(path, f.name),
          dataB64: bytesToB64(buf),
          policy: "overwrite",
        });
        if (!d || !d.ok) throw new Error((d && d.error) || "加入上传队列失败：" + f.name);
        queued += 1;
      }
      setMsg({ kind: "ok", text: `已加入 ${queued} 个上传任务（在「⇅ 传输」面板查看）` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e && e.message ? e.message : e) });
    } finally {
      setBusy(false);
    }
  }

  async function download(entry) {
    const full = joinPath(path, entry.name);
    try {
      const d = await postJson("/transfers", { kind: "download", sessionId, remotePath: full, name: entry.name, policy: "overwrite" });
      setMsg(
        d && d.ok
          ? { kind: "ok", text: "已加入下载队列（完成后在「⇅ 传输」面板保存到本机）" }
          : { kind: "err", text: (d && d.error) || "加入下载队列失败" }
      );
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    }
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

function AixtermApp({ hostCtx }) {
  const [sessions, setSessions] = useState([]);
  const [tabs, setTabs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [sessionMenu, setSessionMenu] = useState(null);
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
      return { fontSize: 13, theme: "dark", fontFamily: "", lineHeight: 1.15, highlights: [], lang: "zh", suggestions: true, gutter: "off", aiModelPolicy: "follow", aiProvider: "", aiModel: "", aiEffort: "", ...(JSON.parse(localStorage.getItem("aixterm.prefs") || "{}") || {}) };
    } catch {
      return { fontSize: 13, theme: "dark", fontFamily: "", lineHeight: 1.15, highlights: [], lang: "zh", suggestions: true, gutter: "off", aiModelPolicy: "follow", aiProvider: "", aiModel: "", aiEffort: "" };
    }
  });
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState("display");
  const [leftCollapsed, setLeftCollapsed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("aixterm.layout") || "{}").left === true;
    } catch {
      return false;
    }
  });
  const [rightTool, setRightTool] = useState("files");
  const [pinnedTools, setPinnedTools] = useState([]);

  function pinCurrentTool() {
    const id = rightTool;
    if (pinnedTools.some((p) => p.id === id)) return;
    setPinnedTools((prev) => [...prev, { id, sessionId: (activeTab && activeTab.sessionId) || "" }]);
  }

  function unpinTool(id) {
    setPinnedTools((prev) => prev.filter((p) => p.id !== id));
  }
  const [rightCollapsed, setRightCollapsed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("aixterm.layout") || "{}").right === true;
    } catch {
      return false;
    }
  });
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
  const [aiInitialAsk, setAiInitialAsk] = useState("");
  const [aiAskTarget, setAiAskTarget] = useState("");
  const [aiSessionOptions, setAiSessionOptions] = useState([]);
  const [modelProviders, setModelProviders] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(PREFIX + "/models");
        const d = await r.json();
        if (d && d.ok) setModelProviders(d.providers || []);
      } catch {
        /* models unavailable */
      }
    })();
  }, []);

  useEffect(() => {
    if (!hostCtx || typeof hostCtx.get !== "function") return undefined;
    let sessions;
    try {
      sessions = hostCtx.get("sessions");
    } catch {
      sessions = undefined;
    }
    if (!sessions || !sessions.list) return undefined;
    const read = () => {
      try {
        const snap = sessions.list.getSnapshot();
        const ids = (snap && snap.ids) || [];
        const byId = (snap && snap.byId) || {};
        setAiSessionOptions(
          ids.map((id) => ({
            id,
            title: (byId[id] && (byId[id].title || byId[id].name || byId[id].displayTitle)) || String(id).slice(0, 8),
          }))
        );
      } catch {
        /* snapshot unavailable */
      }
    };
    read();
    let unsub;
    try {
      unsub = sessions.list.subscribe ? sessions.list.subscribe(read) : undefined;
    } catch {
      unsub = undefined;
    }
    return () => {
      try {
        unsub && unsub();
      } catch {
        /* ignore */
      }
    };
  }, [hostCtx]);
  const [termSettings, setTermSettings] = useState({ saveScrollback: true, scrollbackDir: "", bufferLines: 2000, dataDir: "" });
  const [termSettingsMsg, setTermSettingsMsg] = useState(null);
  const recRef = useRef(null);
  const [recordingTerminal, setRecordingTerminal] = useState(null);
  const [macros, setMacros] = useState([]);
  const [showMacros, setShowMacros] = useState(false);
  const [showTransfers, setShowTransfers] = useState(false);
  const [macroEdit, setMacroEdit] = useState(null);
  const [macroMsg, setMacroMsg] = useState(null);
  const [layout, setLayout] = useState("single"); // single | hsplit | vsplit | quad
  const [paneIds, setPaneIds] = useState(["", "", ""]);
  const [lockInfo, setLockInfo] = useState({ locked: false, hasMaster: false, idleMinutes: 15 });
  const [tmuxFor, setTmuxFor] = useState(null);
  const [tmuxInfo, setTmuxInfo] = useState({ available: false, sessions: [] });
  const [tmuxName, setTmuxName] = useState("");
  const [tmuxMsg, setTmuxMsg] = useState(null);
  const [lockPw, setLockPw] = useState("");
  const [lockMsg, setLockMsg] = useState(null);
  const [newMaster, setNewMaster] = useState("");

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
        const r = await fetch(PREFIX + "/settings");
        const d = await r.json();
        if (d && d.ok) setTermSettings((prev) => ({ ...prev, ...d.settings }));
      } catch {
        /* settings unavailable */
      }
      try {
        const c = await fetch(PREFIX + "/config");
        const cfg = await c.json();
        if (cfg && cfg.ok) setTermSettings((prev) => ({ ...prev, version: cfg.version, repo: cfg.repo }));
      } catch {
        /* config unavailable */
      }
    })();
  }, []);

  async function setTermType(value) {
    try {
      const d = await postJson("/settings", { termType: value });
      if (d && d.ok) setTermSettings((prev) => ({ ...prev, termType: value }));
      else setTermSettingsMsg({ kind: "err", text: (d && d.error) || "保存失败" });
    } catch (e) {
      setTermSettingsMsg({ kind: "err", text: String(e) });
    }
  }

  async function saveTermSettings() {
    setTermSettingsMsg(null);
    try {
      const d = await postJson("/settings", {
        saveScrollback: termSettings.saveScrollback,
        scrollbackDir: termSettings.scrollbackDir || "",
        bufferLines: Number(termSettings.bufferLines) || 2000,
      });
      if (d && d.ok) {
        setTermSettings((prev) => ({ ...prev, ...d.settings }));
        setTermSettingsMsg({ kind: "ok", text: "已保存" });
      } else {
        setTermSettingsMsg({ kind: "err", text: (d && d.error) || "保存失败" });
      }
    } catch (e) {
      setTermSettingsMsg({ kind: "err", text: String(e) });
    }
  }

  const refreshLock = useCallback(async () => {
    try {
      const r = await fetch(PREFIX + "/lock/status");
      const d = await r.json();
      if (d && d.ok) setLockInfo({ locked: Boolean(d.locked), hasMaster: Boolean(d.hasMaster), idleMinutes: d.idleMinutes });
    } catch {
      /* lock status unavailable */
    }
  }, []);

  useEffect(() => {
    refreshLock();
    const timer = setInterval(refreshLock, 30000);
    return () => clearInterval(timer);
  }, [refreshLock]);

  const loadMacros = useCallback(async () => {
    try {
      const r = await fetch(PREFIX + "/macros");
      const d = await r.json();
      if (d && d.ok) setMacros(d.macros || []);
    } catch {
      /* macros unavailable */
    }
  }, []);

  useEffect(() => {
    loadMacros();
  }, [loadMacros]);

  useEffect(() => {
    const hide = () => setSessionMenu(null);
    document.addEventListener("click", hide);
    return () => document.removeEventListener("click", hide);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("aixterm.layout", JSON.stringify({ left: leftCollapsed, right: rightCollapsed }));
    } catch {
      /* storage unavailable */
    }
  }, [leftCollapsed, rightCollapsed]);

  // Report user activity so idle auto-lock measures real inactivity.
  useEffect(() => {
    let last = Date.now();
    const onActivity = () => {
      last = Date.now();
    };
    window.addEventListener("mousemove", onActivity);
    window.addEventListener("keydown", onActivity);
    const timer = setInterval(() => {
      if (Date.now() - last < 120000) postJson("/lock/touch", {}).catch(() => {});
    }, 60000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, []);

  async function unlockNow() {
    setLockMsg(null);
    try {
      const d = await postJson("/lock/unlock", { password: lockPw });
      if (d && d.ok) {
        setLockPw("");
        await refreshLock();
      } else {
        setLockMsg("密码错误");
      }
    } catch (e) {
      setLockMsg(String(e));
    }
  }

  async function lockNow() {
    try {
      await postJson("/lock/lock", {});
      await refreshLock();
    } catch {
      /* ignore */
    }
  }

  async function setupMaster() {
    if (!newMaster || newMaster.length < 4) {
      setLockMsg("主密码至少 4 位");
      return;
    }
    try {
      const d = await postJson("/lock/setup", { password: newMaster, idleMinutes: lockInfo.idleMinutes });
      if (d && d.ok) {
        setNewMaster("");
        setLockMsg(null);
        await refreshLock();
      } else {
        setLockMsg((d && d.error) || "设置失败");
      }
    } catch (e) {
      setLockMsg(String(e));
    }
  }

  async function setIdleMinutes(minutes) {
    try {
      await postJson("/lock/idle", { minutes });
      await refreshLock();
    } catch {
      /* ignore */
    }
  }

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
  const extraSlots = layout === "quad" ? 3 : layout === "single" ? 0 : 1;
  const assigned = new Set([activeId, ...paneIds.slice(0, extraSlots)].filter(Boolean));
  const mainTabs = tabs.filter((t) => t.id === activeId || !assigned.has(t.id));

  async function openTerminal(session, tmuxNameArg) {
    // Focus an existing tab for the same session instead of opening a duplicate.
    if (session && !tmuxNameArg) {
      const existing = tabs.find((t) => t.sessionId === session.id);
      if (existing) {
        setActiveId(existing.id);
        return;
      }
    }
    setBusy(true);
    setMsg(null);
    try {
      const body = session
        ? { sessionId: session.id, cols: 120, rows: 30, ...(tmuxNameArg ? { tmuxName: tmuxNameArg } : {}) }
        : { cols: 120, rows: 30 };
      const d = await postJson("/term/open", body);
      if (!d || !d.ok) {
        setMsg({ kind: "err", text: (d && d.error) || "打开终端失败" });
        return;
      }
      const tab = {
        id: d.terminalId,
        sessionId: session ? session.id : null,
        kind: d.kind || (session ? "ssh" : "local"),
        title: session ? (tmuxNameArg ? `${session.name} · tmux:${tmuxNameArg}` : session.name) : "本地终端",
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

  function tr(zh, en) {
    return prefs.lang === "en" ? en : zh;
  }

  function updateHighlight(index, patchObj) {
    const list = (prefs.highlights || []).map((r, i) => (i === index ? { ...r, ...patchObj } : r));
    updatePrefs({ highlights: list });
  }

  function addHighlight() {
    updatePrefs({ highlights: [...(prefs.highlights || []), { pattern: "", color: "#ff5555" }] });
  }

  function removeHighlight(index) {
    updatePrefs({ highlights: (prefs.highlights || []).filter((_, i) => i !== index) });
  }

  function handleInput(sourceId, data) {
    const rec = recRef.current;
    if (rec && rec.terminalId === sourceId) {
      for (const ch of String(data)) {
        if (ch === "\r" || ch === "\n") {
          const line = rec.current.trim();
          if (line) rec.lines.push(line);
          rec.current = "";
        } else if (ch === "\x7f" || ch === "\b") {
          rec.current = rec.current.slice(0, -1);
        } else if (ch === "\x03") {
          rec.current = "";
        } else if (ch >= " ") {
          rec.current += ch;
        }
      }
    }
    const targets = broadcast ? tabs.map((t) => t.id) : [sourceId];
    for (const id of targets) {
      postJson("/term/input", { terminalId: id, data }).catch(() => {});
    }
  }

  function handleAiAsk(question, target) {
    setAiInitialAsk(question);
    setAiAskTarget(target || "");
    setShowAi(true);
  }

  function cycleLayout() {
    const order = ["single", "hsplit", "vsplit", "quad"];
    const next = order[(order.indexOf(layout) + 1) % order.length];
    setLayout(next);
    if (next !== "single") {
      const others = tabs.filter((t) => t.id !== (activeId || ""));
      const needed = next === "quad" ? 3 : 1;
      const filled = [0, 1, 2].map((i) => paneIds[i] || (i < needed && others[i] ? others[i].id : ""));
      setPaneIds(filled);
    }
  }

  function disconnectSession(id) {
    const owned = tabs.filter((t) => t.sessionId === id);
    if (!owned.length) {
      setMsg({ kind: "ok", text: "该会话当前未连接" });
      return;
    }
    for (const t of owned) closeTab(t.id);
    setMsg({ kind: "ok", text: "已断开会话" });
  }

  function toggleRecord(terminalId) {
    if (recRef.current) {
      const rec = recRef.current;
      recRef.current = null;
      setRecordingTerminal(null);
      const steps = [...rec.lines];
      if (rec.current.trim()) steps.push(rec.current.trim());
      if (!steps.length) {
        setMsg({ kind: "ok", text: "没有录制到命令" });
        return;
      }
      const name = window.prompt("保存宏名称", "宏 " + new Date().toLocaleTimeString());
      if (!name) return;
      postJson("/macros", { name, steps })
        .then((d) => {
          if (d && d.ok) {
            loadMacros();
            setMsg({ kind: "ok", text: `已保存宏「${name}」（${steps.length} 条命令）` });
          } else {
            setMsg({ kind: "err", text: (d && d.error) || "保存最终宏失败" });
          }
        })
        .catch((e) => setMsg({ kind: "err", text: String(e) }));
    } else {
      recRef.current = { terminalId, lines: [], current: "" };
      setRecordingTerminal(terminalId);
      setMsg({ kind: "ok", text: "录制中…在终端执行的命令会被记录，再次点录制结束" });
    }
  }

  function openMacros() {
    setShowMacros(true);
    setMacroMsg(null);
    setMacroEdit(null);
    loadMacros();
  }

  async function saveMacro() {
    if (!macroEdit) return;
    const steps = (macroEdit.stepsText || "")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!macroEdit.name) {
      setMacroMsg({ kind: "err", text: "请填写宏名称" });
      return;
    }
    if (!steps.length) {
      setMacroMsg({ kind: "err", text: "至少需要一条命令" });
      return;
    }
    try {
      const d = await postJson("/macros", {
        id: macroEdit.id || undefined,
        name: macroEdit.name,
        description: macroEdit.description || "",
        steps,
      });
      if (d && d.ok) {
        setMacroEdit(null);
        setMacroMsg({ kind: "ok", text: "已保存" });
        await loadMacros();
      } else {
        setMacroMsg({ kind: "err", text: (d && d.error) || "保存失败" });
      }
    } catch (e) {
      setMacroMsg({ kind: "err", text: String(e) });
    }
  }

  async function deleteMacro(macro) {
    if (!window.confirm(`删除宏「${macro.name}」？`)) return;
    try {
      const d = await postJson("/macros/delete", { id: macro.id });
      if (d && d.ok) await loadMacros();
    } catch {
      /* ignore */
    }
  }

  function executeMacro(macro) {
    const tab = activeTab;
    if (!tab) {
      setMacroMsg({ kind: "err", text: "先打开一个终端再执行宏" });
      return;
    }
    const steps = macro.steps || [];
    const delay = Number(macro.delayMs) > 0 ? Number(macro.delayMs) : 500;
    steps.forEach((line, i) => {
      setTimeout(() => {
        postJson("/term/input", { terminalId: tab.id, data: line + "\r" }).catch(() => {});
      }, i * delay);
    });
    setMacroMsg({ kind: "ok", text: `已执行「${macro.name}」（${steps.length} 条）` });
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
      const d = await postJson("/import", { format: "auto", filename: file.name, data: text });
      if (!d || !d.ok) throw new Error((d && d.error) || "导入失败");
      setIoMsg({ kind: "ok", text: `已导入 ${d.created} 个会话${d.skipped ? `，跳过 ${d.skipped} 个重复` : ""}` });
      await loadSessions();
    } catch (e) {
      setIoMsg({ kind: "err", text: String(e.message || e) });
    }
  }

  async function openTmux(session) {
    setTmuxFor(session);
    setTmuxMsg(null);
    setTmuxName("");
    await loadTmux(session.id);
  }

  async function loadTmux(sessionId) {
    try {
      const r = await fetch(PREFIX + "/tmux?sessionId=" + encodeURIComponent(sessionId));
      const d = await r.json();
      if (d && d.ok) setTmuxInfo({ available: Boolean(d.available), sessions: d.sessions || [] });
      else setTmuxMsg((d && d.error) || "读取 tmux 失败");
    } catch (e) {
      setTmuxMsg(String(e));
    }
  }

  async function tmuxOp(op, name) {
    if (!tmuxFor) return;
    try {
      const d = await postJson("/tmux", { sessionId: tmuxFor.id, op, name });
      if (d && d.ok) {
        await loadTmux(tmuxFor.id);
        return true;
      }
      setTmuxMsg((d && d.error) || op + " 失败");
    } catch (e) {
      setTmuxMsg(String(e));
    }
    return false;
  }

  async function createTmux() {
    if (!tmuxName) {
      setTmuxMsg("请填写会话名");
      return;
    }
    if (await tmuxOp("new", tmuxName)) {
      setTmuxName("");
      setTmuxMsg(null);
    }
  }

  async function killTmux(name) {
    if (!window.confirm("关闭 tmux 会话 " + name + "？")) return;
    await tmuxOp("kill", name);
  }

  function enterTmux(name) {
    const session = tmuxFor;
    setTmuxFor(null);
    if (session) openTerminal(session, name);
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

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowCreate(true);
  }

  function openEdit(session) {
    const auth = session.auth || {};
    setEditingId(session.id);
    setForm({
      ...EMPTY_FORM,
      kind: session.kind || "ssh",
      name: session.name || "",
      group: session.group || "",
      host: session.host || "",
      port: String(session.port || 22),
      user: session.user || "",
      authKind: auth.kind || "password",
      keyPath: auth.keyPath || "",
      keyId: auth.keyId || "",
      credentialEnv: auth.credentialEnv || "",
      proxyJump: session.proxyJump || "",
      x11: Boolean(session.x11),
      serialPath: (session.serial && session.serial.path) || "",
      baudRate: String((session.serial && session.serial.baudRate) || 115200),
      dataBits: String((session.serial && session.serial.dataBits) || 8),
      stopBits: String((session.serial && session.serial.stopBits) || 1),
      parity: (session.serial && session.serial.parity) || "none",
    });
    setShowCreate(true);
  }

  async function createSession() {
    if (form.kind === "serial") {
      if (!form.serialPath) {
        setMsg({ kind: "err", text: "串口设备路径必填" });
        return;
      }
    } else if (form.kind === "telnet") {
      if (!form.host) {
        setMsg({ kind: "err", text: "主机必填" });
        return;
      }
    } else if (!form.host || !form.user) {
      setMsg({ kind: "err", text: "主机和用户名必填" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const url = editingId ? "/sessions/update" : "/sessions";
      const base = editingId ? { id: editingId } : {};
      if (form.kind === "telnet") {
        const d = await postJson(url, {
          ...base,
          kind: "telnet",
          name: form.name || form.host,
          group: form.group || "默认",
          host: form.host,
          port: Number(form.port) || 23,
        });
        if (d && d.ok) {
          setShowCreate(false);
          setEditingId(null);
          setForm(EMPTY_FORM);
          await loadSessions();
          if (!editingId && d.session) openTerminal(d.session);
        } else {
          setMsg({ kind: "err", text: (d && d.error) || "保存失败" });
        }
        return;
      }
      if (form.kind === "serial") {
        const d = await postJson(url, {
          ...base,
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
          setEditingId(null);
          setForm(EMPTY_FORM);
          await loadSessions();
          if (!editingId && d.session) openTerminal(d.session);
        } else {
          setMsg({ kind: "err", text: (d && d.error) || "保存失败" });
        }
        return;
      }
      const body = {
        ...base,
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
      } else if (form.authKind === "password") {
        // Empty password while editing keeps the stored one.
        if (form.password) body.password = form.password;
        if (form.credentialEnv) body.auth.credentialEnv = form.credentialEnv;
      }
      if (form.proxyJump) body.proxyJump = form.proxyJump;
      const d = await postJson(url, body);
      if (d && d.ok) {
        setShowCreate(false);
        setEditingId(null);
        setForm(EMPTY_FORM);
        await loadSessions();
        if (!editingId && d.session) openTerminal(d.session);
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

  // Group sessions: connected (live) sessions go into a leading "active" group;
  // the rest keep their own group (default 默认).
  const ACTIVE_GROUP = "__active__";
  const groups = [];
  const ql = sessionQuery.trim().toLowerCase();
  for (const s of sessions) {
    if (ql) {
      const hay = `${s.name || ""} ${s.host || ""} ${s.user || ""} ${s.group || ""}`.toLowerCase();
      if (!hay.includes(ql)) continue;
    }
    const connected = tabs.some((t) => t.sessionId === s.id);
    const g = connected ? ACTIVE_GROUP : s.group || "默认";
    let bucket = groups.find((x) => x.name === g);
    if (!bucket) {
      bucket = { name: g, items: [] };
      groups.push(bucket);
    }
    bucket.items.push(s);
  }
  groups.sort((a, b) => (a.name === ACTIVE_GROUP ? -1 : b.name === ACTIVE_GROUP ? 1 : 0));

  function renderPane(index) {
    const isMain = index === 0;
    const terminalId = isMain ? activeId : paneIds[index - 1];
    const paneTab = tabs.find((t) => t.id === terminalId) || null;
    const used = new Set([activeId, ...paneIds.slice(0, extraSlots)].filter(Boolean));
    const borderStyle = {
      borderLeft: !isMain && (layout === "hsplit" || (layout === "quad" && index % 2 === 1)) ? `1px solid ${C.border}` : "none",
      borderTop: !isMain && (layout === "vsplit" || (layout === "quad" && index >= 2)) ? `1px solid ${C.border}` : "none",
    };
    return (
      <div
        key={index}
        style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", ...borderStyle }}
      >
        {!isMain ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", borderBottom: `1px solid ${C.border}`, background: C.panel }}>
            <select
              style={{ ...S.input, flex: 1, padding: "2px 6px", fontSize: 11 }}
              value={terminalId || ""}
              onChange={(e) => {
                const next = [...paneIds];
                next[index - 1] = e.target.value;
                setPaneIds(next);
              }}
            >
              <option value="">选择终端…</option>
              {tabs
                .filter((t) => t.id === terminalId || !used.has(t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
          </div>
        ) : null}
        <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex" }}>
          {isMain ? (
            tabs.length === 0 ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: C.dim }}>
                <div style={{ fontSize: 40, opacity: 0.5 }}>▚</div>
                <div style={{ fontSize: 13 }}>{tr("选择左侧会话，或打开一个本地终端", "Pick a session on the left, or open a local terminal")}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={S.btnPrimary} onClick={() => openTerminal(null)} disabled={busy}>{tr("打开本地终端", "Open local terminal")}</button>
                  <button style={S.btn} onClick={openCreate}>{tr("新建 SSH 会话", "New SSH session")}</button>
                </div>
              </div>
            ) : (
              mainTabs.map((t) => (
                <TerminalPane
                  key={t.id}
                  terminalId={t.id}
                  sessionId={t.sessionId || ""}
                  active={t.id === activeId}
                  visible={t.id === activeId}
                  sessionOptions={aiSessionOptions}
                  onAiAsk={handleAiAsk}
                  prefs={prefs}
                  onInput={(data) => handleInput(t.id, data)}
                  onCwd={(p) => setCwdByTerminal((prev) => (prev[t.id] === p ? prev : { ...prev, [t.id]: p }))}
                />
              ))
            )
          ) : paneTab ? (
            <TerminalPane
              key={paneTab.id}
              terminalId={paneTab.id}
              sessionId={paneTab.sessionId || ""}
              active={false}
              visible={true}
              sessionOptions={aiSessionOptions}
              onAiAsk={handleAiAsk}
              prefs={prefs}
              onInput={(data) => handleInput(paneTab.id, data)}
              onCwd={(p) => setCwdByTerminal((prev) => (prev[paneTab.id] === p ? prev : { ...prev, [paneTab.id]: p }))}
            />
          ) : (
            <div style={{ ...S.muted, margin: "auto", fontSize: 12, textAlign: "center", padding: 12 }}>选择上方终端</div>
          )}
        </div>
      </div>
    );
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
      <aside
        style={{
          width: leftCollapsed ? 34 : 250,
          flex: leftCollapsed ? "0 0 34px" : "0 0 250px",
          borderRight: `1px solid ${C.border}`,
          background: C.panel,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {leftCollapsed ? (
          <button
            style={{ ...S.btn, margin: "10px auto", padding: "4px 6px", fontSize: 12 }}
            title={tr("展开连接列表", "Expand sessions")}
            onClick={() => setLeftCollapsed(false)}
          >
            »
          </button>
        ) : null}
        {leftCollapsed ? null : (
          <>
        <div style={{ padding: "10px 12px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: 0.2 }}>{tr("连接", "Sessions")}</span>
          <div style={{ display: "flex", gap: 6 }}>
            {lockInfo.hasMaster ? (
              <button style={S.btn} title="立即锁定" onClick={lockNow}>🔒</button>
            ) : null}
            <button style={S.btn} title="SSH 密钥管理" onClick={openKeys}>🔑</button>
            <button style={S.btn} title="导入 / 导出会话" onClick={() => setShowIO(true)}>⇅</button>
            <button style={S.btnPrimary} onClick={openCreate}>{tr("+ 新建", "+ New")}</button>
            <button style={S.btn} title={tr("收起连接列表", "Collapse sessions")} onClick={() => setLeftCollapsed(true)}>
              «
            </button>
          </div>
        </div>

        <div style={{ padding: "8px 10px" }}>
          <button style={{ ...S.btn, width: "100%", textAlign: "left", padding: "7px 10px" }} onClick={() => openTerminal(null)} disabled={busy}>
            <span style={{ color: C.accent, marginRight: 6 }}>▸</span> {tr("本地终端", "Local terminal")}
          </button>
        </div>
        <div style={{ padding: "0 10px 8px" }}>
          <input
            style={S.input}
            value={sessionQuery}
            onChange={(e) => setSessionQuery(e.target.value)}
            placeholder={tr("搜索会话（名称/主机/用户/分组）", "Search sessions (name/host/user/group)")}
          />
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "0 8px 8px" }}>
          {groups.length === 0 ? (
            <div style={{ ...S.muted, padding: "10px 6px", lineHeight: 1.6 }}>
              {tr("还没有连接。点「新建」添加 SSH 会话，或直接打开本地终端。", "No sessions yet. Use + New to add an SSH session, or open a local terminal.")}
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.name} style={{ marginBottom: 8 }}>
                <div style={{ ...S.muted, padding: "6px 6px 4px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>
                  {g.name === ACTIVE_GROUP ? tr("活跃", "Active") : g.name}
                </div>
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
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSessionMenu({ session: s, x: e.clientX, y: e.clientY });
                      }}
                    >
                      {(() => {
                        const connected = tabs.some((t) => t.sessionId === s.id);
                        return (
                          <span
                            title={connected ? tr("已连接", "Connected") : tr("未连接（仅保存的配置）", "Not connected (saved entry)")}
                            style={{ color: isActive ? C.ok : connected ? C.accent : C.dim, fontSize: 11 }}
                          >
                            {connected ? "●" : "○"}
                          </span>
                        );
                      })()}
                      <div
                        style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={(() => {
                          const conn = tabs.some((t) => t.sessionId === s.id);
                          const detail =
                            s.kind === "serial"
                              ? `${(s.serial && s.serial.path) || "串口"} @ ${(s.serial && s.serial.baudRate) || ""}`
                              : s.kind === "telnet"
                                ? `telnet ${s.host}:${s.port}`
                                : `${s.user}@${s.host}:${s.port}`;
                          const extra = [
                            tr("名称", "Name") + "：" + s.name,
                            detail,
                            (s.group ? tr("分组", "Group") + "：" + s.group : ""),
                            (conn ? tr("已连接", "Connected") : tr("未连接", "Not connected")),
                          ]
                            .filter(Boolean)
                            .join("\n");
                          return extra;
                        })()}
                      >
                        {s.name}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {msg ? <div style={{ padding: "8px 12px", fontSize: 12, color: msgColor, borderTop: `1px solid ${C.border}` }}>{msg.text}</div> : null}
          </>
        )}
      </aside>

      {/* center: tabs + terminals */}
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, position: "relative" }}>
        <div style={{ display: "flex", alignItems: "stretch", borderBottom: `1px solid ${C.border}`, background: C.panel, minHeight: 38, overflowX: "auto" }}>
          {tabs.length === 0 ? (
            <div style={{ ...S.muted, padding: "0 12px", display: "flex", alignItems: "center" }}>{tr("未打开终端", "No terminal open")}</div>
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
            <label style={{ ...S.muted, display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, cursor: "pointer" }} title={tr("把输入同时发送到所有已打开终端", "Send input to every open terminal")}>
              <input type="checkbox" checked={broadcast} onChange={(e) => setBroadcast(e.target.checked)} />
              {tr("同步输入", "Broadcast")}
            </label>
            <button
              style={{ ...S.btn, padding: "3px 8px", fontSize: 11.5 }}
              title={tr("分屏：单屏 → 左右双屏 → 上下双屏 → 四屏 → 单屏", "Split: single -> side-by-side -> stacked -> quad -> single")}
              onClick={cycleLayout}
            >
              {tr("分屏", "Split")}{layout === "hsplit" ? " ⇆" : layout === "vsplit" ? " ⇅" : layout === "quad" ? " ⊞" : ""}
            </button>
            <button style={{ ...S.btn, padding: "3px 8px", fontSize: 11.5 }} title={tr("宏管理", "Macros")} onClick={openMacros}>
              {tr("宏", "Macros")}
            </button>
            {activeTab ? (
              <button
                style={{
                  ...S.btn,
                  padding: "3px 8px",
                  fontSize: 11.5,
                  color: recordingTerminal === activeTab.id ? C.danger : C.text,
                }}
                title={tr("录制/停止录制当前终端的命令", "Record/stop recording commands in this terminal")}
                onClick={() => toggleRecord(activeTab.id)}
              >
                {recordingTerminal === activeTab.id ? tr("■ 停止录制", "■ Stop") : tr("● 录制", "● Record")}
              </button>
            ) : null}
            <button style={{ ...S.btn, padding: "3px 8px", fontSize: 11.5 }} title={tr("AI 助手（基于当前终端上下文）", "AI assistant (terminal context)")} onClick={() => setShowAi((v) => !v)}>
              ✦ AI
            </button>
            <button style={{ ...S.btn, padding: "3px 8px", fontSize: 11.5 }} title={tr("终端设置", "Terminal settings")} onClick={() => setShowSettings(true)}>
              ⚙ {tr("设置", "Settings")}
            </button>
          </div>
        </div>

        {layout === "quad" ? (
          <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr" }}>
            {[0, 1, 2, 3].map((index) => renderPane(index))}
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: layout === "vsplit" ? "column" : "row",
            }}
          >
            {renderPane(0)}
            {layout !== "single" ? renderPane(1) : null}
          </div>
        )}

        {showAi && activeTab ? (
          <AiPanel
            hostCtx={hostCtx}
            lang={prefs.lang}
            sessionId={activeTab.sessionId}
            terminalId={activeTab.id}
            cwd={cwdByTerminal[activeTab.id]}
            initialPrompt={aiInitialAsk}
            initialSessionTarget={aiAskTarget}
            aiModelPolicy={prefs.aiModelPolicy}
            aiProvider={prefs.aiProvider}
            aiModel={prefs.aiModel}
            aiEffort={prefs.aiEffort}
            onInitialConsumed={() => {
              setAiInitialAsk("");
              setAiAskTarget("");
            }}
            onClose={() => setShowAi(false)}
          />
        ) : null}
      </main>

      {/* right: tool rail (always visible on the far right) + collapsible content */}
      {activeTab && activeTab.kind === "ssh" && activeTab.sessionId ? (
        <aside
          style={{
            flex: "0 0 auto",
            borderLeft: `1px solid ${C.border}`,
            background: C.panel,
            display: "flex",
            flexDirection: "row",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: rightCollapsed ? 0 : 340,
              flex: "0 0 auto",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            {rightCollapsed ? null : (
              <div style={{ width: 340, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                {rightTool === "monitor" ? (
                  <MonitorPanel sessionId={activeTab.sessionId} />
                ) : rightTool === "files" ? (
                  <SftpPanel key={activeTab.sessionId} sessionId={activeTab.sessionId} followPath={cwdByTerminal[activeTab.id]} />
                ) : (
                  <ToolPlaceholder tool={rightTool} />
                )}
              </div>
            )}
          </div>
          <div
            style={{
              width: 36,
              flex: "0 0 36px",
              borderLeft: `1px solid ${C.border}`,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              paddingTop: 4,
            }}
          >
            <button
              style={{ ...S.btn, margin: "0 0 8px", padding: "1px 5px", fontSize: 11 }}
              title={rightCollapsed ? tr("展开工具面板", "Expand tools") : tr("收起工具面板", "Collapse tools")}
              onClick={() => setRightCollapsed((v) => !v)}
            >
              {rightCollapsed ? "«" : "»"}
            </button>
            {RIGHT_TOOLS.map((t) => {
              const selected = rightTool === t.id;
              return (
                <button
                  key={t.id}
                  title={t.label}
                  onClick={() => {
                    setRightTool(t.id);
                    setRightCollapsed(false);
                  }}
                  style={{
                    border: "none",
                    background: selected ? C.accentBg : "rgba(255,255,255,0.07)",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 16,
                    padding: "6px 4px",
                    margin: "2px 0",
                    position: "relative",
                    lineHeight: 1,
                  }}
                >
                  {selected ? <span style={{ position: "absolute", left: -1, top: 5, bottom: 5, width: 3, borderRadius: 2, background: C.accent }} /> : null}
                  {t.icon}
                </button>
              );
            })}
            <button
              style={{ ...S.btn, marginTop: 8, padding: "1px 5px", fontSize: 11 }}
              title={tr("把当前工具弹出为浮动窗口", "Pop the current tool out as a floating window")}
              onClick={pinCurrentTool}
            >
              ⧉
            </button>
          </div>
        </aside>
      ) : null}

      {/* session context menu */}
      {sessionMenu ? (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            left: Math.min(sessionMenu.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 180),
            top: Math.min(sessionMenu.y, (typeof window !== "undefined" ? window.innerHeight : 800) - 250),
            zIndex: 70,
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: 4,
            minWidth: 150,
            boxShadow: "0 10px 30px rgba(0,0,0,.55)",
          }}
        >
          {(() => {
            const connected = tabs.some((t) => t.sessionId === sessionMenu.session.id);
            return [
              [tr("连接会话", "Connect"), () => openTerminal(sessionMenu.session)],
              [tr("断开会话", "Disconnect"), () => disconnectSession(sessionMenu.session.id), false, !connected],
              [tr("编辑配置", "Edit"), () => openEdit(sessionMenu.session)],
            [tr("复制会话", "Duplicate"), () => duplicateSession(sessionMenu.session.id)],
            [tr("tmux 会话", "tmux sessions"), () => openTmux(sessionMenu.session)],
            [tr("端口转发", "Port forwarding"), () => openForwards(sessionMenu.session)],
            [tr("导出日志", "Export log"), () => exportLog(sessionMenu.session.id, "html")],
              [tr("测试连接", "Test connection"), () => testSession(sessionMenu.session.id)],
              [tr("删除会话", "Delete"), () => removeSession(sessionMenu.session.id), true],
            ];
          })().map(([label, fn, danger, disabled]) => (
            <div
              key={label}
              onClick={() => {
                if (disabled) return;
                setSessionMenu(null);
                fn();
              }}
              onMouseEnter={(e) => {
                if (!disabled) e.currentTarget.style.background = C.hover;
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{
                padding: "5px 10px",
                fontSize: 12,
                cursor: disabled ? "default" : "pointer",
                borderRadius: 4,
                color: danger ? C.danger : C.text,
                opacity: disabled ? 0.4 : 1,
              }}
            >
              {label}
            </div>
          ))}
        </div>
      ) : null}

      {/* floating pinned tools */}
      {pinnedTools.map((p, i) => (
        <FloatingTool key={p.id} tool={p.id} sessionId={p.sessionId} index={i} onClose={() => unpinTool(p.id)} />
      ))}

      {/* lock overlay */}
      {lockInfo.locked ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 100,
            background: "rgba(5,8,12,0.94)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div style={{ fontSize: 40, opacity: 0.7 }}>🔒</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>会话已锁定</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{ ...S.input, width: 220 }}
              type="password"
              autoFocus
              value={lockPw}
              onChange={(e) => setLockPw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") unlockNow();
              }}
              placeholder="输入主密码解锁"
            />
            <button style={S.btnPrimary} onClick={unlockNow}>解锁</button>
          </div>
          {lockMsg ? <div style={{ color: C.danger, fontSize: 12 }}>{lockMsg}</div> : null}
        </div>
      ) : null}

      {/* transfer modal */}
      {showTransfers ? <TransferPanel onClose={() => setShowTransfers(false)} /> : null}

      {/* macro modal */}
      {showMacros ? (
        <div
          onClick={() => setShowMacros(false)}
          style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 600, maxWidth: "94%", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>宏（录制 / 执行）</div>
            {!macroEdit ? (
              <>
                {macros.length === 0 ? (
                  <div style={{ ...S.muted, marginBottom: 10 }}>还没有宏。点终端标签栏的「● 录制」录制命令，或手动新建。</div>
                ) : (
                  macros.map((m) => (
                    <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 8px", marginBottom: 6, fontSize: 12 }}>
                      <span style={{ flex: 1 }}>
                        <b>{m.name}</b> <span style={S.muted}>· {m.steps.length} 条{m.description ? ` · ${m.description}` : ""}</span>
                      </span>
                      <button style={{ ...S.btnPrimary, padding: "1px 8px", fontSize: 11 }} onClick={() => executeMacro(m)}>
                        执行
                      </button>
                      <button style={{ ...S.btn, padding: "1px 8px", fontSize: 11 }} onClick={() => setMacroEdit({ id: m.id, name: m.name, description: m.description || "", stepsText: m.steps.join("\n") })}>
                        编辑
                      </button>
                      <button style={{ ...S.btn, padding: "1px 8px", fontSize: 11, color: C.danger }} onClick={() => deleteMacro(m)}>
                        删除
                      </button>
                    </div>
                  ))
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button style={S.btn} onClick={() => setMacroEdit({ id: "", name: "", description: "", stepsText: "" })}>
                    手动新建
                  </button>
                </div>
              </>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={S.muted}>名称</span>
                  <input style={S.input} value={macroEdit.name} onChange={(e) => setMacroEdit((m) => ({ ...m, name: e.target.value }))} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={S.muted}>说明（可选）</span>
                  <input style={S.input} value={macroEdit.description} onChange={(e) => setMacroEdit((m) => ({ ...m, description: e.target.value }))} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / span 2" }}>
                  <span style={S.muted}>命令（每行一条，按顺序发送）</span>
                  <textarea
                    value={macroEdit.stepsText}
                    onChange={(e) => setMacroEdit((m) => ({ ...m, stepsText: e.target.value }))}
                    spellCheck={false}
                    style={{ height: 160, background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: 8, fontFamily: "ui-monospace, monospace", fontSize: 12, resize: "vertical" }}
                    placeholder={"cd /opt/app\nmake install"}
                  />
                </label>
                <div style={{ gridColumn: "1 / span 2", display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button style={S.btn} onClick={() => setMacroEdit(null)}>取消</button>
                  <button style={S.btnPrimary} onClick={saveMacro}>保存</button>
                </div>
              </div>
            )}
            {macroMsg ? (
              <div style={{ marginTop: 8, fontSize: 12, color: macroMsg.kind === "err" ? C.danger : C.ok }}>{macroMsg.text}</div>
            ) : null}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button style={S.btn} onClick={() => setShowMacros(false)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* tmux modal */}
      {tmuxFor ? (
        <div
          onClick={() => setTmuxFor(null)}
          style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 560, maxWidth: "94%", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
              tmux 会话 · {tmuxFor.name}
            </div>
            {!tmuxInfo.available ? (
              <div style={{ ...S.muted, marginBottom: 10 }}>
                远端未安装 tmux（可用 opkg/apt 安装后重试）
              </div>
            ) : tmuxInfo.sessions.length === 0 ? (
              <div style={{ ...S.muted, marginBottom: 10 }}>没有运行中的 tmux 会话</div>
            ) : (
              <div style={{ marginBottom: 10 }}>
                {tmuxInfo.sessions.map((t) => (
                  <div key={t.name} style={{ display: "flex", alignItems: "center", gap: 8, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 8px", marginBottom: 6, fontSize: 12 }}>
                    <span style={{ flex: 1 }}>
                      <b>{t.name}</b> <span style={S.muted}>· {t.windows} 窗口 · {t.attached} 附加</span>
                    </span>
                    <button style={{ ...S.btnPrimary, padding: "1px 8px", fontSize: 11 }} onClick={() => enterTmux(t.name)}>
                      进入
                    </button>
                    <button style={{ ...S.btn, padding: "1px 8px", fontSize: 11, color: C.danger }} onClick={() => killTmux(t.name)}>
                      关闭
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <input
                style={{ ...S.input, flex: 1 }}
                value={tmuxName}
                onChange={(e) => setTmuxName(e.target.value)}
                placeholder="新会话名（字母/数字/._-）"
              />
              <button style={S.btn} onClick={createTmux} disabled={!tmuxInfo.available}>
                新建
              </button>
              <button style={S.btn} onClick={() => loadTmux(tmuxFor.id)}>刷新</button>
            </div>
            {tmuxMsg ? <div style={{ color: C.danger, fontSize: 12, marginTop: 8 }}>{tmuxMsg}</div> : null}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button style={S.btn} onClick={() => setTmuxFor(null)}>关闭</button>
            </div>
          </div>
        </div>
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
            style={{
              width: 560,
              maxWidth: "94%",
              maxHeight: "80vh",
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{tr("终端设置", "Terminal settings")}</span>
              <button style={{ ...S.btn, padding: "1px 8px" }} onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <div style={{ display: "flex", gap: 4, padding: "8px 12px 0", borderBottom: `1px solid ${C.border}`, overflowX: "auto", flex: "0 0 auto" }}>
              {[
                ["display", "显示", "Display"],
                ["ai", "AI", "AI"],
                ["highlight", "高亮", "Highlighting"],
                ["security", "安全", "Security"],
                ["storage", "存储", "Storage"],
                ["about", "关于", "About"],
              ].map(([key, zh, en]) => (
                <button
                  key={key}
                  onClick={() => setSettingsTab(key)}
                  style={{
                    ...(settingsTab === key ? S.btnPrimary : S.btn),
                    borderBottomLeftRadius: 0,
                    borderBottomRightRadius: 0,
                    padding: "4px 12px",
                    fontSize: 11.5,
                    whiteSpace: "nowrap",
                  }}
                >
                  {tr(zh, en)}
                </button>
              ))}
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
              {settingsTab === "display" ? (
                <>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                    <span style={S.muted}>{tr("界面语言", "Language")}</span>
                    <select style={S.input} value={prefs.lang || "zh"} onChange={(e) => updatePrefs({ lang: e.target.value })}>
                      <option value="zh">中文</option>
                      <option value="en">English</option>
                    </select>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                    <span style={S.muted}>{tr("字号", "Font size")}：{prefs.fontSize}px</span>
                    <input type="range" min="10" max="20" step="1" value={prefs.fontSize} onChange={(e) => updatePrefs({ fontSize: Number(e.target.value) })} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={S.muted}>{tr("配色主题", "Colour theme")}</span>
                    <select style={S.input} value={prefs.theme} onChange={(e) => updatePrefs({ theme: e.target.value })}>
                      <option value="dark">{tr("深色（GitHub Dark）", "Dark (GitHub)")}</option>
                      <option value="light">{tr("浅色", "Light")}</option>
                      <option value="solarized">Solarized Dark</option>
                      <option value="dracula">Dracula</option>
                      <option value="contrast">{tr("高对比（黑底绿字）", "High contrast")}</option>
                    </select>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                    <span style={S.muted}>{tr("字体", "Font family")}</span>
                    <select style={S.input} value={prefs.fontFamily || ""} onChange={(e) => updatePrefs({ fontFamily: e.target.value })}>
                      {FONT_CHOICES.map(([value, label]) => (
                        <option key={label} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                    <span style={S.muted}>{tr("行高", "Line height")}：{Number(prefs.lineHeight) || 1.15}</span>
                    <input
                      type="range"
                      min="1"
                      max="1.6"
                      step="0.05"
                      value={Number(prefs.lineHeight) || 1.15}
                      onChange={(e) => updatePrefs({ lineHeight: Number(e.target.value) })}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                    <span style={S.muted}>{tr("行号 / 时间戳边栏", "Line-number / timestamp gutter")}</span>
                    <select style={S.input} value={prefs.gutter || "off"} onChange={(e) => updatePrefs({ gutter: e.target.value })}>
                      <option value="off">{tr("关闭", "Off")}</option>
                      <option value="line">{tr("行号", "Line numbers")}</option>
                      <option value="time">{tr("时间戳", "Timestamps")}</option>
                      <option value="both">{tr("行号 + 时间戳", "Both")}</option>
                    </select>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", marginTop: 10 }}>
                    <input
                      type="checkbox"
                      checked={prefs.suggestions !== false}
                      onChange={(e) => updatePrefs({ suggestions: e.target.checked })}
                    />
                    <span>{tr("命令历史模糊建议（交互式程序中自动隐藏）", "Fuzzy command suggestions (hidden in full-screen programs)")}</span>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                    <span style={S.muted}>{tr("终端类型（TERM）", "Terminal type (TERM)")}</span>
                    <select style={S.input} value={termSettings.termType || "xterm-256color"} onChange={(e) => setTermType(e.target.value)}>
                      {["xterm-256color", "xterm", "vt100", "vt220", "linux", "screen", "screen-256color", "ansi", "dumb"].map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}

              {settingsTab === "ai" ? (
                <div style={{ fontSize: 12 }}>
                  <div style={{ ...S.muted, marginBottom: 6 }}>{tr("AI 提问使用的模型", "Model used for AI questions")}</div>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input
                      type="radio"
                      checked={(prefs.aiModelPolicy || "follow") === "follow"}
                      onChange={() => updatePrefs({ aiModelPolicy: "follow" })}
                    />
                    <span>{tr("跟随主会话模型（默认，与主界面一致）", "Follow the main session model (default)")}</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", marginTop: 6 }}>
                    <input
                      type="radio"
                      checked={prefs.aiModelPolicy === "override"}
                      onChange={() => updatePrefs({ aiModelPolicy: "override" })}
                    />
                    <span>{tr("使用指定模型（每次提问前切换目标会话的模型）", "Use a specific model (switches the target session before each question)")}</span>
                  </label>
                  {prefs.aiModelPolicy === "override" ? (
                    <>
                      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <select
                          style={{ ...S.input, flex: 1 }}
                          value={prefs.aiProvider || ""}
                          onChange={(e) => updatePrefs({ aiProvider: e.target.value, aiModel: "" })}
                        >
                          <option value="">{tr("选择 provider", "Choose provider")}</option>
                          {modelProviders.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <select
                          style={{ ...S.input, flex: 1 }}
                          value={prefs.aiModel || ""}
                          onChange={(e) => updatePrefs({ aiModel: e.target.value })}
                        >
                          <option value="">{tr("选择 model", "Choose model")}</option>
                          {((modelProviders.find((p) => p.id === prefs.aiProvider) || {}).models || []).map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <input
                        style={{ ...S.input, marginTop: 6 }}
                        value={prefs.aiEffort || ""}
                        onChange={(e) => updatePrefs({ aiEffort: e.target.value })}
                        placeholder={tr("推理强度（可选，如 high；留空默认）", "Reasoning effort (optional, e.g. high)")}
                      />
                      <div style={{ ...S.muted, marginTop: 6, fontSize: 11 }}>
                        {tr(
                          "指定模型会通过模型目录服务应用到目标会话，该会话在主界面显示的模型也会随之改变。",
                          "The specific model is applied to the target session, so the model shown in the main UI changes too."
                        )}
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}

              {settingsTab === "highlight" ? (
                <div>
                  <div style={{ ...S.muted, marginBottom: 4 }}>{tr("关键字高亮", "Keyword highlighting")}</div>
                  {(prefs.highlights || []).length === 0 ? (
                    <div style={{ ...S.muted, fontSize: 11, marginBottom: 4 }}>{tr("暂无规则（例如把 ERROR 标红、WARN 标黄）", "No rules (e.g. colour ERROR red, WARN yellow)")}</div>
                  ) : (
                    (prefs.highlights || []).map((rule, i) => (
                      <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                        <input
                          style={{ ...S.input, flex: 1 }}
                          value={rule.pattern || ""}
                          onChange={(e) => updateHighlight(i, { pattern: e.target.value })}
                          placeholder={tr("关键字（不区分大小写）", "Keyword (case-insensitive)")}
                        />
                        <input
                          type="color"
                          value={HEX_RE.test(rule.color || "") ? rule.color : "#ff5555"}
                          onChange={(e) => updateHighlight(i, { color: e.target.value })}
                          style={{ width: 44, height: 28, background: "transparent", border: "none", padding: 0 }}
                        />
                        <button style={{ ...S.btn, padding: "1px 8px" }} onClick={() => removeHighlight(i)}>✕</button>
                      </div>
                    ))
                  )}
                  <button style={{ ...S.btn, marginTop: 4 }} onClick={addHighlight}>{tr("＋ 添加高亮规则", "+ Add rule")}</button>
                </div>
              ) : null}

              {settingsTab === "security" ? (
                <div style={{ fontSize: 12 }}>
                  {lockInfo.hasMaster ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <span style={{ color: C.ok }}>{tr("主密码已设置", "Master password set")}</span>
                      <button style={{ ...S.btn, padding: "1px 8px", fontSize: 11 }} onClick={lockNow}>{tr("立即锁定", "Lock now")}</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                      <input
                        style={{ ...S.input, flex: 1 }}
                        type="password"
                        value={newMaster}
                        onChange={(e) => setNewMaster(e.target.value)}
                        placeholder={tr("设置主密码（4 位以上）", "Master password (4+ chars)")}
                      />
                      <button style={S.btn} onClick={setupMaster}>{tr("设置", "Set")}</button>
                    </div>
                  )}
                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={S.muted}>{tr("空闲自动锁定（分钟，0 关闭）", "Idle auto-lock (minutes, 0 = off)")}</span>
                    <input
                      style={{ ...S.input, width: 80 }}
                      type="number"
                      min="0"
                      value={lockInfo.idleMinutes}
                      onChange={(e) => setIdleMinutes(e.target.value)}
                    />
                  </label>
                  <div style={{ ...S.muted, marginTop: 10, fontSize: 11 }}>
                    {tr("锁定后界面需要主密码解锁；忘记密码可删除 ~/.dsh/aixterm/lock.json 重置。", "While locked the panel requires the master password; delete ~/.dsh/aixterm/lock.json to reset.")}
                  </div>
                  {lockMsg ? <div style={{ color: C.danger, marginTop: 6 }}>{lockMsg}</div> : null}
                </div>
              ) : null}

              {settingsTab === "storage" ? (
                <div style={{ fontSize: 12 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={Boolean(termSettings.saveScrollback)}
                      onChange={(e) => setTermSettings((prev) => ({ ...prev, saveScrollback: e.target.checked }))}
                    />
                    <span>{tr("终端输出保存到本地", "Save terminal output locally")}</span>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                    <span style={S.muted}>{tr("保存目录（绝对路径；留空使用默认目录）", "Directory (absolute; empty = default)")}</span>
                    <input
                      style={S.input}
                      value={termSettings.scrollbackDir || ""}
                      disabled={!termSettings.saveScrollback}
                      onChange={(e) => setTermSettings((prev) => ({ ...prev, scrollbackDir: e.target.value }))}
                      placeholder={tr("例如 /home/you/aixterm-logs", "e.g. /home/you/aixterm-logs")}
                    />
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                    <span style={S.muted}>{tr("内存循环 buffer 行数", "In-memory buffer lines")}</span>
                    <input
                      style={{ ...S.input, width: 110 }}
                      type="number"
                      min="100"
                      max="100000"
                      value={termSettings.bufferLines}
                      onChange={(e) => setTermSettings((prev) => ({ ...prev, bufferLines: e.target.value }))}
                    />
                  </label>
                  <div style={{ ...S.muted, marginTop: 6, fontSize: 11 }}>
                    {tr("关闭本地保存时仅保留内存循环 buffer（超出按行覆盖）。修改保存后对已打开终端立即生效。", "When saving is off only the in-memory buffer is kept (old lines rolled over). Saved changes apply to open terminals immediately.")}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                    <button style={S.btn} onClick={saveTermSettings}>{tr("保存设置", "Save")}</button>
                    {termSettingsMsg ? (
                      <span style={{ color: termSettingsMsg.kind === "err" ? C.danger : C.ok }}>{termSettingsMsg.text}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {settingsTab === "about" ? (
                <div style={{ fontSize: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span>dsh-aixterm</span>
                    <span style={S.muted}>{termSettings.version ? `v${termSettings.version}` : ""}</span>
                  </div>
                  <a
                    href={termSettings.repo || "https://github.com/easyzoom/dsh-aixterm"}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: C.accent, wordBreak: "break-all" }}
                  >
                    github.com/easyzoom/dsh-aixterm
                  </a>
                  <div style={{ ...S.muted, marginTop: 4 }}>MIT License</div>
                </div>
              ) : null}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 18px", borderTop: `1px solid ${C.border}`, flex: "0 0 auto" }}>
              <button style={S.btnPrimary} onClick={() => setShowSettings(false)}>{tr("完成", "Done")}</button>
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
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>{editingId ? "编辑会话" : form.kind === "serial" ? "新建串口会话" : form.kind === "telnet" ? "新建 Telnet 会话" : "新建 SSH 会话"}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button style={form.kind === "ssh" ? S.btnPrimary : S.btn} onClick={() => patch("kind", "ssh")}>SSH</button>
              <button
                style={form.kind === "telnet" ? S.btnPrimary : S.btn}
                onClick={() => setForm((f) => ({ ...f, kind: "telnet", port: f.kind === "ssh" ? "23" : f.port }))}
              >
                Telnet
              </button>
              <button style={form.kind === "serial" ? S.btnPrimary : S.btn} onClick={() => patch("kind", "serial")}>串口</button>
            </div>
            {form.kind === "telnet" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={S.muted}>名称</span>
                  <input style={S.input} value={form.name} onChange={(e) => patch("name", e.target.value)} placeholder="例如 交换机" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={S.muted}>分组</span>
                  <input style={S.input} value={form.group} onChange={(e) => patch("group", e.target.value)} placeholder="默认" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={S.muted}>主机</span>
                  <input style={S.input} value={form.host} onChange={(e) => patch("host", e.target.value)} placeholder="192.168.1.20" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={S.muted}>端口</span>
                  <input style={S.input} value={form.port} onChange={(e) => patch("port", e.target.value)} placeholder="23" />
                </label>
              </div>
            ) : form.kind === "serial" ? (
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
                    <input style={S.input} type="password" value={form.password} onChange={(e) => patch("password", e.target.value)} placeholder={editingId ? "留空表示不修改密码" : ""} />
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
              <button style={S.btnPrimary} onClick={createSession} disabled={busy}>{busy ? "保存中…" : editingId ? "保存修改" : "保存并打开"}</button>
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
            const AppWithCtx = (props) => <AixtermApp {...props} hostCtx={ctx} />;
            return slots.register({ name: "main", key: "dsh-aixterm" }, AppWithCtx);
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

export const inject = ["slots", "sessions", "workspaces", "uiWorkspace", "modelDirectories", "remote.session"];
