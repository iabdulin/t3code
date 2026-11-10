import type { ThreadAttentionMark } from "@t3tools/contracts";

const HEADING = "what i need from you";
const AFTER_HEADING = /^[*_\s]*(?:\([^)]*\)[*_\s]*)?(?:[:\-–—][*_\s]*(.*))?$/u;
const HEDGE = /\b(?:but|except|unless|however)\b/iu;
const NOTHING_NEEDED = /^nothing\s+needed(?![\w'])/iu;
const NOTHING_NEEDED_FROM_YOU = /^nothing\s+needed\s+from\s+you(?![\w'])/iu;
const NOTHING_OR_NONE = /^(?:nothing|none)(?![\w'])/iu;
const MAX_LONE_SENTENCE_WORDS = 6;

/** The text after a "What I need from you" heading (any case, after `>`, `#`, `*`, `_`) that is
 *  followed by the end of the line, a colon, a dash or "(" with optional emphasis around them.
 *  Returns the inline text after a colon or dash, "" when there is none, or null for prose. */
function headingInlineText(line: string): string | null {
  const text = line.replace(/^#+/u, "").replace(/^[*_\s]+/u, "");
  if (!text.toLowerCase().startsWith(HEADING)) return null;
  const match = AFTER_HEADING.exec(text.slice(HEADING.length));
  return match === null ? null : (match[1] ?? "");
}

function stripListMarkerAndEmphasis(line: string): string {
  return line
    .replace(/^(?:[-*+]|\d+[.)])\s+/u, "")
    .replace(/^[*_]+|[*_]+$/gu, "")
    .trim();
}

const firstSentence = (text: string) => text.split(/[.!?]/u, 1)[0]!;

/** One sentence, at most six words and no comma, starting with "nothing" or "none". */
function isLoneShortNothing(text: string): boolean {
  const sentence = firstSentence(text);
  return (
    NOTHING_OR_NONE.test(text) &&
    !text.includes(",") &&
    /^[.!?]*$/u.test(text.slice(sentence.length).trim()) &&
    sentence.trim().split(/\s+/u).length <= MAX_LONE_SENTENCE_WORDS
  );
}

/** A last line without the heading counts only when it starts "Nothing needed from you" and its
 *  first sentence has no hedge word; otherwise null, so such a message never gives needs-you. */
function classifyLastLine(line: string): ThreadAttentionMark | null {
  const text = stripListMarkerAndEmphasis(line);
  return NOTHING_NEEDED_FROM_YOU.test(text) && !HEDGE.test(firstSentence(text))
    ? "nothing-needed"
    : null;
}

/** What a message's closing "What I need from you" section asks for, null for an empty one. Its
 *  first line (inline heading text, else the next non-empty line) is nothing-needed if it starts
 *  "nothing needed" with no but/except/unless/however in its first sentence, or is a lone short
 *  "nothing"/"none" sentence; else needs-you. Without the heading, see `classifyLastLine`. */
export function classifyClosingSection(messageText: string): ThreadAttentionMark | null {
  const lines = messageText.split(/\r?\n/u).map((line) => line.trim().replace(/^(?:>\s*)+/u, ""));
  const headingIndex = lines.findLastIndex((line) => headingInlineText(line) !== null);
  if (headingIndex < 0) {
    const last = lines.findLast((line) => line.length > 0);
    return last === undefined ? null : classifyLastLine(last);
  }
  const inline = headingInlineText(lines[headingIndex]!)!.trim();
  const first = inline || lines.slice(headingIndex + 1).find((line) => line.length > 0);
  if (first === undefined) return null;
  const text = stripListMarkerAndEmphasis(first);
  if (NOTHING_NEEDED.test(text) && !HEDGE.test(firstSentence(text))) return "nothing-needed";
  return isLoneShortNothing(text) ? "nothing-needed" : "needs-you";
}
