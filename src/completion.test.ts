import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { QUIET_MS, changesRequestedStreak, pausedReview, reactVerdict, reviewVerdict, threadOutcome } from "./completion.ts";
import { HANDOFF_EVENT } from "./shared.ts";
import { SlackApiError, type SlackOrigin } from "./slack.ts";
import { Store } from "./store.ts";
import type { T3Thread } from "./t3.ts";
import { failureOf, runWith, testLayer } from "./testing.ts";

const T0 = Date.parse("2026-09-21T22:56:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

type Run = T3Thread["runs"][number];

const run = (ordinal: number, status: Run["status"], completedOffsetMs: number | null = 0): Run => ({
  id: `run${ordinal}`,
  ordinal,
  status,
  startedAt: at(-60_000),
  completedAt: completedOffsetMs === null ? null : at(completedOffsetMs),
});

const reply = (id: string, runId: string, text: string, offsetMs = 0): T3Thread["messages"][number] => ({
  id,
  runId,
  role: "assistant",
  text,
  updatedAt: at(offsetMs),
});

/** A thread whose first run ended "standing by" while a subagent runs. */
function thread(overrides: Partial<T3Thread> = {}): T3Thread {
  return {
    runs: [run(1, "completed")],
    messages: [
      { id: "u1", runId: "run1", role: "user", text: "review it", updatedAt: at(-60_000) },
      reply("a1", "run1", "Looking at the diff.", -30_000),
      reply("a2", "run1", "Standing by for their reports."),
      reply("a3", "run1", "  "),
    ],
    turnItems: [],
    subagents: [{ origin: "provider_native", childThreadId: null, status: "running", updatedAt: at(-20_000) }],
    providerThreads: [{ pendingBackgroundTasks: [], updatedAt: at(0) }],
    ...overrides,
  };
}

describe("threadOutcome", () => {
  test("waits while a run is live, or before the first run starts", () => {
    expect(threadOutcome(thread({ runs: [run(1, "running", null)], subagents: [] }), T0 + QUIET_MS * 10)).toBeNull();
    expect(threadOutcome(thread({ runs: [], subagents: [] }), T0 + QUIET_MS * 10)).toBeNull();
  });

  test("waits while background work is pending, however long the thread is quiet", () => {
    const later = T0 + 30 * 60_000;
    expect(threadOutcome(thread(), later)).toBeNull();
    expect(threadOutcome(thread({ subagents: [{ origin: "provider_native", childThreadId: null, status: "completed", completionDelivery: { state: "pending" }, updatedAt: at(0) }] }), later)).toBeNull();
    expect(threadOutcome(thread({ subagents: [], providerThreads: [{ pendingBackgroundTasks: [{ taskId: "b1" }], updatedAt: at(0) }] }), later)).toBeNull();
  });

  test("waits for the quiet window after the last task reports, then settles on the last non-empty reply", () => {
    const done = thread({ subagents: [{ origin: "provider_native", childThreadId: null, status: "completed", completionDelivery: { state: "delivered" }, updatedAt: at(5_000) }] });
    expect(threadOutcome(done, T0 + 5_000 + QUIET_MS - 1)).toBeNull();
    expect(threadOutcome(done, T0 + 5_000 + QUIET_MS)).toEqual({
      status: "done",
      detail: "turn completed",
      result: "Standing by for their reports.",
    });
  });

  test("the verdict is the reply of the latest run, ignoring rolled back ones", () => {
    const verdict = thread({
      runs: [run(1, "completed"), run(2, "completed", 600_000), run(3, "rolled_back", 610_000)],
      messages: [reply("a2", "run1", "Standing by."), reply("b1", "run2", "Review published: APPROVED", 600_000)],
      subagents: [{ origin: "provider_native", childThreadId: null, status: "completed", updatedAt: at(590_000) }],
    });
    expect(threadOutcome(verdict, T0 + 600_000 + QUIET_MS)?.result).toBe("Review published: APPROVED");
  });

  test("failures and interruptions settle at once, background work or not", () => {
    const failed = thread({
      runs: [run(1, "failed")],
      turnItems: [
        { runId: "run1", type: "error", ordinal: 3, failure: { message: "provider crashed" } },
        { runId: "run1", type: "error", ordinal: 1, failure: { message: "retrying" } },
      ],
    });
    expect(threadOutcome(failed, T0)).toMatchObject({ status: "failed", detail: "provider crashed" });
    expect(threadOutcome(thread({ runs: [run(1, "failed")] }), T0)?.detail).toBe("turn failed");
    expect(threadOutcome(thread({ runs: [run(1, "interrupted")] }), T0)?.detail).toBe("turn interrupted");
  });
});

describe("reviewVerdict", () => {
  test("reads the GitHub review state the agent reports", () => {
    expect(reviewVerdict("Review published: **APPROVE** on `33d5528`. https://github.com/acme/w/pull/1#pullrequestreview-9")).toBe("approved");
    expect(reviewVerdict("Review posted.\n\n**Verdict: approve** (posted as COMMENT — GitHub refuses self-approval).")).toBe("approved");
    expect(reviewVerdict("Review published on `ed8e6f5`: **CHANGES_REQUESTED**, 7 inline comments.")).toBe("changes_requested");
    expect(reviewVerdict("Requested changes: two blockers. Happy to approve once fixed.")).toBe("changes_requested");
  });

  test("anything without a verdict, including no reply, is a comment", () => {
    expect(reviewVerdict("Standing by for their reports.")).toBe("commented");
    expect(reviewVerdict(null)).toBe("commented");
  });
});

describe("reactVerdict", () => {
  const origin: SlackOrigin = { channel: "C1", ts: "1.0", thread: "1.0" };
  const recorder = (reject: string[] = []) => {
    const names: string[] = [];
    return {
      names,
      react: (_origin: SlackOrigin, name: string) =>
        Effect.suspend(() => {
          names.push(name);
          return reject.includes(name) ? Effect.fail(new SlackApiError({ method: "reactions.add", code: "invalid_name" })) : Effect.void;
        }),
    };
  };

  test("maps failed, change request and approval to their emoji", async () => {
    const slack = recorder();
    await Effect.runPromise(reactVerdict(slack, origin, { status: "failed", detail: "boom", result: null }));
    await Effect.runPromise(reactVerdict(slack, origin, { status: "done", detail: "", result: "**CHANGES_REQUESTED**" }));
    await Effect.runPromise(reactVerdict(slack, origin, { status: "done", detail: "", result: "**APPROVE**" }));
    expect(slack.names).toEqual(["x", "repeat", "chayanne-approved"]);
  });

  test("falls back to a check mark when the workspace lacks the approval emoji", async () => {
    const slack = recorder(["chayanne-approved"]);
    await Effect.runPromise(reactVerdict(slack, origin, { status: "done", detail: "", result: "**APPROVE**" }));
    expect(slack.names).toEqual(["chayanne-approved", "white_check_mark"]);
  });

  test("other Slack errors still surface", async () => {
    const slack = recorder(["repeat"]);
    const error = await Effect.runPromise(failureOf(reactVerdict(slack, origin, { status: "done", detail: "", result: "**CHANGES_REQUESTED**" })));
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error.code).toBe("invalid_name");
  });
});

