function cleanTerminalText(value) {
  return String(value || "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\r\n]+/g, "")
    .trim();
}

function bufferLineText(row, finalFragment) {
  if (Number.isInteger(row?.length) && typeof row.getCell === "function") {
    let lastPrintedCell = -1;
    for (let index = 0; index < row.length; index += 1) {
      const chars = row.getCell(index)?.getChars?.() || "";
      // A real printed space reports " "; an unused/wide-wrap placeholder
      // reports "". Keep the former and omit trailing placeholders.
      if (chars) lastPrintedCell = index;
    }
    let text = "";
    for (let index = 0; index <= lastPrintedCell; index += 1) {
      const cell = row.getCell(index);
      const chars = cell?.getChars?.() || "";
      if (chars) text += chars;
      else if ((cell?.getWidth?.() ?? 1) !== 0) text += " ";
    }
    return text;
  }
  return row.translateToString(finalFragment);
}

/** Detect a cwd only from prompt shapes that identify a host or shell. */
export function detectPromptCwd(value) {
  const text = cleanTerminalText(value);
  if (!text) return "";

  let match = text.match(/^PS\s+([A-Za-z]:[\\/][^>]*?)>\s*$/i);
  if (match) return match[1].trim();

  match = text.match(/^([A-Za-z]:[\\/][^>]*?)>\s*$/);
  if (match) return match[1].trim();

  // bash/ash: root@host:/path# or root@host:~$
  match = text.match(/^(?:\([^)]*\)\s*)?[^@\s:]+@[^:\s]+:((?:~|\/).*?)\s*[#$%]\s*$/);
  if (match) return match[1].trim();

  // Common distro prompt: [root@host /path]#
  match = text.match(/^\[[^\]]*?\s((?:~|\/)[^\]]*)\]\s*[#$%]\s*$/);
  if (match) return match[1].trim();

  // zsh/macOS-style prompt: user@host /path %
  match = text.match(/^[^@\s]+@[^\s]+\s+((?:~|\/).*?)\s+[#$%]\s*$/);
  return match ? match[1].trim() : "";
}

/** Read the prompt's complete logical line, including wrapped rows. */
export function readTerminalPromptCwd(term) {
  const buffer = term?.buffer?.active;
  if (!buffer || buffer.type !== "normal") return "";
  const cursorLine = buffer.baseY + buffer.cursorY;
  let start = cursorLine;
  let limit = 32;
  while (start > 0 && buffer.getLine(start)?.isWrapped && limit > 0) {
    start -= 1;
    limit -= 1;
  }
  let text = "";
  for (let line = start; line <= cursorLine; line += 1) {
    const row = buffer.getLine(line);
    if (!row) return "";
    // Cell-aware reconstruction preserves a real path space at the wrap
    // boundary while excluding xterm's empty wide-character placeholder.
    text += bufferLineText(row, line === cursorLine);
  }
  return detectPromptCwd(text);
}

/** Convert a shell's ~/ path to the absolute home discovered by SFTP. */
export function resolveFollowPath(followPath, homePath) {
  const value = String(followPath || "").trim();
  if (value === "~") return homePath || "";
  if (value.startsWith("~/")) {
    if (!homePath) return "";
    return `${String(homePath).replace(/\/+$/, "")}/${value.slice(2)}`;
  }
  return value;
}
