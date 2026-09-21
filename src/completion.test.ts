import { describe, expect, test } from "bun:test";
import { QUIET_MS, openTasks, threadOutcome } from "./completion.ts";
import type { T3ThreadTurn } from "./t3.ts";

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
