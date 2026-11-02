// lib/transfer.js — SFTP transfer queue with progress, speed, pause/resume,
// cancel, retry, duplicate handling, resume and timestamp preservation.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { connect } from "./ssh.js";

const CHUNK = 64 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Append " (n)" before the extension until the name is free. */
export function dedupeName(name, exists) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let candidate = name;
  let i = 1;
  while (exists(candidate)) {
    candidate = `${base} (${i})${ext}`;
    i += 1;
    if (i > 999) break;
  }
  return candidate;
}

function sftpOpen(sftp, p, flags) {
  return new Promise((res, rej) => sftp.open(p, flags, (e, h) => (e ? rej(e) : res(h))));
}
function sftpStat(sftp, p) {
  return new Promise((res, rej) => sftp.stat(p, (e, st) => (e ? rej(e) : res(st))));
}
function sftpRead(sftp, h, buf, off, len, pos) {
  return new Promise((res, rej) => sftp.read(h, buf, off, len, pos, (e, n) => (e ? rej(e) : res(n))));
}
function sftpWrite(sftp, h, buf, off, len, pos) {
  return new Promise((res, rej) => sftp.write(h, buf, off, len, pos, (e) => (e ? rej(e) : res())));
}
function sftpClose(sftp, h) {
  return new Promise((res) => sftp.close(h, () => res()));
}
function sftpUtimes(sftp, p, atime, mtime) {
  return new Promise((res) => sftp.utimes(p, atime, mtime, () => res()));
}

