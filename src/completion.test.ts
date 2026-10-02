import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { QUIET_MS, changesRequestedStreak, openTasks, pausedReview, reactVerdict, reviewVerdict, threadOutcome } from "./completion.ts";
import { HANDOFF_EVENT } from "./shared.ts";
import { SlackApiError, type SlackOrigin } from "./slack.ts";
import { Store } from "./store.ts";
import type { T3ThreadTurn } from "./t3.ts";
import { failureOf, runWith, testLayer } from "./testing.ts";

const T0 = Date.parse("2026-09-21T22:56:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const task = (kind: string, taskId: string, offsetMs: number, status?: string): T3ThreadTurn["activities"][number] => ({
  kind,
  turnId: null,
  createdAt: at(offsetMs),
  payload: status ? { taskId, status } : { taskId },
});

/** A thread whose first turn ended "standing by" while two subagents run. */
function thread(overrides: Partial<T3ThreadTurn> = {}): T3ThreadTurn {
  return {
    latestTurn: { turnId: "t1", state: "completed", completedAt: at(0), assistantMessageId: "a1" },
    messages: [
      { id: "u1", role: "user", text: "review it", turnId: null },
      { id: "a1", role: "assistant", text: "Standing by for their reports.", turnId: "t1" },
    ],
    activities: [task("task.started", "agentA", -30_000), task("task.started", "agentB", -20_000)],
    session: { status: "ready", activeTurnId: null, lastError: null },
    ...overrides,
  };
}

describe("openTasks", () => {
  test("a task is open from started/progress until completed", () => {
    const t = thread({
      activities: [
        task("task.started", "a", 0),
        task("task.progress", "a", 1_000),
        task("task.progress", "b", 2_000),
        task("task.updated", "c", 3_000, "completed"),
        task("task.started", "c", 2_500),
        task("task.completed", "a", 4_000, "failed"),
      ],
    });
    expect([...openTasks(t)]).toEqual(["b"]);
  });
});

describe("threadOutcome", () => {
  test("waits while the turn runs", () => {
    const t = thread({ latestTurn: { turnId: "t1", state: "running", completedAt: null, assistantMessageId: null } });
    expect(threadOutcome(t, T0 + QUIET_MS * 10)).toBeNull();
  });

  test("waits while background tasks are open, however long the thread is quiet", () => {
    expect(threadOutcome(thread(), T0 + 30 * 60_000)).toBeNull();
  });

  test("waits for the quiet window after the last task reports, then settles on the latest turn", () => {
    const done = thread({
      activities: [
        task("task.started", "agentA", -30_000),
        task("task.completed", "agentA", 5_000, "completed"),
      ],
    });
    expect(threadOutcome(done, T0 + 5_000 + QUIET_MS - 1)).toBeNull();
    expect(threadOutcome(done, T0 + 5_000 + QUIET_MS)).toEqual({
      status: "done",
      detail: "turn completed",
      result: "Standing by for their reports.",
    });
  });

  test("the verdict is the final message of the turn that read the task results", () => {
    const verdict = thread({
      latestTurn: { turnId: "t2", state: "completed", completedAt: at(600_000), assistantMessageId: "a2" },
      messages: [{ id: "a2", role: "assistant", text: "Review published: APPROVED", turnId: "t2" }],
      activities: [task("task.started", "agentA", -30_000), task("task.completed", "agentA", 590_000, "completed")],
    });
    expect(threadOutcome(verdict, T0 + 600_000 + QUIET_MS)?.result).toBe("Review published: APPROVED");
  });

  test("errors, interruptions and a stopped session settle at once, open tasks or not", () => {
    const errored = thread({
      latestTurn: { turnId: "t1", state: "error", completedAt: at(0), assistantMessageId: null },
      session: { status: "ready", activeTurnId: null, lastError: "provider crashed" },
    });
    expect(threadOutcome(errored, T0)).toMatchObject({ status: "failed", detail: "provider crashed" });
    const interrupted = thread({ latestTurn: { turnId: "t1", state: "interrupted", completedAt: at(0), assistantMessageId: "a1" } });
    expect(threadOutcome(interrupted, T0)?.detail).toBe("turn interrupted");
    const stopped = thread({ session: { status: "stopped", activeTurnId: null, lastError: null } });
    expect(threadOutcome(stopped, T0)?.status).toBe("done");
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
