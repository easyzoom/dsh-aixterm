import assert from "node:assert/strict";
import test from "node:test";

import { createTerminalGutterTracker } from "../src/client/terminal-gutter.js";

function mockTerminal({ rows = 4 } = {}) {
  let lineFeed;
  let markerId = 0;
  const lines = Array.from({ length: rows }, () => ({ isWrapped: false }));
  const markers = new Set();
  const buffer = { type: "normal", baseY: 0, cursorY: 0, viewportY: 0, length: rows, getLine: (line) => lines[line] };
  const term = {
    rows,
    buffer: { active: buffer },
    onLineFeed(handler) {
      lineFeed = handler;
      return { dispose() { lineFeed = null; } };
    },
    registerMarker(offset = 0) {
      const listeners = new Set();
      const marker = {
        id: ++markerId,
        line: buffer.baseY + buffer.cursorY + offset,
        isDisposed: false,
        onDispose(handler) {
          listeners.add(handler);
          return { dispose() { listeners.delete(handler); } };
        },
        dispose() {
          if (marker.isDisposed) return;
          marker.isDisposed = true;
          marker.line = -1;
          for (const handler of listeners) handler();
        },
      };
      markers.add(marker);
      return marker;
    },
  };

  return {
    term,
    buffer,
    lines,
    lineFeeds(count = 1) {
      for (let i = 0; i < count; i += 1) lineFeed?.();
    },
    trim(count) {
      for (const marker of markers) {
        if (marker.isDisposed) continue;
        marker.line -= count;
        if (marker.line < 0) marker.dispose();
      }
    },
  };
}

test("gutter timestamps only materialized logical lines after a parsed write", () => {
  const mock = mockTerminal({ rows: 5 });
  const tracker = createTerminalGutterTracker(mock.term);

  tracker.recordWrite(1_000);
  assert.deepEqual(tracker.visibleRows(), [
    { no: 1, time: 1_000 },
    { no: "", time: "" },
    { no: "", time: "" },
    { no: "", time: "" },
    { no: "", time: "" },
  ]);

  mock.lineFeeds(2);
  mock.buffer.cursorY = 2;
  tracker.recordWrite(2_000);
  assert.deepEqual(tracker.visibleRows().slice(0, 3), [
    { no: 1, time: 1_000 },
    { no: 2, time: 2_000 },
    { no: 3, time: 2_000 },
  ]);
  tracker.dispose();
});

test("line numbers remain monotonic when xterm trims and reuses buffer indexes", () => {
  const mock = mockTerminal({ rows: 3 });
  const tracker = createTerminalGutterTracker(mock.term);

  tracker.recordWrite(100);
  mock.lineFeeds(2);
  mock.buffer.cursorY = 2;
  tracker.recordWrite(200);

  mock.trim(1);
  mock.lineFeeds(1);
  // At a full scrollback buffer xterm reuses the last physical index.
  mock.buffer.cursorY = 2;
  tracker.recordWrite(300);

  assert.deepEqual(tracker.visibleRows(), [
    { no: 2, time: 200 },
    { no: 3, time: 200 },
    { no: 4, time: 300 },
  ]);
  tracker.dispose();
});

test("wrapped continuations and the alternate buffer do not invent gutter labels", () => {
  const mock = mockTerminal({ rows: 3 });
  mock.lines[1].isWrapped = true;
  mock.buffer.cursorY = 2;
  const tracker = createTerminalGutterTracker(mock.term);

  mock.lineFeeds(2);
  tracker.recordWrite(500);
  assert.deepEqual(tracker.visibleRows(), [
    { no: 1, time: 500 },
    { no: "", time: "" },
    { no: 2, time: 500 },
  ]);

  mock.buffer.type = "alternate";
  assert.deepEqual(tracker.visibleRows(), [
    { no: "", time: "" },
    { no: "", time: "" },
    { no: "", time: "" },
  ]);
  tracker.dispose();
});

test("explicit line feeds walk across every auto-wrapped logical line", () => {
  const mock = mockTerminal({ rows: 7 });
  for (const line of [1, 2, 4, 5]) mock.lines[line].isWrapped = true;
  mock.buffer.cursorY = 6;
  const tracker = createTerminalGutterTracker(mock.term);

  mock.lineFeeds(2);
  tracker.recordWrite(700);

  assert.deepEqual(tracker.visibleRows(), [
    { no: 1, time: 700 },
    { no: "", time: "" },
    { no: "", time: "" },
    { no: 2, time: 700 },
    { no: "", time: "" },
    { no: "", time: "" },
    { no: 3, time: 700 },
  ]);
  tracker.dispose();
});

test("reset restarts gutter numbering and releases old markers", () => {
  const mock = mockTerminal({ rows: 2 });
  const tracker = createTerminalGutterTracker(mock.term);
  tracker.recordWrite(100);

  tracker.reset();
  tracker.recordWrite(200);

  assert.deepEqual(tracker.visibleRows()[0], { no: 1, time: 200 });
  tracker.dispose();
});
