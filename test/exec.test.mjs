import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { exec } from "../lib/ssh.js";
const { Server } = ssh2;

// End-to-end exec test against an in-process ssh2 server (no external host).
test("exec: runs a command against an in-process ssh2 server", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const hostKey = privateKey.export({ type: "pkcs1", format: "pem" });

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => {
      client.on("session", (accept) => {
        const sess = accept();
        sess.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write("ran:" + info.command);
          stream.stderr.write("");
          stream.exit(0);
          stream.end();
        });
      });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const session = { host: "127.0.0.1", port, user: "tester", auth: { kind: "password" } };
    const result = await exec(session, "any", "echo-hi", { timeoutMs: 10000 });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "ran:echo-hi");
  } finally {
    server.close();
  }
});
