import type { ThreadAttentionMark } from "@t3tools/contracts";

const HEADING = "what i need from you";

function isHeading(line: string): boolean {
  const text = line
    .trim()
    .replace(/^#+/, "")
    .replace(/^[*_\s]+|[*_\s]+$/g, "")
    .replace(/:$/, "")
    .trim();
  return text.toLowerCase() === HEADING;
}

/** What the closing "What I need from you" section of an assistant message asks for.
 *  null when the message has no such section or the section is empty. */
export function classifyClosingSection(messageText: string): ThreadAttentionMark | null {
  const lines = messageText.split(/\r?\n/);
  const headingIndex = lines.findLastIndex(isHeading);
  if (headingIndex < 0) return null;
  const first = lines
    .slice(headingIndex + 1)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) return null;
  const text = first.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^[*_]+|[*_]+$/g, "");
  return text.toLowerCase().startsWith("nothing needed") ? "nothing-needed" : "needs-you";
}
