export type ThreadAttentionMark = "needs-you" | "nothing-needed";

export const THREAD_ATTENTION_TAGS = {
  "needs-you": "attention:needs-you",
  "nothing-needed": "attention:nothing-needed",
} as const satisfies Record<ThreadAttentionMark, string>;

/** The mark a thread's tags carry, or null. Two marks at once read as "needs-you". */
export function threadAttentionMark(
  tags: ReadonlyArray<string> | undefined,
): ThreadAttentionMark | null {
  if (!tags) return null;
  if (tags.includes(THREAD_ATTENTION_TAGS["needs-you"])) return "needs-you";
  if (tags.includes(THREAD_ATTENTION_TAGS["nothing-needed"])) return "nothing-needed";
  return null;
}
