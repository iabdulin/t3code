import { THREAD_ATTENTION_TAGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  partitionThreadsByAttention,
  resolveSidebarAttentionGroup,
  SIDEBAR_ATTENTION_GROUPS,
} from "./threadAttentionGroup";

type TestThread = Parameters<typeof resolveSidebarAttentionGroup>[0];

function run(status: "completed" | "failed" | "running") {
  return {
    runId: "run-1",
    status,
    requestedAt: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: status === "running" ? null : "2026-01-01T00:01:00.000Z",
    assistantMessageId: null,
  } as TestThread["latestRun"];
}

function thread(overrides: Partial<Omit<TestThread, "source">> & { tags?: string[] } = {}) {
  const { tags, ...rest } = overrides;
  return {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    interactionMode: "default",
    hasActionableProposedPlan: false,
    latestRun: run("completed"),
    runtime: null,
    ...rest,
    source: { tags },
  } as TestThread;
}

const NEEDS_YOU = THREAD_ATTENTION_TAGS["needs-you"];
const NOTHING_NEEDED = THREAD_ATTENTION_TAGS["nothing-needed"];

describe("resolveSidebarAttentionGroup", () => {
  it.each([
    ["no tags, idle", thread(), false, "other"],
    ["needs-you tag", thread({ tags: [NEEDS_YOU] }), false, "needs-you"],
    ["nothing-needed tag", thread({ tags: [NOTHING_NEEDED] }), false, "nothing-needed"],
    [
      "pending approval beats the tag",
      thread({ hasPendingApprovals: true, tags: [NOTHING_NEEDED] }),
      false,
      "needs-you",
    ],
    ["pending user input", thread({ hasPendingUserInput: true }), false, "needs-you"],
    [
      "pending subagent request",
      thread({ pendingSubagentRequest: "approval" }),
      false,
      "needs-you",
    ],
    ["pending guest message", thread({ pendingGuestMessageCount: 1 }), false, "needs-you"],
    [
      "plan ready",
      thread({ interactionMode: "plan", hasActionableProposedPlan: true }),
      false,
      "needs-you",
    ],
    ["failed latest run", thread({ latestRun: run("failed") }), false, "needs-you"],
    ["working beats the tag", thread({ tags: [NEEDS_YOU] }), true, "other"],
    ["pending approval beats working", thread({ hasPendingApprovals: true }), true, "needs-you"],
  ] as const)("%s", (_name, input, working, expected) => {
    expect(resolveSidebarAttentionGroup(input, working)).toBe(expected);
  });
});

describe("partitionThreadsByAttention", () => {
  it("splits by group, keeps input order, and places each thread once", () => {
    const threads = [
      { id: "a", ...thread({ tags: [NOTHING_NEEDED] }) },
      { id: "b", ...thread({ tags: [NEEDS_YOU] }) },
      { id: "c", ...thread() },
      { id: "d", ...thread({ hasPendingUserInput: true }) },
      { id: "e", ...thread({ tags: [NOTHING_NEEDED] }) },
    ];
    const groups = partitionThreadsByAttention(threads, () => false);
    expect(groups["needs-you"].map((t) => t.id)).toEqual(["b", "d"]);
    expect(groups.other.map((t) => t.id)).toEqual(["c"]);
    expect(groups["nothing-needed"].map((t) => t.id)).toEqual(["a", "e"]);
  });
});

describe("SIDEBAR_ATTENTION_GROUPS", () => {
  it("lists groups top to bottom", () => {
    expect(SIDEBAR_ATTENTION_GROUPS).toEqual(["needs-you", "other", "nothing-needed"]);
  });
});
