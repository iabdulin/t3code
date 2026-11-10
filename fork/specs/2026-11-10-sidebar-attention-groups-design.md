# Sidebar groups by what a thread needs from you

Fork-only feature for "My T3 Code" (branch `mine`). Status: design, awaiting approval.

## Summary

The sidebar should work as a to-do list. Today a thread that finished and needs nothing
looks the same as one that ended its turn by asking the user something in plain text.
This change sorts open threads into groups by what they need from the user, so the user
can see at a glance which threads to act on and which to look over and close.

## Why

The user runs many threads at once and wants to keep the number of open ones low. Each
finished thread should be either actioned or closed. To do that, they need to tell the
two kinds apart without opening every thread. Their agents already end each turn with a
"What I need from you" section, so the signal exists in the conversation; the sidebar
just never sees it.

## Goals

- Open threads appear in groups, most pressing first:
  1. **Pinned** (unchanged)
  2. **Needs you**: the agent cannot continue without the user.
  3. **Other**: finished, and T3 cannot tell whether something is needed.
  4. **Nothing needed**: finished, and the agent said nothing is needed.
  5. **Working**, **Snoozed**, **Settled** (unchanged)
- A thread moves between groups on its own as turns start and finish.
- Threads that are already open when the feature ships are sorted too, not only threads
  that finish a turn afterwards.

## Non-goals

- No one-line reason under the title ("Approve the migration plan"). Useful, but it needs
  somewhere to store free text. Left for a later change.
- No "close all" or other new buttons. The user opens a thread before closing it.
- No ranking by project or kind of ask. Snooze is how the user says "not now".
- No change to the project-folders ("boring") sidebar. The groups apply only to the
  default flat sidebar.
- No mobile change. The iPhone app is the App Store build and keeps its list.
- No setting to turn the groups off in this version.
- Not proposed upstream. Upstream Idea #31520 asks for an agent-set status; this fork
  version relies on the user's own closing-section convention.

## Anti-goals

- Never settle, snooze, archive or hide a thread because of its group.
- Never make it unsafe to open the same database with the official app. That rules out
  new event types, new database migrations and new required fields.
- Do not make the nightly upstream rebase fragile. Upstream edits `Sidebar.tsx`,
  `Sidebar.logic.ts` and `settings.ts` almost daily.

## Behaviour

### Which group a thread is in

Checked in this order; the first match wins.

| Order | Condition                                                                                                        | Group                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1     | Snoozed, settled or pinned                                                                                       | As today                                                                       |
| 2     | A turn is in progress, or the thread waits on background work it will resume from                                | Working, as today. With the Working section setting off, it stays in **Other** |
| 3     | A pending approval, a pending question, a guest request, a plan waiting for a go-ahead, or the latest run failed | **Needs you**                                                                  |
| 4     | The server marked it `needs-you`                                                                                 | **Needs you**                                                                  |
| 5     | The server marked it `nothing-needed`                                                                            | **Nothing needed**                                                             |
| 6     | Anything else                                                                                                    | **Other**                                                                      |

Rule 3 uses facts T3 already has, so those threads sort correctly whatever the agent
wrote. A failed thread stays in Needs you until a new run starts or the user settles it,
whether or not the user has opened it.

A server mark is ignored while a turn is in progress, so a stale mark from the previous
turn never places a working thread.

### How the server marks a thread