export class TransferManager {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "transfers");
    fs.mkdirSync(this.dir, { recursive: true });
    this.tasks = new Map();
  }

  list() {
    return [...this.tasks.values()].map((t) => this._public(t));
  }

  _public(t) {
    const { conn, secret, ...rest } = t;
    return { ...rest };
  }

  _newTask(kind, fields) {
    const id = (fields && fields.id) || crypto.randomUUID();
    const task = {
      kind,
      status: "queued",
      transferred: 0,
      size: 0,
      speed: 0,
      error: "",
      createdAt: Date.now(),
      ...fields,
      id,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  /** Queue an upload from base64 content; returns the task. */
  createUpload({ session, secret, name, remotePath, dataB64, policy }) {
    const id = crypto.randomUUID();
    const tmp = path.join(this.dir, `${id}.upload`);
    const buf = Buffer.from(String(dataB64 || ""), "base64");
    fs.writeFileSync(tmp, buf);
    const task = this._newTask("upload", {
      id,
      sessionId: session.id,
      name: name || path.basename(remotePath || tmp),
      remotePath,
      localPath: tmp,
      size: buf.length,
      policy: policy || "overwrite",
      _session: session,
      _secret: secret,
    });
    this._start(task);
    return this._public(task);
  }

  createDownload({ session, secret, remotePath, localName, policy }) {
    const id = crypto.randomUUID();
    const base = localName || path.basename(remotePath || "file");
    const task = this._newTask("download", {
      id,
      sessionId: session.id,
      name: base,
      remotePath,
      localPath: path.join(this.dir, `${id}-${base}`),
      policy: policy || "overwrite",
      _session: session,
      _secret: secret,
    });
    this._start(task);
    return this._public(task);
  }

  action(id, action) {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (action === "pause") {
      if (task.status === "running" || task.status === "queued") {
        task.paused = true;
        task.status = "paused";
      }
    } else if (action === "resume") {
      if (task.status === "paused") {
        task.paused = false;
        task.status = "running";
      }
    } else if (action === "cancel") {
      task.aborted = true;
      if (task.status !== "done") task.status = "canceled";
    } else if (action === "retry") {
      if (task.status === "failed" || task.status === "canceled") {
        task.aborted = false;
        task.paused = false;
        task.error = "";
        task.status = "queued";
        this._start(task);
      }
    } else {
      return false;
    }
    return true;
  }

  _tick(task) {
    const now = Date.now();
    if (!task._lastTs) {
      task._lastTs = now;
      task._lastBytes = 0;
      return;
    }
    const dt = (now - task._lastTs) / 1000;
    if (dt < 0.4) return;
    task.speed = Math.max(0, (task.transferred - task._lastBytes) / dt);
    task._lastTs = now;
    task._lastBytes = task.transferred;
  }

  async _wait(task) {
    while (task.paused && !task.aborted) await sleep(200);
    if (task.aborted) throw new Error("aborted");
  }

  async _start(task) {
    if (task.status === "running") return;
    task.status = "running";
    try {
      if (task.kind === "upload") await this._runUpload(task);
      else await this._runDownload(task);
      if (task.status !== "canceled") task.status = "done";
      task.speed = 0;
    } catch (error) {
      if (task.aborted) {
        task.status = "canceled";
      } else {
        task.status = "failed";
        task.error = String(error?.message ?? error);
      }
      task.speed = 0;
    }
  }

  async _withSftp(task, fn) {
    const conn = await connect(task._session, task._secret);
    try {
      const sftp = await new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(e) : res(s))));
      return await fn(sftp);
    } finally {
      try {
        conn.end();
      } catch {
        /* closed */
      }
    }
  }

  async _runUpload(task) {
    // duplicate policy on the remote side
    await this._withSftp(task, async (sftp) => {
      let exists = false;
      try {
        await sftpStat(sftp, task.remotePath);
        exists = true;
      } catch {
        exists = false;
      }
      if (exists && task.policy === "skip") {
        task.status = "done";
        task.skipped = true;
        return;
      }
      if (exists && task.policy === "rename") {
        const dir = path.posix.dirname(task.remotePath);
        const base = path.posix.basename(task.remotePath);
        const ext = path.posix.extname(base);
        const stem = ext ? base.slice(0, -ext.length) : base;
        let candidate = base;
        let i = 1;
        for (;;) {
          try {
            await sftpStat(sftp, path.posix.join(dir, candidate));
            candidate = `${stem} (${i})${ext}`;
            i += 1;
            if (i > 999) break;
          } catch {
            break;
          }
        }
        task.remotePath = path.posix.join(dir, candidate);
      }

      const localSize = task.size;
      const startOffset = Math.min(task.transferred, localSize);
      const handle = await sftpOpen(sftp, task.remotePath, startOffset > 0 ? "r+" : "w");
      const fd = fs.openSync(task.localPath, "r");
      try {
        let pos = startOffset;
        while (pos < localSize) {
          await this._wait(task);
          const len = Math.min(CHUNK, localSize - pos);
          const buf = Buffer.alloc(len);
          const n = fs.readSync(fd, buf, 0, len, pos);
          if (!n) break;
          await sftpWrite(sftp, handle, buf, 0, n, pos);
          pos += n;
          task.transferred = pos;
          this._tick(task);
        }
      } finally {
        fs.closeSync(fd);
        await sftpClose(sftp, handle);
      }
      if (task.aborted) {
        try {
          fs.unlinkSync(task.localPath);
        } catch {
          /* gone */
        }
        return;
      }
      // preserve mtime from the local file
      try {
        const st = fs.statSync(task.localPath);
        await sftpUtimes(sftp, task.remotePath, st.atimeMs / 1000, st.mtimeMs / 1000);
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(task.localPath);
      } catch {
        /* gone */
      }
    });
  }

  async _runDownload(task) {
    await this._withSftp(task, async (sftp) => {
      const st = await sftpStat(sftp, task.remotePath);
      task.size = st.size;
      // duplicate policy on the local side
      if (fs.existsSync(task.localPath)) {
        if (task.policy === "skip") {
          task.status = "done";
          task.skipped = true;
          return;
        }
        if (task.policy === "rename") {
          task.localPath = path.join(this.dir, `${task.id}-${dedupeName(path.basename(task.localPath), (n) => fs.existsSync(path.join(this.dir, n)))}`);
        }
      }
      const startOffset = Math.min(task.transferred, task.size);
      const handle = await sftpOpen(sftp, task.remotePath, "r");
      const fd = fs.openSync(task.localPath, startOffset > 0 ? "a" : "w");
      try {
        let pos = startOffset;
        while (pos < task.size) {
          await this._wait(task);
          const len = Math.min(CHUNK, task.size - pos);
          const buf = Buffer.alloc(len);
          const n = await sftpRead(sftp, handle, buf, 0, len, pos);
          if (!n) break;
          fs.writeSync(fd, buf, 0, n);
          pos += n;
          task.transferred = pos;
          this._tick(task);
        }
      } finally {
        fs.closeSync(fd);
        await sftpClose(sftp, handle);
      }
      if (task.aborted) {
        try {
          fs.unlinkSync(task.localPath);
        } catch {
          /* gone */
        }
        return;
      }
      try {
        fs.utimesSync(task.localPath, st.atime, st.mtime);
      } catch {
        /* best effort */
      }
    });
  }
}
