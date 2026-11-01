// lib/ssh.js — ssh2 wrapper: connect, exec, sftp listing, connectivity test.
import fs from "node:fs";
import ssh2 from "ssh2";
const { Client } = ssh2;

function configFor(session, secret) {
  const base = {
    host: session.host,
    port: session.port || 22,
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
export function connect(session, secret) {
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
      conn.connect(configFor(session, secret));
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
export async function openShell(session, secret, { cols = 120, rows = 30 } = {}) {
  const conn = await connect(session, secret);
  return new Promise((resolve, reject) => {
    try {
      conn.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
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