When a run ends with status `completed`, the server takes the last assistant message of
that run (finished streaming, written by the thread's own agent and not a subagent) and
looks for the closing section:

1. Find the last line whose text is "what i need from you", ignoring case and Markdown
   markup around it (`#`, `*`, `_`, a trailing colon, whitespace). The colon may sit
   inside or outside the bold markers.
2. With such a line, the section body is everything after it. Take the first non-empty
   body line and drop any list marker. If it starts with "nothing" or "none" (ignoring
   case): `nothing-needed`. Any other text: `needs-you`. Empty body: no result.
3. Without such a line, look at the last non-empty line of the message and drop any list
   marker and bold markers. If it starts with "nothing needed from you" (ignoring case):
   `nothing-needed`. Otherwise no result. A message without the heading never gives
   `needs-you`.

A result replaces the thread's mark. No result leaves the thread's mark as it was: a
reply without the section says nothing new about what the thread needs. This covers a
quick answer to a follow-up question, and runs the server starts on its own (idle
compaction, wakes, continuations), without having to tell those runs apart. (Author's
call, not the user's. The user's agents write the section on every turn that finishes or
pauses work, so an ask that gets resolved produces a fresh "Nothing needed".)

When a run ends any other way (`failed`, `interrupted`, `cancelled`, `rolled_back`), the
server removes both marks. Events for a run that is not the thread's latest are ignored.

A thread holds at most one mark. Setting one removes the other.

### Threads that are already open

When the server starts, it sorts every thread that is not settled or archived, has no
mark, and whose latest run is `completed`. It walks back from the latest run through at
most five runs and uses the first one whose last message gives a result. It stops early,
leaving the thread unmarked, at a run that did not end `completed`. Looking back matters
because the latest run can be an idle compaction or a wake with no section. This pass
also covers a run that finished while the reaction was not listening.

### What the user sees

```
PINNED
  PR #47 - Remove ...

NEEDS YOU  3
  sfdp scoring                      2h
  Weekly Project                    13h
  Vite Plus and Cypress      Failed 1h

OTHER  2
  Bugs in delegation                17h
  PR 283 - Include Bot ...          18h

NOTHING NEEDED  4
  Status Update Request             20m
  PR #297 - Add pre-p...            21m
  ...

WORKING  2                          folded, as today
SNOOZED / SETTLED                   as today
```

- Each new group has a header with its name and count. A group with no threads shows no
  header.
- "Needs you", "Other" and "Nothing needed" can be folded, like Working. They start
  open, and the choice is remembered on the device.
- Inside a group, threads keep the order the active list uses today.
- Rows look as they do today, including the status label and the Thread rows setting.
- The three groups are parts of the existing active list, not new sections, so every
  drag gesture works as today: drag to Pinned, onto Settled, or out of Pinned, Snoozed
  or Settled into the open list. A thread dropped into the open list lands in the group
  its state puts it in, not where it was dropped. Pin, settle and snooze from the row
  menu work as today.

## Approaches considered

- **A. Read the closing section (chosen).** Costs nothing per turn, gives the same
  answer every time and needs no change in agent behaviour. Works only for agents that
  follow the user's instructions file; other threads land in Other.
- **B. The agent reports its status with a tool call.** Works for any provider and
  matches upstream Idea #31520. Larger change, an extra tool call on every turn, and an
  agent that forgets leaves its thread unsorted.
- **C. A small model classifies the last message.** Works with no cooperation from
  agents. Costs tokens on every turn and will sometimes be wrong.

The user picked A. The grouping in the sidebar is the same for all three, so the source
of the mark can change later without redoing the sidebar work.

## Interface

Two contracts. Both are new; no existing caller changes.

**The mark** is the contract between server and client. It is carried by the existing
thread tags (`thread.tags` on `OrchestrationV2ThreadShell`):

- `attention:needs-you`
- `attention:nothing-needed`

A thread has neither tag or exactly one. Only the server writes them, with the existing
`thread.tag.set` command, which produces the existing `thread.tags-updated` event. Tags
live inside the thread's `payload_json`, so there is no migration. A build without this
feature reads the tags as plain strings and ignores them.

**The classifier** is a pure function shared by the turn-end reaction and the start-up
pass:

```ts
/** What the closing "What I need from you" section of an assistant message asks for.
 *  null when the message has no such section or the section is empty. */
function classifyClosingSection(messageText: string): "needs-you" | "nothing-needed" | null;
```

On the client, one pure function maps a thread to its group. It takes the thread and
whether it is working, and returns `"needs-you" | "other" | "nothing-needed"`. It is the
only place that reads the two tags.

## Constraints and decided implementation details

- **Server reaction.** A new service in `apps/server/src/orchestration-v2/`, modelled
  on `DelegatedTaskQuestionReactor.ts`: subscribe to `engine.streamDomainEvents`, react
  to `run.updated` with a terminal status, and dispatch `thread.tag.set` with a
  `server:`-prefixed `commandId` that includes the run id so a repeat is harmless.
  Wired in `apps/server/src/server.ts` next to the other reactors. Failures are logged
  and never fail the run.
- **Reading the message.** `ProjectionStore.getThreadRecords(threadId, ["messages"],
  { messageRunIds: [runId], messageRoles: ["assistant"] })`, then the last message with
  `streaming === false`.
- **Client data.** The sidebar's thread objects carry the raw shell at `thread.source`,
  so `thread.source.tags` is readable without new plumbing.
- **Client sections.** Sections are assigned in `partitionSidebarThreads`
  (`apps/web/src/components/Sidebar.tsx`) and the list is built from `SidebarSection`
  and `SidebarListMarker` (`Sidebar.logic.ts`). The new groups split today's "active"
  section and apply only when project folders are off (`folderGroups === null`).
- **Rebase safety.** Put new logic in new files owned by the fork (the classifier, the
  server reaction, the client group function and their tests). Keep edits to upstream
  files to the smallest hooks that call into them. No new settings field.
- **No new event types, commands, migrations or required schema fields.**

## Left to the builder

- Verify that `nodeId === null` on an assistant message means "written by the thread's
  own agent". If it does not, find the field that does.
- Verify that the projection already holds the run's final message when `run.updated`
  is delivered on `streamDomainEvents`. If it can lag, wait for it the way
  `ThreadManagementService.settleAfterRun` waits for a run.
- The exact client predicates for rule 3. Reuse the helpers behind
  `resolveThreadStatusPill`; for "latest run failed" use the run status, not the
  unseen-failure helper.
- How the drag-and-drop helpers (`sectionAtSidebarSlot`, `resolveSidebarDropTarget`,
  `resolveSidebarDropVerb`, `planSidebarThreadDrop`) treat the new markers, within the
  behaviour above. Existing drag tests must keep passing.
- Header styling, using the existing `SidebarSectionHeader`.

## Verification

- Table-driven unit test for `classifyClosingSection`: bold and `##` headings, a
  numbered list, "Nothing needed from you right now", an empty section, no section, the
  phrase quoted earlier in the message with the real section last.
- Server test with the orchestrator test kit: a completed run sets the right tag and
  clears the other; a completed run without the section leaves the tag alone; a failed
  run clears both; the start-up pass tags an untagged thread and looks back past a run
  without the section.
- Client test for the group function covering every row of the table above.
- `vp run check:changed` passes under Node 26.
- Run `vp run dev:desktop` and check the groups against real threads before the nightly
  build picks the change up.
