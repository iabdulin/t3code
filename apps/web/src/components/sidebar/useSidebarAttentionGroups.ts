import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  attentionListItems,
  partitionThreadsByAttention,
  shownAttentionRows,
  SIDEBAR_ATTENTION_GROUPS,
  type SidebarAttentionGroup,
} from "./threadAttentionGroup";

const NEEDS_YOU_EXPANDED_KEY = "t3code:sidebar:needs-you-expanded";
const OTHER_EXPANDED_KEY = "t3code:sidebar:other-expanded";
const NOTHING_NEEDED_EXPANDED_KEY = "t3code:sidebar:nothing-needed-expanded";

const threadKey = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/**
 * Splits the flat sidebar's active threads into the Needs you, Other and Nothing needed groups,
 * each foldable with its state kept in localStorage. A folded group still shows the open thread
 * (`openThreadKey`). When `enabled` is false the active list is left as is: `visibleThreads` is
 * `activeThreads` and `listItems` is null.
 */
export function useSidebarAttentionGroups(
  activeThreads: readonly EnvironmentThreadShell[],
  enabled: boolean,
  openThreadKey: string | null,
) {
  const [needsYouExpanded, setNeedsYouExpanded] = useLocalStorage(
    NEEDS_YOU_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const [otherExpanded, setOtherExpanded] = useLocalStorage(
    OTHER_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const [nothingNeededExpanded, setNothingNeededExpanded] = useLocalStorage(
    NOTHING_NEEDED_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const expanded: Record<SidebarAttentionGroup, boolean> = {
    "needs-you": needsYouExpanded,
    other: otherExpanded,
    "nothing-needed": nothingNeededExpanded,
  };
  const setters = {
    "needs-you": setNeedsYouExpanded,
    other: setOtherExpanded,
    "nothing-needed": setNothingNeededExpanded,
  };
  const groups = enabled
    ? partitionThreadsByAttention<EnvironmentThreadShell>(activeThreads, isThreadWorking)
    : null;
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
    listItems:
      groups === null
        ? null
        : attentionListItems(
            {
              "needs-you": groups["needs-you"].map(threadKey),
              other: groups.other.map(threadKey),
              "nothing-needed": groups["nothing-needed"].map(threadKey),
            },
            expanded,
            openThreadKey,
          ),
    foldKey: SIDEBAR_ATTENTION_GROUPS.map((group) => expanded[group]).join(":"),
  };
}

export type SidebarAttentionGroups = ReturnType<typeof useSidebarAttentionGroups>;
