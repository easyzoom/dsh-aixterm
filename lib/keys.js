// lib/keys.js — managed SSH keys stored under <dataDir>/keys (mode 600).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ssh2 from "ssh2";

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const KEYGEN_ATTEMPTS = 8;

export function keysDirOf(dataDir) {
  return path.join(dataDir, "keys");
}

function assertName(name) {
  if (!NAME_RE.test(String(name || ""))) throw new Error("invalid-key-name");
}

export function keyPathOf(dataDir, name) {
  assertName(name);
  return path.join(keysDirOf(dataDir), name);
}

/** List managed keys with type, fingerprint and mtime. Never returns key bytes. */
export function listKeys(dataDir) {
  const dir = keysDirOf(dataDir);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => NAME_RE.test(name))
    .map((name) => {
      const file = path.join(dir, name);
      let type = "unknown";
      let fingerprint = "";
      try {
        const parsed = ssh2.utils.parseKey(fs.readFileSync(file));
        if (parsed instanceof Error) throw parsed;
        type = parsed.type || "unknown";
        const blob = parsed.getPublicSSH && parsed.getPublicSSH();
        if (blob) {
          fingerprint =
            "SHA256:" + crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
        }
      } catch {
        /* unreadable or unsupported key */
      }
      let mtime = "";
      try {
        mtime = fs.statSync(file).mtime.toISOString();
      } catch {
        /* vanished */
      }
      return { name, type, fingerprint, mtime };
    });
}

/** Generate a new ed25519 key; returns the public line for authorized_keys. */
export function generateKey(dataDir, name) {
  assertName(name);
  const dir = keysDirOf(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < KEYGEN_ATTEMPTS; attempt += 1) {
    const pair = ssh2.utils.generateKeyPairSync("ed25519");
    const privateKey = ssh2.utils.parseKey(pair.private);
    const publicKey = ssh2.utils.parseKey(pair.public);
    if (privateKey instanceof Error || publicKey instanceof Error) continue;
    fs.writeFileSync(path.join(dir, name), pair.private, { mode: 0o600 });
    return { name, type: "ssh-ed25519", publicKey: pair.public };
  }
  throw new Error("key-generation-failed");
}

/** Import an existing private key (validated before writing). */
export function importKey(dataDir, name, privateKey) {
  assertName(name);
  const text = String(privateKey || "");
  if (!text.trim()) throw new Error("empty-private-key");
  const parsed = ssh2.utils.parseKey(text);
  if (parsed instanceof Error) throw new Error("invalid-private-key");
  const dir = keysDirOf(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, name), text, { mode: 0o600 });
  return { name, type: parsed.type || "unknown" };
}

export function deleteKey(dataDir, name) {
  assertName(name);
  const file = path.join(keysDirOf(dataDir), name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}
