import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runRules, startQueued } from "./handler.ts";
import { itemContext, itemEvent } from "./inbox.ts";
import { linear, pr, rule } from "./inbox.test.ts";
import { pauseQueue, QueueNotPausedError, rescheduleResume, resumeQueue, resumeTimerOnStartup } from "./queuePause.ts";
import { Store } from "./store.ts";
import type { T3Project } from "./t3.ts";
import { failureOf, fakeT3, runWith, settle, testLayer } from "./testing.ts";

const project: T3Project = { id: "p1", title: "widgets", workspaceRoot: "/w", deletedAt: null, defaultModelSelection: null, repositoryIdentity: null };

function setup() {
  const started: string[] = [];
  const t3 = fakeT3({
    projects: () => Effect.succeed([project]),
    startThread: (input) => Effect.sync(() => (started.push(input.title), { threadId: `t${started.length}`, threadUrl: `http://t3/t${started.length}` })),
  });
  return { layer: testLayer({ t3 }), started };
}

const other = { ...pr, key: "github:acme/widgets#43", identifier: "#43", url: "https://github.com/acme/widgets/pull/43", title: "Second PR" };
const { id: _id, createdAt: _c, updatedAt: _u, ...input } = rule;
const limited = { id: "run0", threadUrl: "http://t3/t0" };
const LIMIT = "Claude API rate limit reached. Try again later.";
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
/** The resume timer is a watcher, which `settle` does not wait for: give a due one a moment to fire. */
const timerFires = Effect.andThen(Effect.sleep("30 millis"), settle);

describe("queue pause", () => {
  test("while paused every match queues, even under its rule's limit, and nothing starts until resumed", async () => {
    const { layer, started } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const unlimited = yield* store.createRule({ ...input, maxConcurrent: 0, projectId: "p1" });
        const resetAt = inAnHour();
        yield* pauseQueue(limited, LIMIT, resetAt);
        expect(yield* store.getQueuePause()).toMatchObject({ reason: LIMIT, resumeAt: resetAt, runId: "run0", threadUrl: "http://t3/t0" });

        const [first] = yield* runRules({ deliveryId: "d1", event: itemEvent(pr), ctx: itemContext(pr) }, [unlimited]);
        const [second] = yield* runRules({ deliveryId: "d2", event: itemEvent(other), ctx: itemContext(other) }, [unlimited]);
        expect(first).toMatchObject({ status: "queued", detail: "queued: usage ran out, the queue is paused" });
        expect(second!.status).toBe("queued");
        // A settle elsewhere advancing the rule's queue does not start them either.
        yield* startQueued(unlimited.id);
        yield* settle;
        expect(started).toEqual([]);

        yield* resumeQueue();
        yield* settle;
        expect(yield* store.getQueuePause()).toBeNull();
        expect(started).toEqual(["review: Add widgets", "review: Second PR"]);
        expect((yield* store.getRun(first!.id))!.status).toBe("started");
      }),
    );
  });

  test("resuming starts queued runs within each rule's limit", async () => {
    const { layer, started } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const one = yield* store.createRule({ ...input, maxConcurrent: 1, projectId: "p1" });
        yield* pauseQueue(limited, LIMIT, null);
        yield* runRules({ deliveryId: "d1", event: itemEvent(pr), ctx: itemContext(pr) }, [one]);
        const [later] = yield* runRules({ deliveryId: "d2", event: itemEvent(linear), ctx: itemContext(linear) }, [one]);
        yield* resumeQueue();
        yield* settle;
        expect(started).toEqual(["review: Add widgets"]);
        expect((yield* store.getRun(later!.id))!.status).toBe("queued");
      }),
    );
  });

  test("threads that run out together keep the first pause and resume at the later reset; an unknown reset keeps the known one", async () => {
    const { layer } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const soon = new Date(Date.now() + 60_000).toISOString();
        const later = inAnHour();
        const first = yield* pauseQueue(limited, LIMIT, soon);
        yield* pauseQueue({ id: "run1", threadUrl: "http://t3/t1" }, "another limit", later);
        yield* pauseQueue({ id: "run2", threadUrl: null }, "no reset", null);
        expect(yield* store.getQueuePause()).toEqual({ ...first, resumeAt: later });
        yield* resumeQueue();
      }),
    );
  });

  test("the queue resumes on its own at the reset time, and a rescheduled time replaces it", async () => {
    const { layer, started } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const unlimited = yield* store.createRule({ ...input, maxConcurrent: 0, projectId: "p1" });
        yield* pauseQueue(limited, LIMIT, inAnHour());
        yield* runRules({ deliveryId: "d1", event: itemEvent(pr), ctx: itemContext(pr) }, [unlimited]);
        yield* timerFires;
        expect(started).toEqual([]);

        // Picking a time already past resumes right away.
        const pause = yield* rescheduleResume(new Date(Date.now() - 1_000).toISOString());
        expect(pause.reason).toBe(LIMIT);
        yield* timerFires;
        expect(yield* store.getQueuePause()).toBeNull();
        expect(started).toEqual(["review: Add widgets"]);
      }),
    );
  });

  test("a reset time already past when the thread fails resumes at once", async () => {
    const { layer } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        yield* pauseQueue(limited, LIMIT, new Date(Date.now() - 60_000).toISOString());
        yield* timerFires;
        expect(yield* store.getQueuePause()).toBeNull();
      }),
    );
  });

  test("a pause left by the previous process re-arms its timer at startup", async () => {
    const { layer } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveQueuePause({ pausedAt: new Date().toISOString(), resumeAt: new Date(Date.now() - 1_000).toISOString(), reason: LIMIT, runId: null, threadUrl: null });
        yield* resumeTimerOnStartup();
        yield* timerFires;
        expect(yield* store.getQueuePause()).toBeNull();
      }),
    );
  });

  test("rescheduling a queue that is not paused fails; resuming one is a no-op", async () => {
    const { layer } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        expect(yield* failureOf(rescheduleResume(inAnHour()))).toBeInstanceOf(QueueNotPausedError);
        yield* resumeQueue();
        expect(yield* (yield* Store).getQueuePause()).toBeNull();
      }),
    );
  });
});
