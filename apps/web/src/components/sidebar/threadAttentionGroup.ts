import { threadAttentionMark } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { isLatestRunSettled } from "~/session-logic";
import { sidebarListItemId, sidebarMarkerId, type SidebarListItem } from "../Sidebar.logic";

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

/** A group's rows on screen: all of them, or only the open thread's while the group is folded. */
export function shownAttentionRows<T>(
  rows: ReadonlyArray<T>,
  expanded: boolean,
  isOpenThread: (row: T) => boolean,
): ReadonlyArray<T> {
  return expanded ? rows : rows.filter(isOpenThread);
}

/** The group each active thread key belongs to; a key that is absent has no known group. */
export type SidebarAttentionGroupByKey = ReadonlyMap<string, SidebarAttentionGroup>;

/**
 * Buckets items by group in one pass and returns the non-empty groups in `SIDEBAR_ATTENTION_GROUPS`
 * order, each with its items in input order. An item whose `groupOf` is undefined is dropped.
 */
function groupRows<T>(
  items: ReadonlyArray<T>,
  groupOf: (item: T) => SidebarAttentionGroup | undefined,
): ReadonlyArray<readonly [SidebarAttentionGroup, ReadonlyArray<T>]> {
  const buckets = new Map<SidebarAttentionGroup, T[]>();
  for (const item of items) {
    const group = groupOf(item);
    if (group === undefined) continue;
    const bucket = buckets.get(group);
    if (bucket) bucket.push(item);
    else buckets.set(group, [item]);
  }
  return SIDEBAR_ATTENTION_GROUPS.flatMap((group) => {
    const bucket = buckets.get(group);
    return bucket ? [[group, bucket] as const] : [];
  });
}

const isThreadRow = (item: SidebarListItem): item is Extract<SidebarListItem, { kind: "thread" }> =>
  item.kind === "thread";

/**
 * The active list's items from its thread rows: each group with threads gets its header, then its
 * shown rows in input order. `groupByKey` holds every active key's group; a thread row in no group
 * goes to Other, and marker items are dropped.
 */
export function attentionListItems(
  rows: ReadonlyArray<SidebarListItem>,
  groupByKey: SidebarAttentionGroupByKey,
  expanded: Readonly<Record<SidebarAttentionGroup, boolean>>,
  openThreadKey: string | null,
): SidebarListItem[] {
  return groupRows(rows.filter(isThreadRow), (row) => groupByKey.get(row.key) ?? "other").flatMap(
    ([group, groupItems]): SidebarListItem[] => [
      { kind: "marker", marker: `${group}-header` },
      ...shownAttentionRows(groupItems, expanded[group], (row) => row.key === openThreadKey),
    ],
  );
}

const isAttentionHeader = (item: SidebarListItem) =>
  item.kind === "marker" &&
  SIDEBAR_ATTENTION_GROUPS.some((group) => item.marker === `${group}-header`);

/**
 * A time-ordered drag preview's active order, regrouped: each group's header id, then its keys in
 * the given order. `groupByKey` holds every active key's group, folded or not; `groupOfOther`
 * places a key from outside the active list, such as a thread dragged in from Pinned.
 */
export function attentionDragOrder(
  keys: ReadonlyArray<string>,
  groupByKey: SidebarAttentionGroupByKey,
  groupOfOther: (key: string) => SidebarAttentionGroup | undefined,
): string[] {
  return groupRows(keys, (key) => groupByKey.get(key) ?? groupOfOther(key)).flatMap(
    ([group, groupKeys]) => [sidebarMarkerId(`${group}-header`), ...groupKeys],
  );
}

/**
 * The active list's drag preview when it has attention headers, else null. An `order` from
 * `attentionDragOrder` naming every shown header places every row in its group. Otherwise headers
 * stay put, a row that keeps its neighbours keeps its slot, and a moved row follows its predecessor.
 */
export function attentionDragPreview(
  items: ReadonlyArray<SidebarListItem>,
  activeRows: ReadonlyArray<Extract<SidebarListItem, { kind: "thread" }>>,
  draggedKey: string,
  order: ReadonlyArray<string> = [],
): SidebarListItem[] | null {
  const headers = new Map(
    items.filter(isAttentionHeader).map((item) => [sidebarListItemId(item), item]),
  );
  if (headers.size === 0) return null;
  let run = items.filter(
    (item) => (item.kind === "thread" && item.section === "active") || isAttentionHeader(item),
  );
  const rowKeys = (list: ReadonlyArray<SidebarListItem>) =>
    list.flatMap((item) => (item.kind === "thread" ? [item.key] : [])).join("\n");
  if ([...headers.keys()].every((id) => order.includes(id))) {
    const rows = new Map(activeRows.map((row) => [row.key, row]));
    run = order.flatMap((id) => {
      const item = rows.get(id) ?? headers.get(id);
      return item ? [item] : [];
    });
  } else if (rowKeys(run) !== rowKeys(activeRows)) {
    const from = run.findIndex((item) => item.kind === "thread" && item.key === draggedKey);
    if (from !== -1) run.splice(from, 1);
    const to = activeRows.findIndex((row) => row.key === draggedKey);
    if (to !== -1) {
      const before = activeRows[to - 1];
      const at = before ? run.indexOf(before) + 1 : run.findIndex((item) => item.kind === "thread");
      run.splice(at === -1 ? run.length : at, 0, activeRows[to]!);
    }
  }
  return activeRows.length === 0 ? [{ kind: "marker", marker: "active-placeholder" }, ...run] : run;
}
