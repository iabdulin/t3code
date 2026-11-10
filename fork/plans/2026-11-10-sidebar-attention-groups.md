# Sidebar attention groups implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the sidebar's open threads into "Needs you", "Other" and "Nothing needed" groups, using a mark the server derives from each turn's closing "What I need from you" section.

**Architecture:** A server reaction classifies the last assistant message when a run completes and stores the result as one of two thread tags through the existing `thread.tag.set` command. The web sidebar reads the tags and T3's own thread facts, orders the existing active list by group, and inserts a foldable header before each group. No new sections, events, commands, migrations or settings.

**Tech stack:** TypeScript, Effect (server services and tests with `@effect/vitest`), React (web), Vite+ (`vp`).

**Spec:** `fork/specs/2026-11-10-sidebar-attention-groups-design.md`. Read it before starting; this plan argues from it.

## Global constraints

- Run every `vp` command and every `git commit` as `vp env exec --node 26.12.1 <command>`. The machine's default Node is 22 and the repo needs 26.12.1.
- Work on branch `mine` in `/Users/iabdulin/Sites/t3code`. Do not push. Commit messages use `feat(fork): ...` or `test(fork): ...` and do not mention any AI tool.
- No new event types, commands, database migrations, settings fields or required schema fields. The official app must still open the same database.
- New logic goes in new files. Edits to upstream files (`server.ts`, `contracts/src/index.ts`, `Sidebar.tsx`, `Sidebar.logic.ts`, `SidebarListMarkers.tsx`) are limited to the hooks named in each task.
- Tag values, verbatim: `attention:needs-you`, `attention:nothing-needed`.
- Group names and order, verbatim: `needs-you`, `other`, `nothing-needed`. Header labels: "Needs you", "Other", "Nothing needed".
- The groups apply only when project folders are off (`folderGroups === null`).
- Never settle, snooze, archive or hide a thread because of its group.
- Follow the repo's `AGENTS.md`. `vp run check:changed` must pass before each commit.

## Review focus

Inputs the spec implies and that are easy to miss. Each has a test in the task that owns the code.

1. The phrase "What I need from you" appears earlier in a message (quoted, or inside a code block) and the real section comes last. Expected: the last occurrence decides. (Task 1)
2. Heading and body variants: `**What I need from you**`, `## What I need from you`, a trailing colon, and "Nothing needed" written as a list item (`- Nothing needed ...`, `1. Nothing needed ...`). Expected: all recognised. (Task 1)
3. A run with several assistant messages where the last one is still streaming or belongs to a subagent. Expected: the last finished message by the thread's own agent is used. (Task 2)
4. The same `run.updated` event delivered twice, or a thread that already holds the right tag. Expected: no second dispatch, and never both tags. (Task 2)
5. The Working section setting is off and a thread with a stale `attention:needs-you` tag is mid-turn. Expected: it shows under "Other". Also: the open thread sits in a folded group. Expected: no crash, keyboard navigation skips folded rows. (Tasks 3 and 4)

---

### Task 1: Tag constants and the closing-section classifier

**Files:**

- Create: `packages/contracts/src/threadAttention.ts`
- Modify: `packages/contracts/src/index.ts` (add one export line next to `export * from "./threadTags.ts";`)
- Create: `apps/server/src/orchestration-v2/ThreadAttentionClassifier.ts`
- Test: `apps/server/src/orchestration-v2/ThreadAttentionClassifier.test.ts`

**Interfaces:**

- Produces, in `@t3tools/contracts`:
  ```ts
  export type ThreadAttentionMark = "needs-you" | "nothing-needed";
  export const THREAD_ATTENTION_TAGS: { readonly "needs-you": "attention:needs-you"; readonly "nothing-needed": "attention:nothing-needed" };
  /** The mark a thread's tags carry, or null. Two marks at once read as "needs-you". */
  export function threadAttentionMark(tags: ReadonlyArray<string> | undefined): ThreadAttentionMark | null;
  ```
- Produces, in `ThreadAttentionClassifier.ts`:

  ```ts
  /** What the closing "What I need from you" section of an assistant message asks for.
   *  null when the message has no such section or the section is empty. */
  export function classifyClosingSection(messageText: string): ThreadAttentionMark | null;
  ```

