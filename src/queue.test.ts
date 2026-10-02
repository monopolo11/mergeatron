import { describe, expect, test } from "bun:test";
import { openDatabase } from "./db/index.ts";
import { runRules, startQueued, type HandlerDeps } from "./handler.ts";
import { itemContext, itemEvent } from "./inbox.ts";
import { linear, pr, rule } from "./inbox.test.ts";
import { Store } from "./store.ts";
import type { T3Client, T3Project } from "./t3.ts";

const project: T3Project = { id: "p1", title: "widgets", workspaceRoot: "/w", deletedAt: null, defaultModelSelection: null, repositoryIdentity: null };
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A T3 that accepts every thread; deps wired like index.ts, with the queue advancing on capacity. */
function setup() {
  const store = new Store(openDatabase(":memory:"));
  const started: string[] = [];
  const t3 = {
    projects: async () => [project],
    startThread: async (input: { title: string }) => (started.push(input.title), { threadId: `t${started.length}`, threadUrl: `http://t3/t${started.length}` }),
  } as unknown as T3Client;
  const deps: HandlerDeps = { store, t3, slack: null, onCapacity: (ruleId) => startQueued(deps, ruleId) };
  return { store, deps, started };
}

const other = { ...pr, key: "github:acme/widgets#43", identifier: "#43", url: "https://github.com/acme/widgets/pull/43", title: "Second PR" };
const { id: _id, createdAt: _c, updatedAt: _u, ...input } = rule;

describe("concurrency limit", () => {
  test("matches past the limit queue, then start oldest first as threads settle", async () => {
    const { store, deps, started } = setup();
    const limited = store.createRule({ ...input, maxConcurrent: 1, projectId: "p1" });

    const [first] = runRules(deps, { deliveryId: "d1", event: itemEvent(pr), ctx: itemContext(pr) }, [limited]);
    const [second] = runRules(deps, { deliveryId: "d2", event: itemEvent(other), ctx: itemContext(other) }, [limited]);
    const [third] = runRules(deps, { deliveryId: "d3", event: itemEvent(linear), ctx: itemContext(linear) }, [limited]);
    expect(first!.status).toBe("started");
    expect(second).toMatchObject({ status: "queued", detail: "queued: 1 of 1 threads running" });
    expect(second!.action).toMatchObject({ name: "review", prompt: "x", maxConcurrent: 1 });
    expect(third!.status).toBe("queued");
    await settle();
    expect(started).toEqual(["review: Add widgets"]);

    // The first thread settles: the queue advances by one.
    store.updateRun(first!.id, { status: "done", result: "approved" });
    deps.onCapacity!(limited.id);
    expect(store.getRun(second!.id)!.status).toBe("started");
    expect(store.getRun(third!.id)!.status).toBe("queued");
    await settle();
    expect(started).toEqual(["review: Add widgets", "review: Second PR"]);
    expect(store.getRun(second!.id)).toMatchObject({ status: "started", threadUrl: "http://t3/t2" });

    // Raising the limit starts the rest.
    store.updateRule(limited.id, { ...input, maxConcurrent: 0, projectId: "p1" });
    startQueued(deps, limited.id);
    await settle();
    expect(store.getRun(third!.id)!.status).toBe("started");
    expect(started).toHaveLength(3);
  });

  test("a queued review holds the PR lock, and is skipped if its PR got a thread before it started", async () => {
    const { store, deps } = setup();
    const limited = store.createRule({ ...input, maxConcurrent: 1, projectId: "p1" });
    const [first] = runRules(deps, { deliveryId: "d1", event: itemEvent(pr), ctx: itemContext(pr) }, [limited]);
    const [queued] = runRules(deps, { deliveryId: "d2", event: itemEvent(other), ctx: itemContext(other) }, [limited]);
    const [dup] = runRules(deps, { deliveryId: "d3", event: itemEvent(other), ctx: itemContext(other) }, [limited]);
    expect(dup!.status).toBe("skipped");
    expect(dup!.detail).toContain("already running for acme/widgets#43");

    // Another rule (unlimited) reviews #43 meanwhile; when capacity frees, the queued run yields to it.
    const eager = store.createRule({ ...input, name: "eager", maxConcurrent: 0, projectId: "p1" });
    store.recordRun({ ruleId: eager.id, ruleName: "eager", deliveryId: "e1", event: itemEvent(other), repo: "acme/widgets", source: "manual", author: null, status: "started", detail: "", threadId: "tx", threadUrl: "http://t3/tx", context: itemContext(other), result: null });
    store.updateRun(first!.id, { status: "failed" });
    deps.onCapacity!(limited.id);
    expect(store.getRun(queued!.id)).toMatchObject({ status: "skipped", threadUrl: "http://t3/tx" });
  });

  test("a dispatch keeps its limit through the frozen action, since no rule is stored", async () => {
    const { store, deps, started } = setup();
    const dispatch = { ...rule, id: "dispatch", name: "Review PR", maxConcurrent: 1, projectId: "p1" };
    const [a] = runRules(deps, { deliveryId: "d1", event: itemEvent(pr), ctx: itemContext(pr), source: "manual" }, [dispatch]);
    const [b] = runRules(deps, { deliveryId: "d2", event: itemEvent(other), ctx: itemContext(other), source: "manual" }, [dispatch]);
    expect(b!.status).toBe("queued");
    expect(store.queuedRuleIds()).toEqual(["dispatch"]);
    await settle();
    store.updateRun(a!.id, { status: "done" });
    startQueued(deps, "dispatch");
    await settle();
    expect(store.getRun(b!.id)!.status).toBe("started");
    expect(started).toEqual(["Review PR: Add widgets", "Review PR: Second PR"]);
  });
});
