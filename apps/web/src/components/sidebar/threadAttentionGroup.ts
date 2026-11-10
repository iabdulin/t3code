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

/** The active list's items: each group with threads gets its header, then its shown rows. */
export function attentionListItems(
  groups: Readonly<Record<SidebarAttentionGroup, ReadonlyArray<string>>>,
  expanded: Readonly<Record<SidebarAttentionGroup, boolean>>,
  openThreadKey: string | null,
): ReadonlyArray<
  | { kind: "thread"; key: string; section: "active" }
  | { kind: "marker"; marker: SidebarAttentionHeaderMarker }
> {
  return SIDEBAR_ATTENTION_GROUPS.flatMap((group) =>
    groups[group].length === 0
      ? []
      : [
          { kind: "marker" as const, marker: `${group}-header` as const },
          ...shownAttentionRows(groups[group], expanded[group], (key) => key === openThreadKey).map(
            (key) => ({ kind: "thread" as const, key, section: "active" as const }),
          ),
        ],
  );
}

const isAttentionHeader = (item: SidebarListItem) =>
  item.kind === "marker" &&
  SIDEBAR_ATTENTION_GROUPS.some((group) => item.marker === `${group}-header`);

/**
 * A time-ordered drag preview's active order, regrouped: each group's header id, then its keys in
 * the given order. `groupKeys` holds every active key per group, folded or not; `groupOfOther`
 * places a key from outside the active list, such as a thread dragged in from Pinned.
 */
export function attentionDragOrder(
  keys: ReadonlyArray<string>,
  groupKeys: Readonly<Record<SidebarAttentionGroup, ReadonlyArray<string>>>,
  groupOfOther: (key: string) => SidebarAttentionGroup | undefined,
): string[] {
  const groupByKey = new Map(
    SIDEBAR_ATTENTION_GROUPS.flatMap((group) => groupKeys[group].map((key) => [key, group])),
  );
  const groupOf = (key: string) => groupByKey.get(key) ?? groupOfOther(key);
  return SIDEBAR_ATTENTION_GROUPS.flatMap((group) => {
    const rows = keys.filter((key) => groupOf(key) === group);
    return rows.length === 0 ? [] : [sidebarMarkerId(`${group}-header`), ...rows];
  });
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