- [ ] **Step 1: Write the failing test.** Table-driven `it.each` in `ThreadAttentionClassifier.test.ts`, one row per case, asserting `classifyClosingSection(text)`:

  | Message                                                                                                                 | Expected           |
  | ----------------------------------------------------------------------------------------------------------------------- | ------------------ |
  | `"Done.\n\n**What I need from you**\n\n1. Approve the plan\n2. Reply 'ok'"`                                             | `"needs-you"`      |
  | `"## What I need from you\n\nNothing needed from you right now. The work is finished."`                                 | `"nothing-needed"` |
  | `"**What I need from you:**\n- Nothing needed from you right now"`                                                      | `"nothing-needed"` |
  | `"**What I need from you**\n1. Nothing needed, all done"`                                                               | `"nothing-needed"` |
  | `"**WHAT I NEED FROM YOU**  \nnothing NEEDED"`                                                                          | `"nothing-needed"` |
  | `"The rule says: end with \"What I need from you\".\n\n**What I need from you**\n\nNothing needed from you right now."` | `"nothing-needed"` |
  | `"**What I need from you**\n\nNothing needed.\n\nLater edit:\n\n**What I need from you**\n\n1. Run the command"`        | `"needs-you"`      |
  | `"**What I need from you**\n\n   \n"`                                                                                   | `null`             |
  | `"All done, nothing else."`                                                                                             | `null`             |
  | `"What I need from you is patience, and here is why."`                                                                  | `null`             |
  | `""`                                                                                                                    | `null`             |

  Add a second `describe` for `threadAttentionMark`: `undefined` and `[]` give `null`; `["demo", "attention:nothing-needed"]` gives `"nothing-needed"`; both tags together give `"needs-you"`.

- [ ] **Step 2: Run it and see it fail.** `vp env exec --node 26.12.1 vp test run apps/server/src/orchestration-v2/ThreadAttentionClassifier.test.ts`. Expected: fails on the missing module.

- [ ] **Step 3: Implement.** In `threadAttention.ts`, the type, the constant and `threadAttentionMark`. In `ThreadAttentionClassifier.ts`, `classifyClosingSection`: split into lines; a heading line is one whose text, after stripping leading `#`, surrounding `*` and `_`, one trailing `:` and whitespace, equals `what i need from you` ignoring case; take the last heading line; the body is the lines after it; the first non-empty body line, with a leading list marker (`-`, `*`, `+`, or digits followed by `.` or `)`) and surrounding `*`/`_` removed, decides: it starts with `nothing needed` ignoring case gives `"nothing-needed"`, anything else gives `"needs-you"`, no such line gives `null`.

- [ ] **Step 4: Run the test and see it pass.** Same command as step 2.

- [ ] **Step 5: Commit.** `vp env exec --node 26.12.1 vp run check:changed`, then commit as `feat(fork): classify a turn's closing section into an attention mark`.

### Task 2: Server reaction that marks threads

**Files:**

- Create: `apps/server/src/orchestration-v2/ThreadAttentionReactor.ts`
- Test: `apps/server/src/orchestration-v2/ThreadAttentionReactor.test.ts`
- Modify: `apps/server/src/server.ts` (one `Layer.effectDiscard(...)` block directly after the `DelegatedTaskQuestionReactor` block, same shape)

**Interfaces:**

- Consumes: `classifyClosingSection`, `THREAD_ATTENTION_TAGS`, `threadAttentionMark` from Task 1; `Orchestrator.OrchestratorV2` (`streamDomainEvents`, `dispatch`), `ProjectionStore.ProjectionStoreV2` (`getThreadRecords`, plus a thread listing for the start-up pass).
- Produces:
  ```ts
  export class ThreadAttentionReactor extends Context.Service<ThreadAttentionReactor, {
    /** Runs the start-up pass, then follows domain events until the scope closes. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Marks or unmarks the thread of a finished run. Never fails. */
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Marks unmarked open threads from their recent runs. Never fails. */
    readonly markOpenThreads: () => Effect.Effect<void>;
  }>()("t3/orchestration-v2/ThreadAttentionReactor") {}
  export const layer: Layer.Layer<ThreadAttentionReactor, never, Orchestrator.OrchestratorV2 | ProjectionStore.ProjectionStoreV2>;
  ```

Model the file on `DelegatedTaskQuestionReactor.ts` (service class, `make`, `forkParked(Stream.runForEach(engine.streamDomainEvents, handle))`, `Effect.catchCause` with `Effect.logWarning`). Model the test setup on `PullRequestSyncReactor.test.ts`: stub `OrchestratorV2` and `ProjectionStoreV2` with `Layer.succeed`, record dispatched commands in a `Ref`, and call `handle` / `markOpenThreads` directly.

Decisions:

