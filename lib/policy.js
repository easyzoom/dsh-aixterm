// lib/policy.js — danger-command policy shared by the host routes and tests.
export const DEFAULT_DANGER_PATTERNS = [
  "rm ",
  "rm -",
  "rmdir ",
  "dd ",
  "mkfs",
  "reboot",
  "shutdown",
  "halt",
  "poweroff",
  "sudo ",
  "chmod 777",
  "chown ",
  "kill -9",
  "opkg remove",
  "apt remove",
  "apt purge",
  "systemctl disable",
  "passwd ",
  "userdel",
  "fdisk",
  "wipefs",
  "> /dev/",
];

/** True when `text` contains any configured dangerous substring. */
export function isDangerous(text, patterns = DEFAULT_DANGER_PATTERNS) {
  const value = String(text || "");
  if (!value) return false;
  return (patterns || []).some((pattern) => pattern && value.includes(pattern));
}
