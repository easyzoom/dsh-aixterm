import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXshell, parseMoba, parseJsonSessions, exportJson, exportMoba } from "../lib/import.js";

test("import: Xshell .xsh", () => {
  const text = `[CONNECTION]\nProtocol=SSH\nHost=10.0.0.5\nPort=2222\n[CONNECTION:AUTHENTICATION]\nUserName=root\n\n[CONNECTION]\nProtocol=SSH\nHost=10.0.0.6\nPort=22\n[CONNECTION:AUTHENTICATION]\nUserName=admin\n`;
  const out = parseXshell(text);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { name: "root@10.0.0.5", group: "Xshell", host: "10.0.0.5", port: 2222, user: "root" });
  assert.equal(out[1].user, "admin");
});

test("import: MobaXterm .mxtsessions", () => {
  const text = `[Bookmarks]\r\nSubRep=Lab\r\nbox1=#109#0%192.168.1.10%22%root%%%22%%0%0%0%%%-1%0%0%0%%1080%%0%0%1%0%0%0%%%Lab%\r\nbox2=#109#0%192.168.1.11%2222%admin%%%22%%0%0%0%%%-1%0%0%0%%1080%%0%0%1%0%0%0%%%Lab%\r\n`;
  const out = parseMoba(text);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { name: "box1", group: "Lab", host: "192.168.1.10", port: 22, user: "root" });
  assert.equal(out[1].port, 2222);
});

test("import: JSON round-trip and Moba export round-trip", () => {
  const sessions = [
    { id: "a", name: "alpha", group: "G", host: "10.1.1.1", port: 22, user: "root", auth: { kind: "password", credentialEnv: "PW_A" } },
    { id: "b", name: "beta", group: "G", host: "10.1.1.2", port: 2222, user: "admin", auth: { kind: "key", keyPath: "/home/u/.ssh/id_ed25519" }, proxyJump: "a" },
  ];
  const parsed = parseJsonSessions(exportJson(sessions));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].auth.credentialEnv, "PW_A");
  assert.equal(parsed[1].auth.kind, "key");
  assert.equal(parsed[1].proxyJumpName, "alpha");

  const moba = exportMoba(sessions);
  const back = parseMoba(moba);
  assert.equal(back.length, 2);
  assert.equal(back[0].host, "10.1.1.1");
  assert.equal(back[1].port, 2222);
});