- `handle` acts only on `event.type === "run.updated"`. It reads `getThreadRecords(event.threadId, ["messages", "runs"], { messageRunIds: [event.payload.id], messageRoles: ["assistant"] })`. It returns without dispatching when the thread is archived or deleted, or when the event's run is not the thread's run with the highest `ordinal`.
- Status `completed`: take the last message with `streaming === false` that the thread's own agent wrote. Before relying on `nodeId === null` for "own agent", check how subagent messages are stored and use the field that separates them. `classifyClosingSection(text)` gives the wanted mark; `null` means leave the tags alone.
- Status `failed`, `interrupted`, `cancelled` or `rolled_back`: the wanted state is no mark.
- Any other status: do nothing.
- To reach the wanted state, dispatch `thread.tag.set` only for tags that differ from the thread's current `tags`: `tagged: true` for the wanted tag, `tagged: false` for the other one when present. `commandId` is `CommandId.make(\`server:thread-attention:${runId}:${tag}:${tagged ? "set" : "clear"}\`)`.
- If the message is not yet in the projection when the event arrives (check by reading how `ThreadManagementService.settleAfterRun` waits), wait for it the same way; do not poll on a timer.
- `markOpenThreads`: list open threads with the store's existing listing (`listActiveShellIndex` or `getShellSnapshot`, whichever exposes `settledOverride`, `archivedAt`, `tags` and the latest run's status with the least data). For each thread that is not settled, not archived, has no attention tag and whose latest run is `completed`: read its runs, take the five with the highest `ordinal`, newest first, and stop at the first that is not `completed`. For each remaining run, newest first, classify its last finished own-agent message and apply the first non-null result with the same dispatch rule. `commandId` uses the run that gave the result.
- `start` runs `markOpenThreads` first, then the event stream, both inside the parked fiber.

- [ ] **Step 1: Write the failing tests** in `ThreadAttentionReactor.test.ts` (`it.effect`), each asserting the exact list of dispatched `thread.tag.set` commands (`tag`, `tagged`, `threadId`):
  - `marks a thread that ends with asks`: completed run, message with a numbered section, no tags. Dispatches `attention:needs-you` set.
  - `replaces the other mark`: thread tagged `attention:needs-you`, message says "Nothing needed". Dispatches `attention:nothing-needed` set and `attention:needs-you` clear.
  - `leaves the mark when the reply has no section`: thread tagged `attention:needs-you`, message without a section. Dispatches nothing.
  - `clears the mark when a run fails`: thread tagged `attention:nothing-needed`, status `failed`. Dispatches `attention:nothing-needed` clear. Repeat the case for `interrupted`.
  - `dispatches nothing when the tag is already right`: same event handled twice with the store reflecting the first result. Second call dispatches nothing.
  - `ignores a run that is not the latest`: event for a run with a lower ordinal than another run of the thread.
  - `uses the last finished message of the thread's own agent`: three messages in order: own agent with a "Nothing needed" section, a subagent message with asks, an own-agent message with `streaming: true` and asks. Dispatches `attention:nothing-needed` set.
  - `ignores archived threads` and `ignores non-run events`.
  - `start-up pass marks an unmarked open thread`: latest run completed without a section (a compaction), the run before it completed with asks. Dispatches `attention:needs-you` set.
  - `start-up pass stops at a run that did not complete`: latest run completed without a section, the one before `interrupted`, the one before that with asks. Dispatches nothing.
  - `start-up pass skips settled, archived and already marked threads`.
  - `a store failure does not fail handle`: `getThreadRecords` fails; `handle` succeeds and dispatches nothing.

- [ ] **Step 2: Run them and see them fail.** `vp env exec --node 26.12.1 vp test run apps/server/src/orchestration-v2/ThreadAttentionReactor.test.ts`.

- [ ] **Step 3: Implement `ThreadAttentionReactor.ts`** to the interface and decisions above.

- [ ] **Step 4: Wire it in `server.ts`** with the same `Layer.effectDiscard` + `Layer.provide(ThreadAttentionReactor.layer)` + `Layer.provide(ProjectionStoreV2.layer)` shape as the `DelegatedTaskQuestionReactor` block.

