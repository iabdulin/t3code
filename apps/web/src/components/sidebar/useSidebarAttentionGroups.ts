import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { SidebarListItem } from "../Sidebar.logic";
import {
  attentionDragOrder,
  attentionListItems,
  partitionThreadsByAttention,
  resolveSidebarAttentionGroup,
  shownAttentionRows,
  SIDEBAR_ATTENTION_GROUPS,
  type SidebarAttentionGroup,
} from "./threadAttentionGroup";

const EXPANDED_STORAGE_KEYS: Record<SidebarAttentionGroup, string> = {
  "needs-you": "t3code:sidebar:needs-you-expanded",
  other: "t3code:sidebar:other-expanded",
  "nothing-needed": "t3code:sidebar:nothing-needed-expanded",
};

const useGroupExpanded = (group: SidebarAttentionGroup) =>
  useLocalStorage(EXPANDED_STORAGE_KEYS[group], true, Schema.Boolean);

const mapGroups = <T, U>(
  byGroup: Record<SidebarAttentionGroup, T>,
  fn: (value: T) => U,
): Record<SidebarAttentionGroup, U> =>
  Object.fromEntries(
    SIDEBAR_ATTENTION_GROUPS.map((group) => [group, fn(byGroup[group])]),
  ) as Record<SidebarAttentionGroup, U>;

const threadKey = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/**
 * Splits the flat sidebar's active threads into the Needs you, Other and Nothing needed groups,
 * each foldable with its state kept in localStorage. A folded group still shows the open thread
 * (`openThreadKey`). When `enabled` is false the active list is left as is: `visibleThreads` is
 * `activeThreads` and `listItems` returns its rows unchanged.
 */
export function useSidebarAttentionGroups(
  activeThreads: readonly EnvironmentThreadShell[],
  enabled: boolean,
  openThreadKey: string | null,
) {
  // Hooks cannot be called in a loop; the Record type makes a missing group a compile error.
  const states: Record<SidebarAttentionGroup, ReturnType<typeof useGroupExpanded>> = {
    "needs-you": useGroupExpanded("needs-you"),
    other: useGroupExpanded("other"),
    "nothing-needed": useGroupExpanded("nothing-needed"),
  };
  const expanded = mapGroups(states, ([value]) => value);
  const setters = mapGroups(states, ([, set]) => set);
  const groups = enabled
    ? partitionThreadsByAttention<EnvironmentThreadShell>(activeThreads, isThreadWorking)
    : null;
  const groupByKey =
    groups &&
    new Map(
      SIDEBAR_ATTENTION_GROUPS.flatMap((group) =>
        groups[group].map((thread) => [threadKey(thread), group] as const),
      ),
    );
  return {
    /** Every thread per group, folded or not. Null when grouping is off. */
    groups,
    expanded,
    toggle: (group: SidebarAttentionGroup) => setters[group]((value) => !value),
    /** Active threads in list order, as `listItems` shows them. */
    visibleThreads:
      groups === null
        ? activeThreads
        : SIDEBAR_ATTENTION_GROUPS.flatMap((group) =>
            shownAttentionRows(
              groups[group],
              expanded[group],
              (thread) => threadKey(thread) === openThreadKey,
            ),
          ),
    /** The active list's rows with group headers added and folded rows dropped; as is when off. */
    listItems: (rows: ReadonlyArray<SidebarListItem>) =>
      groupByKey === null ? rows : attentionListItems(rows, groupByKey, expanded, openThreadKey),
    foldKey: SIDEBAR_ATTENTION_GROUPS.map((group) => expanded[group]).join(":"),
    /** Regroups a time-ordered drag preview order (see `attentionDragOrder`); as is when off. */
    dragOrder: (
      keys: ReadonlyArray<string>,
      threadByKey: ReadonlyMap<string, EnvironmentThreadShell>,
    ): ReadonlyArray<string> =>
      groupByKey === null
        ? keys
        : attentionDragOrder(keys, groupByKey, (key) => {
            const thread = threadByKey.get(key);
            return thread && resolveSidebarAttentionGroup(thread, isThreadWorking(thread));
          }),
  };
}

export type SidebarAttentionGroups = ReturnType<typeof useSidebarAttentionGroups>;
