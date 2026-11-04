import assert from "node:assert/strict";
import test from "node:test";

import { detectPromptCwd, readTerminalPromptCwd, resolveFollowPath } from "../src/client/terminal-cwd.js";

test("detects cwd from common POSIX, PowerShell and cmd prompts", () => {
  assert.equal(detectPromptCwd("root@TinaLinux:~# "), "~");
  assert.equal(detectPromptCwd("dev@host:/srv/app$ "), "/srv/app");
  assert.equal(detectPromptCwd("[root@host /var/log]# "), "/var/log");
  assert.equal(detectPromptCwd("PS C:\\Users\\alice> "), "C:\\Users\\alice");
  assert.equal(detectPromptCwd("C:\\work\\repo>"), "C:\\work\\repo");
  assert.equal(detectPromptCwd("downloaded root@host:/tmp# as text"), "");
});

test("reads a wrapped prompt from the active xterm logical line", () => {
  const lines = [
    { isWrapped: false, translateToString: () => "root@device:/very/" },
    { isWrapped: true, translateToString: () => "long/path# " },
  ];
  const term = {
    buffer: {
      active: {
        type: "normal",
        baseY: 0,
        cursorY: 1,
        getLine: (line) => lines[line],
      },
    },
  };
  assert.equal(readTerminalPromptCwd(term), "/very/long/path");
});

test("preserves a real path space at an automatic wrap boundary", () => {
  const lines = [
    { isWrapped: false, translateToString: (trimRight) => (trimRight ? "root@device:/home/alice/My" : "root@device:/home/alice/My ") },
    { isWrapped: true, translateToString: () => "Documents# " },
  ];
  const term = {
    buffer: {
      active: {
        type: "normal",
        baseY: 0,
        cursorY: 1,
        getLine: (line) => lines[line],
      },
    },
  };
  assert.equal(readTerminalPromptCwd(term), "/home/alice/My Documents");
});

test("drops xterm's empty wide-character wrap placeholder without dropping real spaces", () => {
  const prefix = "root@device:/12345678901234";
  const cells = [...prefix].map((chars) => ({ getChars: () => chars, getWidth: () => 1 }));
  cells.push({ getChars: () => "", getWidth: () => 1 });
  const lines = [
    {
      isWrapped: false,
      length: cells.length,
      getCell: (index) => cells[index],
      translateToString: () => `${prefix} `,
    },
    { isWrapped: true, translateToString: () => "中# " },
  ];
  const term = {
    buffer: {
      active: {
        type: "normal",
        baseY: 0,
        cursorY: 1,
        getLine: (line) => lines[line],
      },
    },
  };
  assert.equal(readTerminalPromptCwd(term), "/12345678901234中");
});

test("resolves tilde prompts against the SFTP home path", () => {
  assert.equal(resolveFollowPath("~", "/home/alice"), "/home/alice");
  assert.equal(resolveFollowPath("~/src/app", "/home/alice"), "/home/alice/src/app");
  assert.equal(resolveFollowPath("/opt/app", "/home/alice"), "/opt/app");
  assert.equal(resolveFollowPath("~", ""), "");
});
