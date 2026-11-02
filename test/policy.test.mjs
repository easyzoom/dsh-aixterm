import { test } from "node:test";
import assert from "node:assert/strict";
import { isDangerous, DEFAULT_DANGER_PATTERNS } from "../lib/policy.js";

test("policy: flags destructive commands", () => {
  for (const cmd of ["rm -rf /tmp/x", "sudo systemctl restart x", "dd if=/dev/zero of=/dev/sda", "mkfs.ext4 /dev/sda1", "reboot", "chmod 777 /etc", "kill -9 1", "cat /dev/zero > /dev/sda"]) {
    assert.equal(isDangerous(cmd), true, cmd);
  }
});

test("policy: allows ordinary commands", () => {
  for (const cmd of ["ls -la", "cat /proc/meminfo", "make -j4", "git status", "echo hello", "tail -f /var/log/messages"]) {
    assert.equal(isDangerous(cmd), false, cmd);
  }
});

test("policy: custom pattern list replaces defaults", () => {
  assert.equal(isDangerous("rm -rf x", ["curl "]), false);
  assert.equal(isDangerous("curl http://x", ["curl "]), true);
  assert.equal(isDangerous("", DEFAULT_DANGER_PATTERNS), false);
});
