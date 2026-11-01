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

  /** Open a terminal for a saved SSH session, or a local shell when `local` is set. */
  async open({ session, secret, local, cols, rows }) {
    const id = crypto.randomUUID();
    let src;
    if (session) {
      const { stream, conn } = await openShell(session, secret, { cols, rows });
      src = sshSource(stream, conn);
    } else {
      src = await localSource(local || {});
    }
    const term = { id, buffer: "", subs: new Set(), closed: false, src, log: fs.createWriteStream(path.join(this.dir, id + ".log"), { flags: "a" }) };
    src.onData((chunk) => {
      const text = chunk.toString("utf8");
      term.buffer += text;
      if (term.buffer.length > BUFFER_LIMIT) term.buffer = term.buffer.slice(-BUFFER_LIMIT);
      try {
        term.log.write(chunk);
      } catch {
        /* log closed */
      }
      for (const fn of term.subs) {
        try {
          fn(chunk);
        } catch {
          /* subscriber gone */
        }
      }
    });
    src.onClose(() => {
      term.closed = true;
      try {
        term.log.end();
      } catch {
        /* already ended */
      }
    });
    this.terms.set(id, term);
    return id;
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
      t.src.write(Buffer.from(String(data), "utf8"));
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
    try {
      t.src.kill();
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
