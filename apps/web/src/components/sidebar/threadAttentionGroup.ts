import { threadAttentionMark } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { isLatestRunSettled } from "~/session-logic";

export type SidebarAttentionGroup = "needs-you" | "other" | "nothing-needed";

/** Group order, top to bottom. */
export const SIDEBAR_ATTENTION_GROUPS = [
  "needs-you",
  "other",
  "nothing-needed",
] as const satisfies readonly SidebarAttentionGroup[];

type AttentionThreadInput = Pick<
  EnvironmentThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "hasActionableProposedPlan"
  | "latestRun"
  | "runtime"
> & { readonly source: { readonly tags?: ReadonlyArray<string> | undefined } };

/** The group an open thread belongs to. `working` is whether a turn or resumable background work is in progress. */
export function resolveSidebarAttentionGroup(
  thread: AttentionThreadInput,
  working: boolean,
): SidebarAttentionGroup {
  // Blocked on the user outranks `working`: such a thread is waiting, not working.
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    (thread.pendingSubagentRequest ?? null) !== null ||
    (thread.pendingGuestMessageCount ?? 0) > 0
  ) {
    return "needs-you";
  }
  if (working) return "other";
  if (
    (thread.interactionMode === "plan" &&
      thread.hasActionableProposedPlan &&
      isLatestRunSettled(thread.latestRun, thread.runtime)) ||
    thread.latestRun?.status === "failed"
  ) {
    return "needs-you";
  }
  return threadAttentionMark(thread.source.tags) ?? "other";
}

/** Splits threads by group, keeping the input order inside each group. */
export function partitionThreadsByAttention<T extends AttentionThreadInput>(
  threads: ReadonlyArray<T>,
  isWorking: (thread: T) => boolean,
): Readonly<Record<SidebarAttentionGroup, ReadonlyArray<T>>> {
  const groups: Record<SidebarAttentionGroup, T[]> = {
    "needs-you": [],
    other: [],
    "nothing-needed": [],
  };
  for (const thread of threads) {
    groups[resolveSidebarAttentionGroup(thread, isWorking(thread))].push(thread);
  }
  return groups;
}

export type SidebarAttentionHeaderMarker = `${SidebarAttentionGroup}-header`;

/** The active list's items: each group with threads gets its header, then its rows unless folded. */
export function attentionListItems(
  groups: Readonly<Record<SidebarAttentionGroup, ReadonlyArray<string>>>,
  expanded: Readonly<Record<SidebarAttentionGroup, boolean>>,
): ReadonlyArray<
  | { kind: "thread"; key: string; section: "active" }
  | { kind: "marker"; marker: SidebarAttentionHeaderMarker }
> {
  return SIDEBAR_ATTENTION_GROUPS.flatMap((group) =>
    groups[group].length === 0
      ? []
      : [
          { kind: "marker" as const, marker: `${group}-header` as const },
          ...(expanded[group]
            ? groups[group].map((key) => ({
                kind: "thread" as const,
                key,
                section: "active" as const,
              }))
            : []),
        ],
  );
}
