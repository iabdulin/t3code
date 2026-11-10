import {
  CommandId,
  THREAD_ATTENTION_TAGS,
  threadAttentionMark,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type RunId,
  type ThreadAttentionMark,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { classifyClosingSection } from "./ThreadAttentionClassifier.ts";

/** Tags a thread with what its last turn needs from the user. */
export class ThreadAttentionReactor extends Context.Service<
  ThreadAttentionReactor,
  {
    /** Runs the start-up pass, then follows domain events until the scope closes. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Marks or unmarks the thread of a finished run. Never fails. */
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Marks unmarked open threads from their recent runs. Never fails. */
    readonly markOpenThreads: () => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadAttentionReactor") {}

const CLEARING_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);
const START_UP_RUN_LOOKBACK = 5;

const byNewestRun = (a: OrchestrationV2Run, b: OrchestrationV2Run) => b.ordinal - a.ordinal;

const runAssistantMessages = (runId: RunId): ProjectionStore.ProjectionRecordFilter => ({
  messageRunIds: [runId],
  messageRoles: ["assistant"],
});

/** Messages must come from `runAssistantMessages`; subagents write to their own threads. */
function closingMark(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): ThreadAttentionMark | null {
  const finished = messages.findLast((message) => !message.streaming);
  return finished === undefined ? null : classifyClosingSection(finished.text);
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const applyMark = Effect.fnUntraced(function* (
    thread: OrchestrationV2AppThread,
    runId: RunId,
    wanted: ThreadAttentionMark | null,
  ) {
    const tags = thread.tags ?? [];
    const changes = Object.entries(THREAD_ATTENTION_TAGS)
      .map(([mark, tag]) => ({ tag, tagged: mark === wanted }))
      .filter(({ tag, tagged }) => tags.includes(tag) !== tagged)
      .toSorted((a, b) => Number(b.tagged) - Number(a.tagged));
    for (const { tag, tagged } of changes) {
      yield* engine.dispatch({
        type: "thread.tag.set",
        commandId: CommandId.make(
          `server:thread-attention:${runId}:${tag}:${tagged ? "set" : "clear"}`,
        ),
        threadId: thread.id,
        tag,
        tagged,
      });
    }
  });

  // Runs for every domain event; most events return before any work is needed.
  const handle: ThreadAttentionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated") return;
      const run = event.payload;
      const clears = CLEARING_STATUSES.has(run.status);
      if (run.status !== "completed" && !clears) return;
      const { thread, runs, messages } = yield* projections.getThreadRecords(
        event.threadId,
        ["messages", "runs"],
        runAssistantMessages(run.id),
      );
      if (thread.archivedAt !== null || thread.deletedAt !== null) return;
      if (runs.toSorted(byNewestRun)[0]?.id !== run.id) return;
      const wanted = clears ? null : closingMark(messages);
      if (!clears && wanted === null) return;
      yield* applyMark(thread, run.id, wanted);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("marking thread attention failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const markFromRecentRuns = Effect.fnUntraced(function* (threadId: ThreadId) {
    const { thread, runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    for (const run of runs.toSorted(byNewestRun).slice(0, START_UP_RUN_LOOKBACK)) {
      if (run.status !== "completed") return;
      const { messages } = yield* projections.getThreadRecords(
        threadId,
        ["messages"],
        runAssistantMessages(run.id),
      );
      const mark = closingMark(messages);
      if (mark !== null) return yield* applyMark(thread, run.id, mark);
    }
  });

  const markOpenThreads: ThreadAttentionReactor["Service"]["markOpenThreads"] = Effect.fn(
    "ThreadAttentionReactor.markOpenThreads",
  )(
    function* () {
      const snapshot = yield* projections.getShellSnapshot({
        location: "active",
        unsettledOnly: true,
      });
      for (const shell of snapshot.threads) {
        if (
          shell.archivedAt !== null ||
          shell.settledAt !== null ||
          shell.settledOverride === "settled" ||
          threadAttentionMark(shell.tags) !== null ||
          shell.status !== "completed"
        ) {
          continue;
        }
        yield* markFromRecentRuns(shell.id).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("marking an open thread's attention failed", {
              threadId: shell.id,
              cause,
            }),
          ),
        );
      }
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("listing open threads for attention marks failed", { cause }),
    ),
  );

  const start: ThreadAttentionReactor["Service"]["start"] = () =>
    forkParked(
      markOpenThreads().pipe(
        Effect.andThen(Stream.runForEach(engine.streamDomainEvents, handle)),
        Effect.catchCause((cause) =>
          Effect.logWarning("thread attention event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle, markOpenThreads } satisfies ThreadAttentionReactor["Service"];
});

export const layer = Layer.effect(ThreadAttentionReactor, make);
