function emptyRows(count) {
  return Array.from({ length: count }, () => ({ no: "", time: "" }));
}

/**
 * Track logical terminal lines with xterm markers.
 *
 * Buffer indexes are not stable: once scrollback is full xterm trims the first
 * row and reuses the same indexes. Markers move with their rows, which lets the
 * gutter keep monotonic line numbers without guessing how many rows were
 * discarded. Wrapped continuation rows intentionally have no label.
 */
export function createTerminalGutterTracker(term) {
  const entries = new Map();
  let nextLineNo = 1;
  let pendingLineFeeds = 0;
  let disposed = false;

  const lineFeedDisposable = term.onLineFeed(() => {
    pendingLineFeeds += 1;
  });

  function currentEntriesByLine() {
    const byLine = new Map();
    for (const [id, entry] of entries) {
      if (entry.marker.isDisposed || entry.marker.line < 0) {
        entries.delete(id);
        continue;
      }
      const previous = byLine.get(entry.marker.line);
      if (!previous || entry.no < previous.no) byLine.set(entry.marker.line, entry);
    }
    return byLine;
  }

  function addLine(line, timestamp, byLine) {
    if (byLine.has(line)) return;
    const buffer = term.buffer.active;
    const bufferLine = buffer.getLine(line);
    if (!bufferLine || bufferLine.isWrapped) return;
    const cursorLine = buffer.baseY + buffer.cursorY;
    const marker = term.registerMarker(line - cursorLine);
    if (!marker) return;
    const entry = { marker, no: nextLineNo, time: timestamp };
    nextLineNo += 1;
    entries.set(marker.id, entry);
    byLine.set(line, entry);
    marker.onDispose(() => entries.delete(marker.id));
  }

  function recordWrite(timestamp = Date.now()) {
    if (disposed) return;
    const buffer = term.buffer.active;
    if (!buffer || buffer.type !== "normal") {
      pendingLineFeeds = 0;
      return;
    }

    const cursorLine = buffer.baseY + buffer.cursorY;
    let start = cursorLine;
    let logicalLinesBack = pendingLineFeeds;
    pendingLineFeeds = 0;

    // Auto-wrap moves through physical rows without firing onLineFeed. First
    // find the current logical line's start, then cross one complete logical
    // line for every explicit LF parsed in this write.
    while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
    while (start > 0 && logicalLinesBack > 0) {
      start -= 1;
      while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
      logicalLinesBack -= 1;
    }

    const byLine = currentEntriesByLine();
    const safeTime = Number.isFinite(timestamp) ? timestamp : Date.now();
    for (let line = start; line <= cursorLine; line += 1) addLine(line, safeTime, byLine);
  }

  function visibleRows() {
    const count = Math.max(0, Number(term.rows) || 0);
    const buffer = term.buffer.active;
    if (!buffer || buffer.type !== "normal") return emptyRows(count);
    const byLine = currentEntriesByLine();
    const rows = [];
    for (let offset = 0; offset < count; offset += 1) {
      const entry = byLine.get(buffer.viewportY + offset);
      rows.push(entry ? { no: entry.no, time: entry.time } : { no: "", time: "" });
    }
    return rows;
  }

  function reset() {
    pendingLineFeeds = 0;
    nextLineNo = 1;
    for (const entry of [...entries.values()]) entry.marker.dispose();
    entries.clear();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    lineFeedDisposable.dispose();
    reset();
  }

  return { recordWrite, visibleRows, reset, dispose };
}
