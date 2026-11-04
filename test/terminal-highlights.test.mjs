import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordRules, findLineHighlights, createTerminalHighlighter } from "../src/client/terminal-highlights.js";

function line(text, styled = new Set()) {
  const cells = [];
  for (const character of text) {
    const width = /[中]/u.test(character) ? 2 : 1, x = cells.length;
    cells.push({ getChars: () => character, getWidth: () => width, getFgColorMode: () => styled.has(x) ? 1 : 0, getBgColorMode: () => 0 });
    if (width === 2) cells.push({ getChars: () => "", getWidth: () => 0, getFgColorMode: () => 0, getBgColorMode: () => 0 });
  }
  return { length: cells.length, getCell: (x) => cells[x] };
}

test("standard highlights default on, avoid partial words and leave custom rules intact", () => {
  const prefs = { highlights: [{ pattern: "ERROR", color: "#123456" }] };
  const copy = JSON.stringify(prefs);
  const matches = findLineHighlights(line("ERROR WARNING OK INFO DEBUG token book"), keywordRules(prefs));
  assert.equal(matches.length, 5);
  assert.equal(matches[0].color, "#123456");
  assert.equal(new Set(matches.map((m) => m.color)).size, 5);
  assert.equal(JSON.stringify(prefs), copy);
  assert.equal(findLineHighlights(line("ERROR WARNING"), keywordRules({ standardHighlights: false, highlights: [] })).length, 0);
  assert.equal(findLineHighlights(line("ERROR WARNING"), keywordRules({ standardHighlights: false, highlights: prefs.highlights })).length, 1);
});

test("remote colors take precedence and wide cells keep correct highlight columns", () => {
  const content = line("中ERROR OK", new Set([2]));
  const matches = findLineHighlights(content, keywordRules({}));
  assert.deepEqual(matches.map(({ x, width }) => ({ x, width })), [{ x: 8, width: 2 }]);
  assert.notEqual(keywordRules({ theme: "light" })[0].color, keywordRules({ theme: "dark" })[0].color);
  for (const attribute of ["getBgColorMode", "isInverse", "isInvisible"]) {
    const styled = line("ERROR"), first = styled.getCell(0);
    first[attribute] = () => 1;
    assert.equal(findLineHighlights(styled, keywordRules({})).length, 0);
  }
});

test("decorations reuse unchanged matches, disappear in alternate screen and dispose without rewriting text", () => {
  const pending = new Map(), handlers = {}, decorated = [];
  let nextId = 0;
  const content = line("ERROR OK");
  const active = { type: "normal", baseY: 0, cursorY: 0, viewportY: 0, length: 1, getLine: () => content };
  const terminal = {
    rows: 1, buffer: { active },
    write: () => assert.fail("highlighting must not rewrite terminal output"),
    registerMarker: (offset) => ({ line: offset, isDisposed: false, dispose() { this.isDisposed = true; } }),
    registerDecoration: (options) => { const result = { ...options, disposed: false, dispose() { this.disposed = true; } }; decorated.push(result); return result; },
    onRender: (cb) => { handlers.render = cb; return { dispose() {} }; },
    onScroll: (cb) => { handlers.scroll = cb; return { dispose() {} }; },
    onResize: (cb) => { handlers.resize = cb; return { dispose() {} }; },
  };
  const highlighter = createTerminalHighlighter(terminal, { schedule: (cb) => { pending.set(++nextId, cb); return nextId; }, cancel: (id) => pending.delete(id) });
  const flush = () => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach((cb) => cb()); };
  highlighter.update({}); flush();
  assert.equal(decorated.length, 2);
  handlers.render(); flush();
  assert.equal(decorated.length, 2, "unchanged render does not create an endless decoration/render loop");
  active.type = "alternate"; handlers.render(); flush();
  assert.ok(decorated.every((d) => d.disposed));
  active.type = "normal"; handlers.render(); flush();
  assert.equal(decorated.length, 4);
  highlighter.update({ standardHighlights: false }); flush();
  assert.ok(decorated.every((d) => d.disposed));
  active.length = 1000; terminal.rows = 1000;
  highlighter.update({}); flush();
  assert.equal(decorated.filter((d) => !d.disposed).length, 500, "decoration resources remain bounded");
  active.viewportY = 999; terminal.rows = 1;
  handlers.scroll(); flush();
  assert.equal(decorated.filter((d) => !d.disposed).length, 2, "scrolling releases off-screen markers");
  highlighter.dispose(); assert.equal(pending.size, 0);
  assert.ok(decorated.every((d) => d.disposed && d.marker.isDisposed));
});
