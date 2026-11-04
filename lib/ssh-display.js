import stringWidth from "string-width";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function fit(value, width) {
  const text = String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  if (stringWidth(text) <= width) return text + " ".repeat(width - stringWidth(text));
  let result = "";
  for (const { segment } of graphemes.segment(text)) {
    if (stringWidth(result + segment) > width - 1) break;
    result += segment;
  }
  return fit(result + "…", width);
}

export function formatPreAuthBanner(banner) {
  if (!banner) return "";
  const lines = String(banner).replace(/\r\n|\r/g, "\n").replace(/\n+$/, "").split("\n");
  return "Pre-authentication banner message from server:\r\n" + lines.map((line) => "| " + line).join("\r\n") + "\r\nEnd of banner message from server\r\n\r\n";
}

/** All border/body rows occupy the same terminal cells, including CJK text. */
export function connectionHeader(session, { cols = 80, x11, tmuxName, compression } = {}) {
  const width = Math.max(8, Math.min(70, Math.floor(Number(cols) || 80) - 2));
  const target = `${session.user || "root"}@${session.host || "?"}:${session.port || 22}`;
  let compressed = "?";
  if (compression?.outgoing && compression?.incoming) {
    const { outgoing, incoming } = compression;
    const enabled = outgoing !== "none" || incoming !== "none";
    const detail = outgoing === incoming ? outgoing : `out ${outgoing}, in ${incoming}`;
    compressed = `${enabled ? "✓" : "✗"} (${detail})`;
  }
  const title = "dsh-aixterm · SSH session";
  const rows = [
    " ".repeat(Math.max(0, Math.floor((width - stringWidth(title)) / 2))) + title,
    "",
    ` > ${target}`,
    "   • Direct SSH      : ✓",
    `   • SSH compression : ${compressed}`,
    `   • X11-forwarding  : ${x11 ? "✓" : "✗"}`,
  ];
  if (tmuxName) rows.push(`   • tmux            : ${tmuxName}`);
  return "┌" + "─".repeat(width) + "┐\r\n" + rows.map((row) => "│" + fit(row, width) + "│\r\n").join("") + "└" + "─".repeat(width) + "┘\r\n";
}
