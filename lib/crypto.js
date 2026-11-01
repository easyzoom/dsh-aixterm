// lib/crypto.js — encrypt stored secrets (passwords / key passphrases) at rest.
//
// AES-256-GCM with a per-install random key stored next to the session file
// (mode 600). This protects secrets from casual reading of the JSON file; the
// key lives in the same data dir, so treat the data dir as sensitive. A future
// version can move the key to the OS keychain.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PREFIX = "v1:";
const KEY_FILE = ".aixterm.key";

function loadKey(dataDir) {
  const keyPath = path.join(dataDir, KEY_FILE);
  try {
    const key = fs.readFileSync(keyPath);
    if (key.length === 32) return key;
  } catch {
    /* generate below */
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* best effort on filesystems without chmod */
  }
  return key;
}

/** Encrypt a secret string, returning a `v1:<base64>` blob. */
export function encrypt(dataDir, plaintext) {
  if (plaintext === undefined || plaintext === null) return undefined;
  const key = loadKey(dataDir);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

/** Decrypt a `v1:` blob; passes through legacy plaintext values unchanged. */
export function decrypt(dataDir, blob) {
  if (blob === undefined || blob === null) return undefined;
  if (typeof blob !== "string" || !blob.startsWith(PREFIX)) return blob;
  const key = loadKey(dataDir);
  const raw = Buffer.from(blob.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
