import { SidebarSectionHeader } from "./SidebarListMarkers";
import type { SidebarAttentionGroup, SidebarAttentionHeaderMarker } from "./threadAttentionGroup";
import type { SidebarAttentionGroups } from "./useSidebarAttentionGroups";

const HEADERS: Record<
  SidebarAttentionHeaderMarker,
  { readonly group: SidebarAttentionGroup; readonly label: string }
> = {
  "needs-you-header": { group: "needs-you", label: "Needs you" },
  "other-header": { group: "other", label: "Other" },
  "nothing-needed-header": { group: "nothing-needed", label: "Nothing needed" },
};

/** A group's foldable header with the group's full count, also when folded. */
export function SidebarAttentionHeader(props: {
  marker: SidebarAttentionHeaderMarker;
  attention: SidebarAttentionGroups;
}) {
  const { group, label } = HEADERS[props.marker];
  return (
    <SidebarSectionHeader
      marker={props.marker}
      label={label}
      count={props.attention.groups?.[group].length ?? 0}
      toggle={{
        expanded: props.attention.expanded[group],
        onToggle: () => props.attention.toggle(group),
      }}
    />
  );
}
