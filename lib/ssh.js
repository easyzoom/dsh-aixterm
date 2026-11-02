// lib/ssh.js — ssh2 wrapper: connect, exec, sftp listing, connectivity test.
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import ssh2 from "ssh2";
const { Client } = ssh2;

function configFor(session, secret, sock) {
  const base = {
    ...(sock ? { sock } : { host: session.host, port: session.port || 22 }),
    username: session.user,
    readyTimeout: 15000,
    keepaliveInterval: 10000,
  };
  const auth = session.auth || {};
  if (auth.kind === "key") {
    const opts = { privateKey: fs.readFileSync(auth.keyPath) };
    if (secret) opts.passphrase = secret;
    return { ...base, ...opts };
  }
  if (auth.kind === "agent") {
    return { ...base, agent: process.env.SSH_AUTH_SOCK };
  }
  return { ...base, password: secret || "" };
}

/** Open an authenticated connection; resolves the ready Client. */
export function connect(session, secret, opts = {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        /* already closed */
      }
      reject(err);
    };
    conn.once("ready", () => {
      if (!settled) {
        settled = true;
        resolve(conn);
      }
    });
    conn.once("error", fail);
    try {
      conn.connect(configFor(session, secret, opts.sock));
    } catch (err) {
      fail(err);
    }
  });
}

/** Run one non-interactive command; resolves { stdout, stderr, code }. */
export async function exec(session, secret, command, { timeoutMs = 30000 } = {}) {
  const conn = await connect(session, secret);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let code = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        conn.end();
      } catch {
        /* already closed */
      }
      resolve({ stdout, stderr, code });
    };
    const timer = setTimeout(() => {
      stderr += "\n[timeout]";
      finish();
    }, timeoutMs);
    try {
      conn.exec(command, (err, stream) => {
        if (err) {
          stderr += String(err.message || err);
          finish();
          return;
        }
        stream.on("data", (d) => {
          stdout += d.toString();
        });
        stream.stderr.on("data", (d) => {
          stderr += d.toString();
        });
        stream.on("exit", (c) => {
          code = c;
        });
        stream.on("close", finish);
        stream.on("error", (e) => {
          stderr += String(e.message || e);
          finish();
        });
      });
    } catch (e) {
      stderr += String(e.message || e);
      finish();
    }
  });
}

function mapEntries(list) {
  return (list || []).map((it) => ({
    name: it.filename,
    longname: it.longname,
    size: it.attrs && it.attrs.size,
    mode: it.attrs && it.attrs.mode,
    isDirectory: Boolean(it.attrs && (it.attrs.mode & 0o040000) === 0o040000),
  }));
}

/** List a directory and resolve its absolute path on the same SFTP session. */
export async function sftpListResolved(session, secret, dir) {
  const conn = await connect(session, secret);
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) {
        try {
          conn.end();
        } catch {
          /* already closed */
        }
        reject(err);
        return;
      }
      const start = dir || ".";
      sftp.realpath(start, (re, resolved) => {
        const target = re ? start : resolved;
        sftp.readdir(target, (e, list) => {
          try {
            conn.end();
          } catch {
            /* already closed */
          }
          if (e) {
            reject(e);
            return;
          }
          resolve({ path: target, entries: mapEntries(list) });
        });
      });
    });
  });
}

/** List one directory over SFTP. */
export async function sftpList(session, secret, dir) {
  return (await sftpListResolved(session, secret, dir)).entries;
}

/** Read a whole remote file over SFTP; resolves a Buffer. */
export async function sftpRead(session, secret, remotePath) {
  const conn = await connect(session, secret);
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) {
        try { conn.end(); } catch { /* closed */ }
        reject(err);
        return;
      }
      sftp.readFile(remotePath, (e, data) => {
        try { conn.end(); } catch { /* closed */ }
        if (e) reject(e);
        else resolve(data);
      });
    });
  });
}

/** Write a whole remote file over SFTP. */
export async function sftpWrite(session, secret, remotePath, data) {
  const conn = await connect(session, secret);
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) {
        try { conn.end(); } catch { /* closed */ }
        reject(err);
        return;
      }
      sftp.writeFile(remotePath, data, (e) => {
        try { conn.end(); } catch { /* closed */ }
        if (e) reject(e);
        else resolve();
      });
    });
  });
}

/** Connect then close, to verify credentials/reachability. */
export async function testConnection(session, secret) {
  const conn = await connect(session, secret);
  try {
    conn.end();
  } catch {
    /* already closed */
  }
  return { ok: true };
}

