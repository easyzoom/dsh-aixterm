const HEX = /^#[0-9a-fA-F]{6}$/;
const GROUPS = [
  ["error", ["ERROR", "FATAL", "PANIC", "FAILED", "FAILURE", "错误", "失败"]],
  ["warning", ["WARN", "WARNING", "警告"]],
  ["success", ["OK", "SUCCESS", "PASSED", "成功"]],
  ["info", ["INFO", "NOTICE", "信息"]],
  ["debug", ["DEBUG", "TRACE"]],
];
const DARK = { error: "#ff7b72", warning: "#d29922", success: "#3fb950", info: "#58a6ff", debug: "#8b949e" };
const LIGHT = { error: "#cf222e", warning: "#9a6700", success: "#116329", info: "#0969da", debug: "#57606a" };
const expressionFor = (pattern) => new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");

export function keywordRules(prefs = {}) {
  const custom = (Array.isArray(prefs.highlights) ? prefs.highlights : []).filter((r) => r && typeof r.pattern === "string" && r.pattern.trim() && HEX.test(r.color || "")).map((r) => ({ pattern: r.pattern.trim(), color: r.color, wholeWord: false }));
  const palette = prefs.theme === "light" ? LIGHT : DARK;
  const standard = prefs.standardHighlights === false ? [] : GROUPS.flatMap(([category, words]) => words.map((pattern) => ({ pattern, color: palette[category], wholeWord: /^[A-Za-z]+$/.test(pattern) })));
  return [...custom, ...standard];
}

/** Match already-parsed cells, never raw ANSI/OSC text or network fragments. */
export function findLineHighlights(line, rules) {
  let text = "";
  const cells = [], occupied = new Set(), matches = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    cells.push({ x, width: cell.getWidth(), start: text.length, end: text.length + chars.length, plain: cell.getFgColorMode() === 0 && cell.getBgColorMode() === 0 && !cell.isInverse?.() && !cell.isInvisible?.() });
    text += chars;
  }
  for (const rule of rules) {
    const expression = rule.expression || expressionFor(rule.pattern);
    for (const match of text.matchAll(expression)) {
      const start = match.index, end = start + match[0].length;
      if (rule.wholeWord && (/[A-Za-z0-9_]/.test(text[start - 1] || "") || /[A-Za-z0-9_]/.test(text[end] || ""))) continue;
      const span = cells.filter((cell) => cell.start < end && cell.end > start);
      if (!span.length || span.some((cell) => !cell.plain)) continue;
      const x = span[0].x, last = span[span.length - 1], width = last.x + last.width - x;
      if (Array.from({ length: width }, (_, i) => x + i).some((column) => occupied.has(column))) continue;
      for (let i = x; i < x + width; i++) occupied.add(i);
      matches.push({ x, width, color: rule.color });
    }
  }
  return matches.sort((a, b) => a.x - b.x);
}

/** Decorations change presentation only; buffer text, attributes and logs stay intact. */
export function createTerminalHighlighter(term, {
  schedule = (callback) => requestAnimationFrame(callback),
  cancel = (id) => cancelAnimationFrame(id),
} = {}) {
  let rules = [], pending = null, disposed = false;
  const entries = new Map();
  const remove = (entry) => { entry.decoration.dispose(); entry.marker.dispose(); };
  const clear = () => { for (const entry of entries.values()) remove(entry); entries.clear(); };
  const refresh = () => {
    pending = null;
    if (disposed) return;
    const buffer = term.buffer.active;
    if (!rules.length || buffer.type === "alternate") { clear(); return; }
    const desired = new Map();
    for (let row = buffer.viewportY; row < Math.min(buffer.length, buffer.viewportY + term.rows) && desired.size < 500; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      for (const match of findLineHighlights(line, rules)) {
        if (desired.size >= 500) break;
        desired.set(`${row}:${match.x}:${match.width}:${match.color}`, { ...match, row });
      }
    }
    for (const [key, entry] of entries) {
      if (!desired.has(key) || entry.marker.isDisposed || entry.marker.line !== desired.get(key).row) { remove(entry); entries.delete(key); }
    }
    for (const [key, match] of desired) {
      if (entries.has(key)) continue;
      const marker = term.registerMarker(match.row - (buffer.baseY + buffer.cursorY));
      if (!marker) continue;
      const decoration = term.registerDecoration({ marker, x: match.x, width: match.width, foregroundColor: match.color, layer: "bottom" });
      if (decoration) entries.set(key, { marker, decoration }); else marker.dispose();
    }
  };
  const request = () => { if (!disposed && pending === null) pending = schedule(refresh); };
  const listeners = [term.onRender(request), term.onScroll(request), term.onResize(request)];
  return {
    update(prefs) { rules = keywordRules(prefs).map((rule) => ({ ...rule, expression: expressionFor(rule.pattern) })); request(); },
    dispose() { disposed = true; if (pending !== null) cancel(pending); pending = null; listeners.forEach((listener) => listener.dispose()); clear(); },
  };
}
