import { describe, expect, it } from "@effect/vitest";
import { THREAD_ATTENTION_TAGS, threadAttentionMark } from "@t3tools/contracts";

import { classifyClosingSection } from "./ThreadAttentionClassifier.ts";

describe("classifyClosingSection", () => {
  it.each([
    ["Done.\n\n**What I need from you**\n\n1. Approve the plan\n2. Reply 'ok'", "needs-you"],
    [
      "## What I need from you\n\nNothing needed from you right now. The work is finished.",
      "nothing-needed",
    ],
    ["**What I need from you:**\n- Nothing needed from you right now", "nothing-needed"],
    ["**What I need from you**\n1. Nothing needed, all done", "nothing-needed"],
    ["**WHAT I NEED FROM YOU**  \nnothing NEEDED", "nothing-needed"],
    [
      'The rule says: end with "What I need from you".\n\n**What I need from you**\n\nNothing needed from you right now.',
      "nothing-needed",
    ],
    [
      "**What I need from you**\n\nNothing needed.\n\nLater edit:\n\n**What I need from you**\n\n1. Run the command",
      "needs-you",
    ],
    ["**What I need from you**:\n1. Approve the plan", "needs-you"],
    ["**What I need from you**:\nNothing needed from you right now.", "nothing-needed"],
    ["**What I need from you**\n\nNothing right now. The build is still going.", "nothing-needed"],
    ["## What I need from you\n\nNone.", "nothing-needed"],
    ["**What I need from you**\n\n- nothing from you for now", "nothing-needed"],
    ["Deployed and verified.\n\nNothing needed from you right now.", "nothing-needed"],
    ["Deployed.\n\n**Nothing needed from you right now.** The work is finished.", "nothing-needed"],
    ["Nothing needed from you right now.\n\nActually, please approve the PR.", null],
    ["I found nothing needed from you in the logs.", null],
    ["**What I need from you**\n\nNotify me when the deploy is done", "needs-you"],
    ["**What I need from you**\n\n   \n", null],
    ["All done, nothing else.", null],
    ["What I need from you is patience, and here is why.", null],
    ["", null],
  ] as const)("classifies %j as %j", (text, expected) => {
    expect(classifyClosingSection(text)).toBe(expected);
  });
});

describe("threadAttentionMark", () => {
  it("pins the verbatim tag values", () => {
    expect(THREAD_ATTENTION_TAGS["needs-you"]).toBe("attention:needs-you");
    expect(THREAD_ATTENTION_TAGS["nothing-needed"]).toBe("attention:nothing-needed");
  });

  it("returns null without attention tags", () => {
    expect(threadAttentionMark(undefined)).toBeNull();
    expect(threadAttentionMark([])).toBeNull();
  });

  it("reads a single mark", () => {
    expect(threadAttentionMark(["demo", THREAD_ATTENTION_TAGS["nothing-needed"]])).toBe(
      "nothing-needed",
    );
  });

  it("reads both marks as needs-you", () => {
    expect(
      threadAttentionMark([
        THREAD_ATTENTION_TAGS["nothing-needed"],
        THREAD_ATTENTION_TAGS["needs-you"],
      ]),
    ).toBe("needs-you");
  });
});
