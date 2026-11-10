import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadAttentionReactor from "./ThreadAttentionReactor.ts";

const NOW = DateTime.makeUnsafe("2026-11-10T12:00:00.000Z");
const PROJECT_ID = ProjectId.make("attention-project");
const NEEDS_YOU = "attention:needs-you";
const NOTHING_NEEDED = "attention:nothing-needed";

const ASKS = "Done.\n\n**What I need from you**\n\n1. Review the diff and reply 'ok'.";
const NOTHING = "Done.\n\n## What I need from you\n\nNothing needed from you right now.";
const PLAIN = "The function returns the cached value.";

type TagCommand = Extract<OrchestrationV2Command, { readonly type: "thread.tag.set" }>;

interface ThreadState {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}

function makeThread(
  id: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  const threadId = ThreadId.make(id);
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: PROJECT_ID,
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeRun(
  threadId: ThreadId,
  ordinal: number,
  status: OrchestrationV2Run["status"],
): OrchestrationV2Run {
  return {
    id: RunId.make(`run:${threadId}:${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${threadId}:${ordinal}:user`),
    rootNodeId: NodeId.make(`node:${threadId}:${ordinal}:root`),
    activeAttemptId: null,
    status,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function makeMessage(
  run: OrchestrationV2Run,
  key: string,
  text: string,
  overrides: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage {
  return {
    createdBy: "agent",
    creationSource: "provider",
    id: MessageId.make(`message:${run.id}:${key}`),
    threadId: run.threadId,
    runId: run.id,
    nodeId: NodeId.make(`node:${run.id}:${key}`),
    role: "assistant",
    text,
    attachments: [],
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** A thread whose single run ended with `status` and whose own agent last wrote `text`. */
function threadWithRun(
  id: string,
  status: OrchestrationV2Run["status"],
  text: string,
  threadOverrides: Partial<OrchestrationV2AppThread> = {},
): ThreadState {
  const thread = makeThread(id, threadOverrides);
  const run = makeRun(thread.id, 1, status);
  return { thread, runs: [run], messages: [makeMessage(run, "reply", text)] };
}

function runUpdated(run: OrchestrationV2Run): OrchestrationV2DomainEvent {
  return {
    type: "run.updated",
    id: EventId.make(`event:${run.id}:${run.status}`),
    threadId: run.threadId,
    runId: run.id,
    occurredAt: NOW,
    payload: run,
  };
}

function notStarted(run: OrchestrationV2Run): OrchestrationV2Run {
  return { ...run, startedAt: null, completedAt: null };
}

const CHILD_THREAD: Partial<OrchestrationV2AppThread> = {
  lineage: {
    parentThreadId: ThreadId.make("parent"),
    relationshipToParent: "subagent",
    rootThreadId: ThreadId.make("parent"),
  },
};

function latestRun(state: ThreadState): OrchestrationV2Run | undefined {
  return state.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
}

function toShell(state: ThreadState): OrchestrationV2ThreadShell {
  const latest = latestRun(state);
  return {
    id: state.thread.id,
    archivedAt: state.thread.archivedAt,
    settledOverride: state.thread.settledOverride,
    settledAt: state.thread.settledAt,
    tags: state.thread.tags,
    lineage: state.thread.lineage,
    latestRunId: latest?.id ?? null,
    status: latest?.status ?? "idle",
  } as OrchestrationV2ThreadShell;
}

interface HarnessOptions {
  readonly failReads?: boolean;
  readonly streamDomainEvents?: Stream.Stream<OrchestrationV2DomainEvent>;
  readonly onShellSnapshot?: Effect.Effect<void>;
}

const makeHarness = Effect.fn("makeThreadAttentionHarness")(function* (
  threads: ReadonlyArray<ThreadState>,
  options: HarnessOptions = {},
) {
  const store = yield* Ref.make(threads);
  const commands = yield* Ref.make<ReadonlyArray<TagCommand>>([]);
  const messageFilters = yield* Ref.make<
    ReadonlyArray<ProjectionStore.ProjectionRecordFilter | undefined>
  >([]);

  const applyTag = (command: TagCommand) =>
    Ref.update(store, (states) =>
      states.map((state) => {
        if (state.thread.id !== command.threadId) return state;
        const current = state.thread.tags ?? [];
        const tags = command.tagged
          ? current.includes(command.tag)
            ? current
            : [...current, command.tag]
          : current.filter((tag) => tag !== command.tag);
        return { ...state, thread: { ...state.thread, tags } };
      }),
    );

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: (threadId, fields, filter) =>
        options.failReads === true
          ? Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId }))
          : Ref.update(messageFilters, (recorded) =>
              fields.some((field) => field === "messages") ? [...recorded, filter] : recorded,
            ).pipe(
              Effect.andThen(Ref.get(store)),
              Effect.flatMap((states) => {
                const state = states.find((candidate) => candidate.thread.id === threadId);
                if (state === undefined) {
                  return Effect.fail(
                    new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
                  );
                }
                // Mirrors the store: messages of the thread, narrowed by run and role.
                const messages = state.messages.filter(
                  (message) =>
                    message.threadId === threadId &&
                    (filter?.messageRunIds === undefined ||
                      (message.runId !== null && filter.messageRunIds.includes(message.runId))) &&
                    (filter?.messageRoles === undefined ||
                      filter.messageRoles.includes(message.role)),
                );
                return Effect.succeed({
                  thread: state.thread,
                  runs: state.runs,
                  messages,
                } as unknown as OrchestrationV2ThreadProjection);
              }),
            ),
      getShellSnapshot: () =>
        (options.onShellSnapshot ?? Effect.void).pipe(
          Effect.andThen(Ref.get(store)),
          Effect.map((states) => ({
            schemaVersion: 1,
            snapshotSequence: 1,
            threads: states.map(toShell),
            archivedThreads: [],
          })),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        command.type === "thread.tag.set"
          ? Ref.update(commands, (recorded) => [...recorded, command]).pipe(
              Effect.andThen(applyTag(command)),
              Effect.as({ sequence: 1, storedEvents: [] }),
            )
          : Effect.die(new Error(`Unexpected command: ${command.type}`)),
      streamDomainEvents: options.streamDomainEvents ?? Stream.empty,
    }),
  );

  const dispatched = Ref.get(commands).pipe(
    Effect.map((recorded) =>
      recorded.map(({ threadId, tag, tagged }) => ({ threadId, tag, tagged })),
    ),
  );

  return {
    store,
    commands,
    messageFilters,
    dispatched,
    layer: ThreadAttentionReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

const withReactor = <A, E>(
  threads: ReadonlyArray<ThreadState>,
  use: (
    reactor: ThreadAttentionReactor.ThreadAttentionReactor["Service"],
    harness: Effect.Success<ReturnType<typeof makeHarness>>,
  ) => Effect.Effect<A, E>,
  options: HarnessOptions = {},
) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(threads, options);
    return yield* Effect.gen(function* () {
      const reactor = yield* ThreadAttentionReactor.ThreadAttentionReactor;
      return yield* use(reactor, harness);
    }).pipe(Effect.provide(harness.layer));
  });

describe("ThreadAttentionReactor.handle", () => {
  it.effect("marks a thread that ends with asks", () =>
    withReactor([threadWithRun("asks", "completed", ASKS)], (reactor, harness) =>
      Effect.gen(function* () {
        const run = makeRun(ThreadId.make("asks"), 1, "completed");
        yield* reactor.handle(runUpdated(run));
        assert.deepStrictEqual(yield* harness.dispatched, [
          { threadId: ThreadId.make("asks"), tag: NEEDS_YOU, tagged: true },
        ]);
        const [command] = yield* Ref.get(harness.commands);
        assert.strictEqual(
          command?.commandId,
          `server:thread-attention:${run.id}:${NEEDS_YOU}:set`,
        );
      }),
    ),
  );

  it.effect("replaces the other mark", () =>
    withReactor(
      [threadWithRun("replace", "completed", NOTHING, { tags: [NEEDS_YOU] })],
      (reactor, harness) =>
        Effect.gen(function* () {
          yield* reactor.handle(runUpdated(makeRun(ThreadId.make("replace"), 1, "completed")));
          assert.deepStrictEqual(yield* harness.dispatched, [
            { threadId: ThreadId.make("replace"), tag: NOTHING_NEEDED, tagged: true },
            { threadId: ThreadId.make("replace"), tag: NEEDS_YOU, tagged: false },
          ]);
        }),
    ),
  );

  it.effect("leaves the mark when the reply has no section", () =>
    withReactor(
      [threadWithRun("plain", "completed", PLAIN, { tags: [NEEDS_YOU] })],
      (reactor, harness) =>
        Effect.gen(function* () {
          yield* reactor.handle(runUpdated(makeRun(ThreadId.make("plain"), 1, "completed")));
          assert.deepStrictEqual(yield* harness.dispatched, []);
        }),
    ),
  );

  it.effect("clears the mark when a run fails", () =>
    Effect.forEach(
      ["failed", "interrupted"] as const,
      (status) =>
        withReactor(
          [threadWithRun("stopped", status, NOTHING, { tags: [NOTHING_NEEDED] })],
          (reactor, harness) =>
            Effect.gen(function* () {
              yield* reactor.handle(runUpdated(makeRun(ThreadId.make("stopped"), 1, status)));
              assert.deepStrictEqual(
                yield* harness.dispatched,
                [{ threadId: ThreadId.make("stopped"), tag: NOTHING_NEEDED, tagged: false }],
                status,
              );
            }),
        ),
      { discard: true },
    ),
  );

  it.effect("dispatches nothing when the tag is already right", () =>
    withReactor([threadWithRun("twice", "completed", ASKS)], (reactor, harness) =>
      Effect.gen(function* () {
        const event = runUpdated(makeRun(ThreadId.make("twice"), 1, "completed"));
        yield* reactor.handle(event);
        yield* reactor.handle(event);
        assert.deepStrictEqual(yield* harness.dispatched, [
          { threadId: ThreadId.make("twice"), tag: NEEDS_YOU, tagged: true },
        ]);
      }),
    ),
  );

  it.effect("ignores a run that is not the latest", () => {
    const thread = makeThread("older");
    const first = makeRun(thread.id, 1, "completed");
    const second = makeRun(thread.id, 2, "running");
    return withReactor(
      [{ thread, runs: [first, second], messages: [makeMessage(first, "reply", ASKS)] }],
      (reactor, harness) =>
        Effect.gen(function* () {
          yield* reactor.handle(runUpdated(first));
          assert.deepStrictEqual(yield* harness.dispatched, []);
        }),
    );
  });

  it.effect("uses the last finished message of the thread's own agent", () => {
    const thread = makeThread("own-agent");
    const run = makeRun(thread.id, 1, "completed");
    return withReactor(
      [
        {
          thread,
          runs: [run],
          messages: [
            makeMessage(run, "summary", NOTHING),
            makeMessage(run, "streaming", ASKS, { streaming: true }),
          ],
        },
      ],
      (reactor, harness) =>
        Effect.gen(function* () {
          yield* reactor.handle(runUpdated(run));
          // Subagents write to their own threads, so the run and role filter is what keeps them out.
          assert.deepStrictEqual(yield* Ref.get(harness.messageFilters), [
            { messageRunIds: [run.id], messageRoles: ["assistant"] },
          ]);
          assert.deepStrictEqual(yield* harness.dispatched, [
            { threadId: thread.id, tag: NOTHING_NEEDED, tagged: true },
          ]);
        }),
    );
  });

  it.effect("marks a completed run while a follow-up is queued", () => {
    const thread = makeThread("queued-follow-up");
    const run = makeRun(thread.id, 1, "completed");
    return withReactor(
      [
        {
          thread,
          runs: [run, notStarted(makeRun(thread.id, 2, "queued"))],
          messages: [makeMessage(run, "reply", ASKS)],
        },
      ],
      (reactor, harness) =>
        Effect.gen(function* () {
          yield* reactor.handle(runUpdated(run));
          assert.deepStrictEqual(yield* harness.dispatched, [
            { threadId: thread.id, tag: NEEDS_YOU, tagged: true },
          ]);
        }),
    );
  });

  it.effect("cancelling a queued run that never started leaves the mark", () => {
    const thread = makeThread("queued-cancel", { tags: [NEEDS_YOU] });
    const run = makeRun(thread.id, 1, "completed");
    const cancelled = notStarted(makeRun(thread.id, 2, "cancelled"));
    return withReactor(
      [{ thread, runs: [run, cancelled], messages: [makeMessage(run, "reply", ASKS)] }],
      (reactor, harness) =>
        Effect.gen(function* () {
          yield* reactor.handle(runUpdated(cancelled));
          assert.deepStrictEqual(yield* harness.dispatched, []);
        }),
    );
  });

  it.effect("ignores threads that have a parent", () =>
    withReactor([threadWithRun("child", "completed", ASKS, CHILD_THREAD)], (reactor, harness) =>
      Effect.gen(function* () {
        yield* reactor.handle(runUpdated(makeRun(ThreadId.make("child"), 1, "completed")));
        assert.deepStrictEqual(yield* harness.dispatched, []);
      }),
    ),
  );

  it.effect("ignores archived threads", () =>
    withReactor(
      [threadWithRun("archived", "completed", ASKS, { archivedAt: NOW })],
      (reactor, harness) =>
        Effect.gen(function* () {
          yield* reactor.handle(runUpdated(makeRun(ThreadId.make("archived"), 1, "completed")));
          assert.deepStrictEqual(yield* harness.dispatched, []);
        }),
    ),
  );

  it.effect("ignores non-run events", () => {
    const state = threadWithRun("message-only", "completed", ASKS);
    const message = state.messages[0]!;
    return withReactor([state], (reactor, harness) =>
      Effect.gen(function* () {
        yield* reactor.handle({
          type: "message.updated",
          id: EventId.make("event:message-only"),
          threadId: state.thread.id,
          occurredAt: NOW,
          payload: message,
        });
        assert.deepStrictEqual(yield* harness.dispatched, []);
      }),
    );
  });

  it.effect("a store failure does not fail handle", () =>
    withReactor(
      [threadWithRun("broken", "completed", ASKS)],
      (reactor, harness) =>
        Effect.gen(function* () {
          yield* reactor
            .handle(runUpdated(makeRun(ThreadId.make("broken"), 1, "completed")))
            .pipe(Effect.provideService(Logger.CurrentLoggers, new Set()));
          assert.deepStrictEqual(yield* harness.dispatched, []);
        }),
      { failReads: true },
    ),
  );
});

describe("ThreadAttentionReactor.markOpenThreads", () => {
  it.effect("start-up pass marks an unmarked open thread", () => {
    const thread = makeThread("startup");
    const asked = makeRun(thread.id, 1, "completed");
    const compaction = makeRun(thread.id, 2, "completed");
    return withReactor(
      [
        {
          thread,
          runs: [asked, compaction],
          messages: [
            makeMessage(asked, "reply", ASKS),
            makeMessage(compaction, "reply", "Compacted the conversation."),
          ],
        },
      ],
      (reactor, harness) =>
        Effect.gen(function* () {
          yield* reactor.markOpenThreads();
          assert.deepStrictEqual(yield* harness.dispatched, [
            { threadId: thread.id, tag: NEEDS_YOU, tagged: true },
          ]);
          const [command] = yield* Ref.get(harness.commands);
          assert.strictEqual(
            command?.commandId,
            `server:thread-attention:${asked.id}:${NEEDS_YOU}:set`,
          );
        }),
    );
  });

  it.effect("start-up pass stops at a run that did not complete", () => {
    const thread = makeThread("startup-stop");
    const asked = makeRun(thread.id, 1, "completed");
    const interrupted = makeRun(thread.id, 2, "interrupted");
    const latest = makeRun(thread.id, 3, "completed");
    return withReactor(
      [
        {
          thread,
          runs: [asked, interrupted, latest],
          messages: [
            makeMessage(asked, "reply", ASKS),
            makeMessage(interrupted, "reply", "Partial work."),
            makeMessage(latest, "reply", PLAIN),
          ],
        },
      ],
      (reactor, harness) =>
        Effect.gen(function* () {
          yield* reactor.markOpenThreads();
          assert.deepStrictEqual(yield* harness.dispatched, []);
        }),
    );
  });

  it.effect("start-up pass skips settled, archived and already marked threads", () =>
    withReactor(
      [
        threadWithRun("settled", "completed", ASKS, {
          settledOverride: "settled",
          settledAt: NOW,
        }),
        threadWithRun("archived", "completed", ASKS, { archivedAt: NOW }),
        threadWithRun("marked", "completed", ASKS, { tags: [NOTHING_NEEDED] }),
        threadWithRun("open", "completed", ASKS),
      ],
      (reactor, harness) =>
        Effect.gen(function* () {
          yield* reactor.markOpenThreads();
          assert.deepStrictEqual(yield* harness.dispatched, [
            { threadId: ThreadId.make("open"), tag: NEEDS_YOU, tagged: true },
          ]);
        }),
    ),
  );

  it.effect("start-up pass skips threads that have a parent", () =>
    withReactor([threadWithRun("child", "completed", ASKS, CHILD_THREAD)], (reactor, harness) =>
      Effect.gen(function* () {
        yield* reactor.markOpenThreads();
        assert.deepStrictEqual(yield* harness.dispatched, []);
      }),
    ),
  );

  it.effect("start-up pass looks past a queued follow-up", () => {
    const thread = makeThread("startup-queued");
    const run = makeRun(thread.id, 1, "completed");
    return withReactor(
      [
        {
          thread,
          runs: [run, notStarted(makeRun(thread.id, 2, "queued"))],
          messages: [makeMessage(run, "reply", ASKS)],
        },
      ],
      (reactor, harness) =>
        Effect.gen(function* () {
          yield* reactor.markOpenThreads();
          assert.deepStrictEqual(yield* harness.dispatched, [
            { threadId: thread.id, tag: NEEDS_YOU, tagged: true },
          ]);
        }),
    );
  });
});

describe("ThreadAttentionReactor.start", () => {
  it.effect("subscribes to domain events before the start-up pass", () =>
    Effect.gen(function* () {
      const opened = yield* Deferred.make<void>();
      const streamOpenAtPass = yield* Deferred.make<boolean>();
      return yield* withReactor(
        [],
        (reactor) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* reactor.start();
              assert.isTrue(yield* Deferred.await(streamOpenAtPass));
            }),
          ),
        {
          streamDomainEvents: Stream.unwrap(
            Deferred.succeed(opened, undefined).pipe(Effect.as(Stream.never)),
          ),
          onShellSnapshot: Deferred.isDone(opened).pipe(
            Effect.flatMap((open) => Deferred.succeed(streamOpenAtPass, open)),
            Effect.asVoid,
          ),
        },
      );
    }),
  );
});
