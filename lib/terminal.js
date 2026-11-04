// lib/terminal.js — interactive terminal engine shared by the human and the agent.
//
// One Terminal per open shell. It keeps a bounded UTF-8 buffer (for replay and
// the aixterm_term_read tool), persists every byte to a scrollback log under
// <dataDir>/terminals, and fans out to SSE subscribers. A remote shell is an
// ssh2 `shell()` PTY channel; a local shell is a node-pty (ConPTY) process.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { openShell } from "./ssh.js";

const BUFFER_LIMIT = 256 * 1024;

function sshSource(stream, conn) {
  return {
    write: (data) => stream.write(data),
    resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
    kill: () => {
      try {
        stream.end();
      } catch {
        /* already closed */
      }
      try {
        conn.end();
      } catch {
        /* already closed */
      }
    },
    onData: (cb) => {
      stream.on("data", (d) => cb(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
      stream.stderr.on("data", (d) => cb(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
    },
    onClose: (cb) => {
      stream.on("close", cb);
    },
  };
}

/** Parse typed input into commands (ignores escape sequences and control keys). */
function makeLineParser(onCommand) {
  let line = "";
  let esc = 0;
  return (chunk) => {
    for (const ch of String(chunk)) {
      const code = ch.charCodeAt(0);
      if (esc === 1) {
        esc = code === 91 ? 2 : 0;
        continue;
      }
      if (esc === 2) {
        if (code >= 64 && code <= 126) esc = 0;
        continue;
      }
      if (code === 27) {
        esc = 1;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        const cmd = line.trim();
        line = "";
        if (cmd) onCommand(cmd);
        continue;
      }
      if (code === 127 || code === 8) {
        line = line.slice(0, -1);
        continue;
      }
      if (code === 3 || code === 21) {
        line = "";
        continue;
      }
      if (code >= 32 && code < 127) line += ch;
    }
  };
}

const TELNET_IAC = 255;
const TELNET_DO = 253;
const TELNET_DONT = 254;
const TELNET_WILL = 251;
const TELNET_WONT = 252;
const TELNET_SB = 250;
const TELNET_SE = 240;
const TELNET_ACCEPT = new Set([1, 3]); // ECHO, SUPPRESS-GO-AHEAD

/** Strip and answer Telnet IAC sequences; returns the user data bytes. */
function makeTelnetFilter(socket) {
  let pending = Buffer.alloc(0);
  const reply = (bytes) => {
    try {
      socket.write(Buffer.from(bytes));
    } catch {
      /* socket closed */
    }
  };
  const findSubnegEnd = (buf, from) => {
    for (let i = from; i + 1 < buf.length; i += 1) {
      if (buf[i] === TELNET_IAC && buf[i + 1] === TELNET_SE) return i;
    }
    return -1;
  };
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const out = [];
    let i = 0;
    while (i < pending.length) {
      const b = pending[i];
      if (b !== TELNET_IAC) {
        out.push(b);
        i += 1;
        continue;
      }
      if (i + 1 >= pending.length) break;
      const cmd = pending[i + 1];
      if (cmd === TELNET_IAC) {
        out.push(TELNET_IAC);
        i += 2;
        continue;
      }
      if (cmd === TELNET_SB) {
        const end = findSubnegEnd(pending, i + 2);
        if (end < 0) break;
        i = end + 2;
        continue;
      }
      if (cmd === TELNET_WILL || cmd === TELNET_WONT || cmd === TELNET_DO || cmd === TELNET_DONT) {
        if (i + 2 >= pending.length) break;
        const opt = pending[i + 2];
        if (cmd === TELNET_WILL) reply([TELNET_IAC, TELNET_ACCEPT.has(opt) ? TELNET_DO : TELNET_DONT, opt]);
        else if (cmd === TELNET_WONT) reply([TELNET_IAC, TELNET_DONT, opt]);
        else if (cmd === TELNET_DO) reply([TELNET_IAC, TELNET_ACCEPT.has(opt) ? TELNET_WILL : TELNET_WONT, opt]);
        else reply([TELNET_IAC, TELNET_WONT, opt]);
        i += 3;
        continue;
      }
      i += 2;
    }
    pending = pending.subarray(i);
    return Buffer.from(out);
  };
}

async function telnetSource(cfg) {
  const socket = net.connect({ host: cfg.host, port: Number(cfg.port) || 23 });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const filter = makeTelnetFilter(socket);
  return {
    write: (data) => socket.write(Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8")),
    resize: () => {},
    kill: () => {
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
    },
    onData: (cb) =>
      socket.on("data", (chunk) => {
        const payload = filter(chunk);
        if (payload.length) cb(payload);
      }),
    onClose: (cb) => socket.on("close", cb),
  };
}

async function serialSource(cfg) {
  const { SerialPort } = await import("serialport");
  const port = new SerialPort({
    path: cfg.path,
    baudRate: Number(cfg.baudRate) || 115200,
    dataBits: Number(cfg.dataBits) || 8,
    stopBits: Number(cfg.stopBits) || 1,
    parity: cfg.parity || "none",
    autoOpen: false,
  });
  await new Promise((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });
  return {
    write: (data) => port.write(Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8")),
    resize: () => {},
    kill: () => {
      try {
        port.close();
      } catch {
        /* already closed */
      }
    },
    onData: (cb) => port.on("data", (chunk) => cb(chunk)),
    onClose: (cb) => port.on("close", cb),
  };
}

async function localSource({ shell, cwd, cols, rows, term }) {
  const mod = await import("node-pty");
  const pty = mod.default || mod;
  const sh = shell || (process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash");
  const proc = pty.spawn(sh, [], {
    name: term || "xterm-256color",
    cols: cols || 120,
    rows: rows || 30,
    cwd: cwd || process.env.USERPROFILE || process.cwd(),
    env: { ...process.env },
  });
  return {
    write: (data) => proc.write(Buffer.from(data).toString("utf8")),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    },
    onData: (cb) => proc.onData((s) => cb(Buffer.from(s, "utf8"))),
    onClose: (cb) => proc.onExit(() => cb()),
  };
}

export class TerminalManager {
  constructor({ dataDir, settings, onCommand }) {
    this.dataDir = dataDir;
    this.settings = settings || null;
    this.onCommand = typeof onCommand === "function" ? onCommand : null;
    fs.mkdirSync(this.dir, { recursive: true });
    this.terms = new Map();
  }

  /** Current scrollback directory (runtime setting, falls back to dataDir). */
  get dir() {
    const s = this.settings ? this.settings.get() : {};
    return (s.scrollbackDir || "") || path.join(this.dataDir, "terminals");
  }

  get saveScrollback() {
    const s = this.settings ? this.settings.get() : {};
    return s.saveScrollback !== false;
  }

  /** Per-session, timestamped scrollback file (or null when saving is off). */
  _logPath(label) {
    if (!this.saveScrollback) return null;
    const dir = this.dir;
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safe = String(label || "terminal").replace(/[^\w.@-]+/g, "_").slice(0, 60);
    return path.join(dir, `${safe}-${ts}.log`);
  }

  /** Number of newline characters in a string chunk. */
  _countLines(text) {
    let n = 0;
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
    return n;
  }

  /** Keep only the most recent `maxLines` lines of a buffered string. */
  _tailLines(text, maxLines) {
    const limit = Number(maxLines) || 0;
    if (!limit) return text;
    let count = 0;
    for (let i = text.length - 1; i >= 0; i -= 1) {
      if (text.charCodeAt(i) === 10) {
        count += 1;
        if (count > limit) return text.slice(i + 1);
      }
    }
    return text;
  }

  /** Re-apply runtime settings to open terminals (buffer size, log on/off). */
  applySettings() {
    const s = this.settings ? this.settings.get() : {};
    const lines = Number(s.bufferLines) || 2000;
    const saving = s.saveScrollback !== false;
    for (const term of this.terms.values()) {
      term.maxLines = lines;
      if ((term.lines || 0) > lines) {
        term.buffer = this._tailLines(term.buffer, lines);
        term.lines = this._countLines(term.buffer);
      }
      if (!saving && term.log) {
        try {
          term.log.end();
        } catch {
          /* already closed */
        }
        term.log = null;
        term.logPath = null;
      } else if (saving && !term.log) {
        term.logPath = this._logPath(term.label || "terminal");
        term.log = term.logPath ? fs.createWriteStream(term.logPath, { flags: "a" }) : null;
      }
    }
  }

  /** Emit text to the buffer, the scrollback log and every subscriber. */
  _emit(term, chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    term.buffer += text;
    const lines = term.maxLines || 2000;
    term.lines = (term.lines || 0) + this._countLines(text);
    // Trim once the line count (plus a small headroom) is exceeded.
    if (term.lines > lines + 200) {
      term.buffer = this._tailLines(term.buffer, lines);
      term.lines = this._countLines(term.buffer);
    }
    try {
      term.log && term.log.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(text, "utf8"));
    } catch {
      /* log closed */
    }
    for (const fn of term.subs) {
      try {
        fn(Buffer.isBuffer(chunk) ? chunk : Buffer.from(text, "utf8"));
      } catch {
        /* subscriber gone */
      }
    }
  }

  /** Open a terminal for a saved SSH session, or a local shell when `local` is set. */
  async open({ session, secret, local, cols, rows, tmuxName }) {
    const id = crypto.randomUUID();
    const label = session ? (session.kind === "serial" ? `serial-${session.name}` : session.name) : "local";
    const logPath = this._logPath(label);
    const term = {
      id,
      label,
      buffer: "",
      subs: new Set(),
      closed: false,
      src: null,
      attempts: 0,
      timer: null,
      manuallyClosed: false,
      params: { session, secret, local, cols, rows, tmuxName: tmuxName || "", termType: (this.settings ? this.settings.get().termType : undefined) || "xterm-256color" },
      logPath,
      maxLines: (this.settings ? this.settings.get().bufferLines : 0) || 2000,
      lines: 0,
      lineParser:
        this.onCommand && session && session.id
          ? makeLineParser((cmd) => {
              try {
                this.onCommand(session.id, cmd);
              } catch {
                /* history write failed */
              }
            })
          : null,
      log: logPath ? fs.createWriteStream(logPath, { flags: "a" }) : null,
    };
    this.terms.set(id, term);
    await this._attach(term);
    return id;
  }

  /** Create the underlying source (SSH shell or local PTY) and wire its events. */
  async _attach(term) {
    const { session, secret, local, cols, rows } = term.params;
    const termType = term.params.termType || "xterm-256color";
    let src;
    if (session && session.kind === "serial") {
      src = await serialSource(session.serial || {});
    } else if (session && session.kind === "telnet") {
      src = await telnetSource({ host: session.host, port: session.port });
    } else if (session) {
      const { stream, conn } = await openShell(session, secret, { cols, rows, x11: Boolean(session.x11) });
      src = sshSource(stream, conn);
      // Best-effort: let the shell report its cwd through OSC 7 so the SFTP
      // panel can follow the terminal directory (MobaXterm-style). Devices with
      // busybox sh are switched to bash when available; without bash the hint
      // is a harmless no-op.
      const promptCmd =
        "if [ -n \"$BASH_VERSION\" ]; then export PROMPT_COMMAND='printf \"\\033]7;file://%s%s\\007\" \"$HOSTNAME\" \"$PWD\"'; else PS1='$(printf \"\\033]7;file://%s%s\\007\" \"$HOSTNAME\" \"$PWD\")'\"$PS1\"; fi; clear\r";
      try {
        if (term.params.tmuxName) {
          // Reattach (or create) a named tmux session so the shell survives
          // reconnects; the prompt hint then runs inside tmux.
          stream.write(`tmux new-session -A -s ${term.params.tmuxName}\r`);
          setTimeout(() => {
            try {
              stream.write(promptCmd);
            } catch {
              /* channel closed meanwhile */
            }
          }, 1500);
        } else {
          stream.write('if [ -z "$BASH_VERSION" ] && command -v bash >/dev/null 2>&1; then exec bash -i; fi\r');
          setTimeout(() => {
            try {
              stream.write(promptCmd);
            } catch {
              /* channel closed meanwhile */
            }
          }, 900);
        }
      } catch {
        /* channel not writable */
      }
    } else {
      src = await localSource({ ...(local || {}), term: termType });
    }
    term.src = src;
    term.closed = false;
    src.onData((chunk) => this._emit(term, chunk));
    src.onClose(() => this._onClose(term));
  }

  _onClose(term) {
    term.closed = true;
    if (term.manuallyClosed) {
      try {
        term.log && term.log.end();
      } catch {
        /* already ended */
      }
      return;
    }
    const session = term.params.session;
    const canReconnect = Boolean(session) && session.reconnect !== false;
    if (!canReconnect || term.attempts >= 5) {
      if (canReconnect) {
        this._emit(term, "\r\n[aixterm] 重连失败，已达到最大重试次数\r\n");
      }
      try {
        term.log && term.log.end();
      } catch {
        /* already ended */
      }
      return;
    }
    term.attempts += 1;
    const delay = Math.min(1000 * 2 ** (term.attempts - 1), 15000);
    this._emit(term, `\r\n[aixterm] 连接断开，${Math.round(delay / 1000)} 秒后重连（第 ${term.attempts}/5 次）\r\n`);
    term.timer = setTimeout(async () => {
      try {
        await this._attach(term);
        term.attempts = 0;
        this._emit(term, "\r\n[aixterm] 已重新连接\r\n");
      } catch {
        this._onClose(term);
      }
    }, delay);
  }

  get(id) {
    return this.terms.get(id);
  }
  buffer(id) {
    const t = this.terms.get(id);
    return t ? t.buffer : "";
  }
  input(id, data) {
    const t = this.terms.get(id);
    if (!t || t.closed) return;
    try {
      if (t.lineParser && typeof data === "string") t.lineParser(data);
      t.src.write(Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"));
    } catch {
      /* write failed */
    }
  }
  resize(id, cols, rows) {
    const t = this.terms.get(id);
    if (!t || t.closed) return;
    try {
      t.src.resize(Number(cols) || 120, Number(rows) || 30);
    } catch {
      /* resize failed */
    }
  }
  /** Subscribe to raw output; returns an unsubscribe function. */
  subscribe(id, fn) {
    const t = this.terms.get(id);
    if (!t) return () => {};
    t.subs.add(fn);
    return () => t.subs.delete(fn);
  }
  /** The AI's read face: the tail of the buffer (already includes escape codes). */
  read(id, maxBytes = 16 * 1024) {
    const t = this.terms.get(id);
    if (!t) return undefined;
    const n = Math.max(1, Math.min(Number(maxBytes) || 16 * 1024, BUFFER_LIMIT));
    return t.buffer.length > n ? t.buffer.slice(-n) : t.buffer;
  }
  close(id) {
    const t = this.terms.get(id);
    if (!t) return;
    t.manuallyClosed = true;
    if (t.timer) {
      try {
        clearTimeout(t.timer);
      } catch {
        /* already fired */
      }
    }
    try {
      t.src?.kill();
    } catch {
      /* already dead */
    }
    try {
      t.log && t.log.end();
    } catch {
      /* already ended */
    }
    this.terms.delete(id);
  }
}