/** Open an interactive shell channel (PTY) over SSH; resolves { stream, conn }. */
export async function openShell(session, secret, { cols = 120, rows = 30, x11 = false } = {}) {
  const conn = await connect(session, secret);
  if (x11) {
    // Forward remote X11 channels to the local X server (DISPLAY socket).
    const display = process.env.DISPLAY || ":0";
    const num = (String(display).match(/:([0-9]+)/) || [])[1] || "0";
    const socketPath = `/tmp/.X11-unix/X${num}`;
    conn.on("x11", (info, accept, reject) => {
      const sock = net.connect({ path: socketPath });
      sock.on("connect", () => {
        try {
          const ch = accept();
          ch.pipe(sock).pipe(ch);
        } catch {
          /* channel refused */
        }
      });
      sock.on("error", () => {
        try {
          reject();
        } catch {
          /* already rejected */
        }
      });
    });
  }
  return new Promise((resolve, reject) => {
    try {
      conn.shell({ term: "xterm-256color", cols, rows, ...(x11 ? { x11: true } : {}) }, (err, stream) => {
        if (err) {
          try {
            conn.end();
          } catch {
            /* already closed */
          }
          reject(err);
          return;
        }
        resolve({ stream, conn });
      });
    } catch (err) {
      try {
        conn.end();
      } catch {
        /* already closed */
      }
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Shared connections (kept alive) and jump hosts.
// Forwards and long-lived channels reuse one connection per session; exec/sftp
// keep their existing one-shot behaviour.
// ---------------------------------------------------------------------------

const shared = new Map(); // key -> Promise<conn>

function sharedKey(session) {
  return session.id || `${session.user}@${session.host}:${session.port || 22}`;
}

/** A kept-alive connection for `session`, chained through `jump` when given. */
export async function sharedConnection(session, secret, jump) {
  const key = sharedKey(session);
  const prior = shared.get(key);
  if (prior) {
    try {
      const conn = await prior;
      if (conn && !conn.__closed) return conn;
    } catch {
      /* fall through and reconnect */
    }
  }
  const p = (async () => {
    let conn;
    if (jump && jump.session) {
      const jumpConn = await sharedConnection(jump.session, jump.secret);
      const sock = await new Promise((resolve, reject) => {
        jumpConn.forwardOut("127.0.0.1", 0, session.host, session.port || 22, (err, stream) => {
          if (err) reject(err);
          else resolve(stream);
        });
      });
      conn = await connect(session, secret, { sock });
    } else {
      conn = await connect(session, secret);
    }
    conn.__closed = false;
    conn.on("close", () => {
      conn.__closed = true;
      if (shared.get(key) === p) shared.delete(key);
    });
    return conn;
  })();
  shared.set(key, p);
  return p;
}

/** Drop the kept-alive connection for a session (closes forwards using it). */
export function dropSharedConnection(sessionId) {
  for (const [key, p] of shared) {
    if (key === sessionId || key.startsWith(sessionId + "\u0000")) {
      p.then((c) => { try { c.end(); } catch { /* closed */ } }).catch(() => {});
      shared.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Port forwarding: local (-L), remote (-R), dynamic SOCKS5 (-D).
// ---------------------------------------------------------------------------

const forwards = new Map(); // id -> entry

function pipeBoth(a, b) {
  a.pipe(b).pipe(a);
  a.on("error", () => { try { b.destroy(); } catch { /* gone */ } });
  b.on("error", () => { try { a.destroy(); } catch { /* gone */ } });
  a.on("close", () => { try { b.destroy(); } catch { /* gone */ } });
  b.on("close", () => { try { a.destroy(); } catch { /* gone */ } });
}

/** SOCKS5 CONNECT negotiator over one accepted client socket. */
function socks5Accept(client, forwardOut, onError) {
  let buf = Buffer.alloc(0);
  let stage = "greeting";
  const fail = (code) => {
    try { client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])); } catch { /* gone */ }
    onError();
  };
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    if (stage === "greeting") {
      if (buf.length < 2) return;
      const n = buf[1];
      if (buf.length < 2 + n) return;
      buf = buf.subarray(2 + n);
      client.write(Buffer.from([5, 0]));
      stage = "request";
    }
    if (stage !== "request" || buf.length < 4) return;
    const cmd = buf[1];
    const atyp = buf[3];
    let host;
    let port;
    let need;
    if (atyp === 1) {
      need = 10;
      if (buf.length < need) return;
      host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      port = buf.readUInt16BE(8);
    } else if (atyp === 3) {
      if (buf.length < 5) return;
      const len = buf[4];
      need = 5 + len + 2;
      if (buf.length < need) return;
      host = buf.subarray(5, 5 + len).toString("utf8");
      port = buf.readUInt16BE(5 + len);
    } else if (atyp === 4) {
      need = 22;
      if (buf.length < need) return;
      const parts = [];
      for (let i = 0; i < 8; i += 1) parts.push(buf.readUInt16BE(4 + i * 2).toString(16));
      host = parts.join(":");
      port = buf.readUInt16BE(20);
    } else {
      fail(8);
      return;
    }
    if (cmd !== 1) { fail(7); return; }
    const rest = buf.subarray(need);
    stage = "connecting";
    client.removeListener("data", onData);
    forwardOut(host, port, (err, stream) => {
      if (err) { fail(5); return; }
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      if (rest.length) stream.write(rest);
      pipeBoth(client, stream);
    });
  };
  client.on("data", onData);
  client.on("error", () => { /* client gone; stream close handles cleanup */ });
}

/**
 * Start a forward. Resolves the entry (state "running" or "failed").
 * kind: "local" | "remote" | "dynamic"
 */
export async function startForward({ session, secret, jump, kind, bindAddr, bindPort, dstHost, dstPort }) {
  const id = crypto.randomUUID();
  const entry = {
    id,
    kind,
    sessionId: session.id,
    bindAddr: bindAddr || "127.0.0.1",
    bindPort: Number(bindPort) || 0,
    dstHost: dstHost || "",
    dstPort: Number(dstPort) || 0,
    state: "starting",
    createdAt: new Date().toISOString(),
  };
  forwards.set(id, entry);
  let close = () => {};
  try {
    const conn = await sharedConnection(session, secret, jump);

    if (kind === "remote") {
      await new Promise((resolve, reject) => {
        conn.forwardIn(entry.bindAddr, entry.bindPort, (err) => (err ? reject(err) : resolve()));
      });
      const onTcp = (info, accept) => {
        const stream = accept();
        const local = net.connect({ host: entry.dstHost, port: entry.dstPort });
        local.on("connect", () => pipeBoth(stream, local));
        local.on("error", () => { try { stream.end(); } catch { /* gone */ } });
        stream.on("error", () => { try { local.destroy(); } catch { /* gone */ } });
      };
      conn.on("tcp connection", onTcp);
      close = () => {
        conn.removeListener("tcp connection", onTcp);
        try { conn.unforwardIn(entry.bindAddr, entry.bindPort); } catch { /* gone */ }
      };
    } else {
      const server = net.createServer((client) => {
        client.on("error", () => { /* client gone */ });
        if (kind === "dynamic") {
          socks5Accept(client, (host, port, cb) => conn.forwardOut("127.0.0.1", 0, host, port, cb), () => {});
          return;
        }
        conn.forwardOut(client.remoteAddress || "127.0.0.1", client.remotePort || 0, entry.dstHost, entry.dstPort, (err, stream) => {
          if (err) { try { client.destroy(); } catch { /* gone */ } return; }
          pipeBoth(client, stream);
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(entry.bindPort, entry.bindAddr, () => resolve());
      });
      const addr = server.address();
      if (addr && typeof addr === "object") entry.bindPort = addr.port;
      close = () => { try { server.close(); } catch { /* gone */ } };
    }
    entry.state = "running";
    entry.close = close;
  } catch (error) {
    entry.state = "failed";
    entry.error = String(error?.message ?? error);
    try { close(); } catch { /* gone */ }
  }
  return { ...entry, close: undefined };
}

/** List forwards, optionally filtered by session. */
export function listForwards(sessionId) {
  return [...forwards.values()]
    .filter((e) => !sessionId || e.sessionId === sessionId)
    .map(({ close, ...rest }) => rest);
}

/** Stop a forward by id. */
export function stopForward(id) {
  const entry = forwards.get(id);
  if (!entry) return false;
  try { entry.close?.(); } catch { /* gone */ }
  forwards.delete(id);
  return true;
}

// ---------------------------------------------------------------------------
// SFTP management: mkdir / rename / remove / chmod (read & write already above).
// ---------------------------------------------------------------------------

async function withSftp(session, secret, fn) {
  const conn = await connect(session, secret);
  try {
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
    });
    return await fn(sftp);
  } finally {
    try {
      conn.end();
    } catch {
      /* already closed */
    }
  }
}

export async function sftpMkdir(session, secret, remotePath) {
  return withSftp(session, secret, (sftp) => new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (e) => (e ? reject(e) : resolve()));
  }));
}

export async function sftpRename(session, secret, from, to) {
  return withSftp(session, secret, (sftp) => new Promise((resolve, reject) => {
    sftp.rename(from, to, (e) => (e ? reject(e) : resolve()));
  }));
}

/** Remove a file (unlink) or an empty directory (rmdir). */
export async function sftpRemove(session, secret, remotePath) {
  return withSftp(session, secret, (sftp) => new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, attrs) => {
      if (err) {
        reject(err);
        return;
      }
      const done = (e) => (e ? reject(e) : resolve());
      if (attrs.isDirectory()) sftp.rmdir(remotePath, done);
      else sftp.unlink(remotePath, done);
    });
  }));
}

export async function sftpChmod(session, secret, remotePath, mode) {
  return withSftp(session, secret, (sftp) => new Promise((resolve, reject) => {
    sftp.chmod(remotePath, mode, (e) => (e ? reject(e) : resolve()));
  }));
}