describe("changesRequestedStreak", () => {
  const review = (result: string, event = "slack.message") => ({ event, result });
  const CR = review("**CHANGES_REQUESTED**, 3 comments");

  test("counts change requests newest first until an approval, ignoring no-verdict replies and handoffs", () => {
    expect(changesRequestedStreak([CR, review("standing by"), CR, review("APPROVED"), CR])).toHaveLength(2);
    expect(changesRequestedStreak([review("handoff doc", HANDOFF_EVENT), CR, CR])).toHaveLength(2);
    expect(changesRequestedStreak([review("APPROVED"), CR, CR])).toHaveLength(0);
    expect(changesRequestedStreak([])).toHaveLength(0);
  });
});

describe("pausedReview", () => {
  test("pauses at the configured number of change requests in a row and names the handoff", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const finished = (result: string, event = "pull_request.synchronize", threadUrl: string | null = null) =>
          store.recordRun({
            ruleId: "r1", ruleName: "review", deliveryId: crypto.randomUUID(), event, repo: "Acme/Widgets", source: "github", author: "alice",
            status: "done", detail: "", threadId: threadUrl, threadUrl, context: { repo: "acme/widgets", pr_number: "42" }, result,
          });
        yield* store.saveSettings({ ...(yield* store.getSettings()), maxChangesRequestedRounds: 2 });
        yield* finished("CHANGES_REQUESTED");
        expect(yield* pausedReview("acme/widgets", "42")).toBeNull();
        yield* finished("request changes: still broken");
        yield* finished("# Handoff", HANDOFF_EVENT, "http://t3/handoff");
        expect(yield* pausedReview("acme/widgets", "42")).toMatchObject({ rounds: 2, handoff: { threadUrl: "http://t3/handoff" } });
        // Another PR is unaffected; a limit of 0 turns the pause off.
        expect(yield* pausedReview("acme/widgets", "43")).toBeNull();
        yield* store.saveSettings({ ...(yield* store.getSettings()), maxChangesRequestedRounds: 0 });
        expect(yield* pausedReview("acme/widgets", "42")).toBeNull();
      }),
    ));
});
