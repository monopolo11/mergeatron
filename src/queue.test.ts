import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runRules, startQueued } from "./handler.ts";
import { itemContext, itemEvent } from "./inbox.ts";
import { linear, pr, rule } from "./inbox.test.ts";
import { Store } from "./store.ts";
import type { T3Project } from "./t3.ts";
import { fakeT3, runWith, settle, testLayer } from "./testing.ts";

const project: T3Project = { id: "p1", title: "widgets", workspaceRoot: "/w", deletedAt: null, defaultModelSelection: null, repositoryIdentity: null };

/** A T3 that accepts every thread; `startQueued` plays the supervisor's part when a run settles. */
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

describe("concurrency limit", () => {
  test("matches past the limit queue, then start oldest first as threads settle", async () => {
    const { layer, started } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const limited = yield* store.createRule({ ...input, maxConcurrent: 1, projectId: "p1" });

        const [first] = yield* runRules({ deliveryId: "d1", event: itemEvent(pr), ctx: itemContext(pr) }, [limited]);
        const [second] = yield* runRules({ deliveryId: "d2", event: itemEvent(other), ctx: itemContext(other) }, [limited]);
        const [third] = yield* runRules({ deliveryId: "d3", event: itemEvent(linear), ctx: itemContext(linear) }, [limited]);
        expect(first!.status).toBe("started");
        expect(second).toMatchObject({ status: "queued", detail: "queued: 1 of 1 threads running" });
        expect(second!.action).toMatchObject({ name: "review", prompt: "x", maxConcurrent: 1 });
        expect(third!.status).toBe("queued");
        yield* settle;
        expect(started).toEqual(["review: Add widgets"]);

        // The first thread settles: the queue advances by one.
        yield* store.updateRun(first!.id, { status: "done", result: "approved" });
        yield* startQueued(limited.id);
        expect((yield* store.getRun(second!.id))!.status).toBe("started");
        expect((yield* store.getRun(third!.id))!.status).toBe("queued");
        yield* settle;
        expect(started).toEqual(["review: Add widgets", "review: Second PR"]);
        expect(yield* store.getRun(second!.id)).toMatchObject({ status: "started", threadUrl: "http://t3/t2" });

        // Raising the limit starts the rest.
        yield* store.updateRule(limited.id, { ...input, maxConcurrent: 0, projectId: "p1" });
        yield* startQueued(limited.id);
        yield* settle;
        expect((yield* store.getRun(third!.id))!.status).toBe("started");
        expect(started).toHaveLength(3);
      }),
    );
  });

  test("a queued review holds the PR lock, and is skipped if its PR got a thread before it started", async () => {
    const { layer } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const limited = yield* store.createRule({ ...input, maxConcurrent: 1, projectId: "p1" });
        const [first] = yield* runRules({ deliveryId: "d1", event: itemEvent(pr), ctx: itemContext(pr) }, [limited]);
        const [queued] = yield* runRules({ deliveryId: "d2", event: itemEvent(other), ctx: itemContext(other) }, [limited]);
        const [dup] = yield* runRules({ deliveryId: "d3", event: itemEvent(other), ctx: itemContext(other) }, [limited]);
        expect(dup!.status).toBe("skipped");
        expect(dup!.detail).toContain("already running for acme/widgets#43");

        // Another rule (unlimited) reviews #43 meanwhile; when capacity frees, the queued run yields to it.
        const eager = yield* store.createRule({ ...input, name: "eager", maxConcurrent: 0, projectId: "p1" });
        yield* store.recordRun({ ruleId: eager.id, ruleName: "eager", deliveryId: "e1", event: itemEvent(other), repo: "acme/widgets", source: "manual", author: null, status: "started", detail: "", threadId: "tx", threadUrl: "http://t3/tx", context: itemContext(other), result: null });
        yield* store.updateRun(first!.id, { status: "failed" });
        yield* startQueued(limited.id);
        expect(yield* store.getRun(queued!.id)).toMatchObject({ status: "skipped", threadUrl: "http://t3/tx" });
        yield* settle;
      }),
    );
  });

  test("a dispatch keeps its limit through the frozen action, since no rule is stored", async () => {
    const { layer, started } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const dispatch = { ...rule, id: "dispatch", name: "Review PR", maxConcurrent: 1, projectId: "p1" };
        const [a] = yield* runRules({ deliveryId: "d1", event: itemEvent(pr), ctx: itemContext(pr), source: "manual" }, [dispatch]);
        const [b] = yield* runRules({ deliveryId: "d2", event: itemEvent(other), ctx: itemContext(other), source: "manual" }, [dispatch]);
        expect(b!.status).toBe("queued");
        expect(yield* store.queuedRuleIds()).toEqual(["dispatch"]);
        yield* settle;
        yield* store.updateRun(a!.id, { status: "done" });
        yield* startQueued("dispatch");
        yield* settle;
        expect((yield* store.getRun(b!.id))!.status).toBe("started");
        expect(started).toEqual(["Review PR: Add widgets", "Review PR: Second PR"]);
      }),
    );
  });
});
