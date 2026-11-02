// lib/terminal.js — interactive terminal engine shared by the human and the agent.
//
// One Terminal per open shell. It keeps a bounded UTF-8 buffer (for replay and
// the aixterm_term_read tool), persists every byte to a scrollback log under
// <dataDir>/terminals, and fans out to SSE subscribers. A remote shell is an
// ssh2 `shell()` PTY channel; a local shell is a node-pty (ConPTY) process.
import fs from "node:fs";
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

async function localSource({ shell, cwd, cols, rows }) {
  const mod = await import("node-pty");
  const pty = mod.default || mod;
  const sh = shell || (process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash");
  const proc = pty.spawn(sh, [], {
    name: "xterm-256color",
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
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, "terminals");
    fs.mkdirSync(this.dir, { recursive: true });
    this.terms = new Map();
  }

  /** Emit text to the buffer, the scrollback log and every subscriber. */
  _emit(term, chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    term.buffer += text;
    if (term.buffer.length > BUFFER_LIMIT) term.buffer = term.buffer.slice(-BUFFER_LIMIT);
    try {
      term.log.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(text, "utf8"));
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
  async open({ session, secret, local, cols, rows }) {
    const id = crypto.randomUUID();
    const term = {
      id,
      buffer: "",
      subs: new Set(),
      closed: false,
      src: null,
      attempts: 0,
      timer: null,
      manuallyClosed: false,
      params: { session, secret, local, cols, rows },
      log: fs.createWriteStream(path.join(this.dir, id + ".log"), { flags: "a" }),
    };
    this.terms.set(id, term);
    await this._attach(term);
    return id;
  }

  /** Create the underlying source (SSH shell or local PTY) and wire its events. */
  async _attach(term) {
    const { session, secret, local, cols, rows } = term.params;
    let src;
    if (session && session.kind === "serial") {
      src = await serialSource(session.serial || {});
    } else if (session) {
      const { stream, conn } = await openShell(session, secret, { cols, rows, x11: Boolean(session.x11) });
      src = sshSource(stream, conn);
      // Best-effort: let the shell report its cwd through OSC 7 so the SFTP
      // panel can follow the terminal directory (MobaXterm-style). Devices with
      // busybox sh are switched to bash when available; without bash the hint
      // is a harmless no-op.
      try {
        stream.write('if [ -z "$BASH_VERSION" ] && command -v bash >/dev/null 2>&1; then exec bash -i; fi\r');
        setTimeout(() => {
          try {
            stream.write("export PROMPT_COMMAND='printf \"\\033]7;file://%s%s\\007\" \"$HOSTNAME\" \"$PWD\"'; clear\r");
          } catch {
            /* channel closed meanwhile */
          }
        }, 900);
      } catch {
        /* channel not writable */
      }
    } else {
      src = await localSource(local || {});
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
        term.log.end();
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
        term.log.end();
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
      t.log.end();
    } catch {
      /* already ended */
    }
    this.terms.delete(id);
  }
}
