import type { ThreadAttentionMark } from "@t3tools/contracts";

const HEADING = "what i need from you";

function isHeading(line: string): boolean {
  const text = line
    .trim()
    .replace(/^#+/, "")
    .replace(/^[*_\s]+|[*_\s]+$/g, "")
    .replace(/:$/, "")
    .replace(/^[*_\s]+|[*_\s]+$/g, "");
  return text.toLowerCase() === HEADING;
}

function stripListMarkerAndEmphasis(line: string): string {
  return line.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^[*_]+|[*_]+$/g, "");
}

/** What the closing "What I need from you" section of an assistant message asks for.
 *  With a heading, the first body line decides: "nothing"/"none" is nothing-needed, any
 *  other text is needs-you, and an empty body is null. Without a heading, only a last
 *  line starting "nothing needed from you" counts (nothing-needed); otherwise null. */
export function classifyClosingSection(messageText: string): ThreadAttentionMark | null {
  const lines = messageText.split(/\r?\n/).map((line) => line.trim());
  const headingIndex = lines.findLastIndex(isHeading);
  if (headingIndex < 0) {
    const last = lines.findLast((line) => line.length > 0);
    if (last === undefined) return null;
    return stripListMarkerAndEmphasis(last).toLowerCase().startsWith("nothing needed from you")
      ? "nothing-needed"
      : null;
  }
  const first = lines.slice(headingIndex + 1).find((line) => line.length > 0);
  if (first === undefined) return null;
  const text = stripListMarkerAndEmphasis(first).toLowerCase();
  return text.startsWith("nothing") || text.startsWith("none") ? "nothing-needed" : "needs-you";
}