- [ ] **Step 5: Run the tests and the server typecheck.** The test command from step 2, then `vp env exec --node 26.12.1 vp run --filter t3 typecheck` (use the server package's name from `apps/server/package.json`). Expected: pass.

- [ ] **Step 6: Commit.** `vp run check:changed`, then `feat(fork): mark threads with what their last turn needs from the user`.

### Task 3: Client function that assigns the group

**Files:**

- Create: `apps/web/src/components/sidebar/threadAttentionGroup.ts`
- Test: `apps/web/src/components/sidebar/threadAttentionGroup.test.ts`

**Interfaces:**

- Consumes: `threadAttentionMark` from `@t3tools/contracts`; `isLatestRunSettled` from `apps/web/src/session-logic`.
- Produces:
  ```ts
  export type SidebarAttentionGroup = "needs-you" | "other" | "nothing-needed";
  export const SIDEBAR_ATTENTION_GROUPS: readonly ["needs-you", "other", "nothing-needed"];
  type AttentionThreadInput = Pick<EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "pendingGuestMessageCount"
    | "interactionMode" | "hasActionableProposedPlan" | "latestRun" | "runtime"> & { readonly source: { readonly tags?: ReadonlyArray<string> } };
  /** The group an open thread belongs to. `working` is whether a turn or resumable background work is in progress. */
  export function resolveSidebarAttentionGroup(thread: AttentionThreadInput, working: boolean): SidebarAttentionGroup;
  /** Splits threads by group, keeping the input order inside each group. */
  export function partitionThreadsByAttention<T extends AttentionThreadInput>(
    threads: ReadonlyArray<T>, isWorking: (thread: T) => boolean,
  ): Readonly<Record<SidebarAttentionGroup, ReadonlyArray<T>>>;
  ```

Rule order in `resolveSidebarAttentionGroup` (spec table rows 2 to 6), first match wins:

1. A pending approval, pending user input, a non-null `pendingSubagentRequest` or `pendingGuestMessageCount > 0` gives `"needs-you"`. These come before `working` because a thread blocked on the user is not working.
2. `working` gives `"other"`.
3. A plan waiting for a go-ahead (`interactionMode === "plan" && hasActionableProposedPlan && isLatestRunSettled(latestRun, runtime)`) or `latestRun?.status === "failed"` gives `"needs-you"`.
4. The tag mark, if any.
5. Otherwise `"other"`.

- [ ] **Step 1: Write the failing test.** One `it.each` row per rule, built from a small local `thread(overrides)` helper that returns an idle thread with a completed run and no tags:
  - no tags, idle: `"other"`
  - tag `attention:needs-you`: `"needs-you"`; tag `attention:nothing-needed`: `"nothing-needed"`
  - `hasPendingApprovals: true` with tag `attention:nothing-needed`: `"needs-you"`
  - `hasPendingUserInput: true`, `pendingSubagentRequest: "approval"`, `pendingGuestMessageCount: 1`, plan ready, `latestRun.status: "failed"`: each `"needs-you"`
  - `working: true` with tag `attention:needs-you`: `"other"`
  - `working: true` with `hasPendingApprovals: true`: `"needs-you"`
  - `partitionThreadsByAttention` with five threads in mixed groups: each group's array keeps the input order, and every thread appears exactly once.

- [ ] **Step 2: Run it and see it fail.** `vp env exec --node 26.12.1 vp test run apps/web/src/components/sidebar/threadAttentionGroup.test.ts`.

- [ ] **Step 3: Implement** both functions.

- [ ] **Step 4: Run the test and see it pass.**

- [ ] **Step 5: Commit.** `vp run check:changed`, then `feat(fork): group open sidebar threads by what they need`.

### Task 4: Show the groups in the sidebar

**Files:**

- Modify: `apps/web/src/components/Sidebar.logic.ts` (`SidebarListMarker` union only)
- Modify: `apps/web/src/components/sidebar/SidebarListMarkers.tsx` (`SidebarSectionHeader`'s `marker` prop type and its `shelf` name)
- Modify: `apps/web/src/components/Sidebar.tsx` (the hooks listed below)
- Test: `apps/web/src/components/Sidebar.logic.test.ts`, `apps/web/src/components/Sidebar.drag.test.ts`

**Interfaces:**

- Consumes: `SIDEBAR_ATTENTION_GROUPS`, `partitionThreadsByAttention`, `SidebarAttentionGroup` from Task 3; `isThreadWorking` from `packages/client-runtime/src/state/threadInbox.ts`.
- Produces: three new `SidebarListMarker` values, verbatim: `"needs-you-header"`, `"other-header"`, `"nothing-needed-header"`.

Decisions:

- The groups are parts of the existing `"active"` section. Thread rows keep `section: "active"`. `sectionAtSidebarSlot` and `resolveSidebarDropTarget` already ignore markers they do not name, so the new header markers are transparent to drag and drop. Do not add cases for them there.
- In `useSidebarThreads` (the hook that calls `partitionSidebarThreads` and owns `workingShelfExpanded`), when `folderGroups === null`, split `activeThreads` with `partitionThreadsByAttention(activeThreads, isThreadWorking)`. Add three `useLocalStorage` fold states next to `WORKING_SHELF_EXPANDED_KEY`, default `true`, with keys `t3code:sidebar-needs-you-expanded`, `t3code:sidebar-other-expanded` and `t3code:sidebar-nothing-needed-expanded` (match the prefix the existing keys use). Return the grouped threads, each group's count, and the fold states and toggles.
- Where the list is built (`sidebarListItemsFresh`), replace `items.push(...activeRows)` with: for each group in `SIDEBAR_ATTENTION_GROUPS` that has threads, push its header marker, then its rows if the group is expanded. When grouping is off (`folderGroups !== null`), keep the existing line.
- `orderedThreads`, which drives keyboard navigation, must list active threads in the same grouped order and leave out rows of folded groups, the way it already uses the visible working, snoozed and settled lists.
- In the render switch, add three cases that render `SidebarSectionHeader` with the label, the group's full count and its fold toggle, like the `"working-header"` case but without `className="mt-auto"`.
- Reordering inside the active list keeps today's rules. Grouping sorts first, so a manual order only shows inside a group.
- Include the three fold states in `shelfExpansionKey` so the list re-measures when a group folds.

- [ ] **Step 1: Write the failing tests.**
  - `Sidebar.drag.test.ts`, `attention headers inside the active list do not end it`: items `[pinned-header, thread p1 (pinned), pinned-divider, active-placeholder, needs-you-header, thread a1 (active), nothing-needed-header, thread a2 (active), settled-header, settled-placeholder]`. `resolveSidebarDropTarget(items, "p1", "a2")` returns `section: "active"` and an `activeOrder` containing `a1`, `a2` and `p1`.
  - `Sidebar.logic.test.ts`, `sidebarMarkerId covers the attention headers`: each of the three new markers yields a distinct id.
  - If `useSidebarThreads` has no unit seam, extract the list building for the active part into an exported pure function in `threadAttentionGroup.ts`:
    ```ts
    export function attentionListItems(
      groups: Readonly<Record<SidebarAttentionGroup, ReadonlyArray<string>>>, // thread keys per group
      expanded: Readonly<Record<SidebarAttentionGroup, boolean>>,
    ): ReadonlyArray<
      | { kind: "thread"; key: string; section: "active" }
      | { kind: "marker"; marker: "needs-you-header" | "other-header" | "nothing-needed-header" }
    >;
    ```
    and test it in `threadAttentionGroup.test.ts`: an empty group emits nothing; a folded group emits its header and no rows; groups come out in `SIDEBAR_ATTENTION_GROUPS` order.

- [ ] **Step 2: Run them and see them fail.** `vp env exec --node 26.12.1 vp test run apps/web/src/components/Sidebar.drag.test.ts apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/sidebar/threadAttentionGroup.test.ts`.

- [ ] **Step 3: Implement** the marker union, the header prop type, and the `Sidebar.tsx` hooks above.

- [ ] **Step 4: Run the sidebar test files**, including the browser ones: `vp env exec --node 26.12.1 vp test run apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/Sidebar.drag.test.ts apps/web/src/components/Sidebar.browser.test.tsx apps/web/src/components/Sidebar.pointer.browser.test.tsx apps/web/src/components/Sidebar.shortcuts.browser.test.tsx apps/web/src/components/Sidebar.logic.browser.test.tsx`. Expected: pass. A browser test that asserts the old flat order of active rows may need its expectation updated to include the "Other" header; change the expectation, not the behaviour.

- [ ] **Step 5: Commit.** `vp run check:changed`, then `feat(fork): show Needs you, Other and Nothing needed groups in the sidebar`.

### Task 5: Check it against real threads

**Files:** none changed unless a defect is found.

- [ ] **Step 1: Make a copy of the live database** following "Test data" in `AGENTS.md`, into a temporary home directory. Never run a dev server against `~/.t3/userdata`.
- [ ] **Step 2: Start the dev stack on the copy.** `vp env exec --node 26.12.1 vp run dev --home-dir <temp home>`. Open the pairing URL it prints.
- [ ] **Step 3: Check, and record the result of each:**
  - Open threads whose last reply ends with numbered asks are under "Needs you"; ones that end with "Nothing needed from you right now" are under "Nothing needed"; the rest are under "Other". Compare five threads by opening them.
  - Each header shows its count and folds. The fold state survives a reload.
  - Pinned, Working, Snoozed and Settled look as before. Dragging a thread to Pinned and back, and onto Settled, works.
  - With **Settings → General → Working section** off, a thread that is mid-turn shows under "Other".
  - With **Settings → Labs → Boring sidebar** on, no attention headers appear.
- [ ] **Step 4: Stop the dev stack and delete the temporary home.**
- [ ] **Step 5: Report** what was checked and anything that did not match. Fix defects in the task that owns the code, with a test, and re-run that task's commands.
