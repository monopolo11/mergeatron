import { describe, expect, test } from "bun:test";
import { openDatabase } from "./db/index.ts";
import type { Run } from "./rules.ts";
import { HANDOFF_EVENT } from "./shared.ts";
import { Store } from "./store.ts";

const run = (patch: Partial<Run>): Omit<Run, "id" | "createdAt"> => ({
  ruleId: "r1",
  ruleName: "review",
  deliveryId: crypto.randomUUID(),
  event: "pull_request.review_requested",
  repo: "acme/widgets",
  source: "github",
  author: "alice",
  status: "started",
  detail: "",
  threadId: null,
  threadUrl: null,
  context: null,
  result: null,
  ...patch,
});

describe("Store.analytics", () => {
  test("counts runs per author and per source, split by status", () => {
    const store = new Store(openDatabase(":memory:"));
    store.recordRun(run({}));
    store.recordRun(run({ status: "failed" }));
    store.recordRun(run({ author: "bob", status: "skipped" }));
    store.recordRun(run({ ruleId: "manual", source: "manual", author: null }));
    store.recordRun(run({ event: "slack.message", source: "slack", author: "bob", status: "done", result: "lgtm" }));

    const analytics = store.analytics();
    expect(analytics.all).toEqual({ total: 5, started: 2, done: 1, skipped: 1, failed: 1 });
    expect(analytics.byAuthor).toEqual([
      { author: "alice", total: 2, started: 1, done: 0, skipped: 0, failed: 1 },
      { author: "bob", total: 2, started: 0, done: 1, skipped: 1, failed: 0 },
    ]);
    expect(analytics.bySource).toEqual([
      { source: "github", total: 3, started: 1, done: 0, skipped: 1, failed: 1 },
      { source: "manual", total: 1, started: 1, done: 0, skipped: 0, failed: 0 },
      { source: "slack", total: 1, started: 0, done: 1, skipped: 0, failed: 0 },
    ]);
  });

  test("is empty without runs", () => {
    const store = new Store(openDatabase(":memory:"));
    expect(store.analytics()).toEqual({ all: { total: 0, started: 0, done: 0, skipped: 0, failed: 0 }, byAuthor: [], bySource: [] });
  });
});

describe("Store.pullRequests", () => {
  const pr = (number: string, patch: Partial<Run> = {}) => run({ context: { pr_number: number, pr_title: `PR ${number}` }, ...patch });

  test("groups runs per PR with verdict counts and a derived status", () => {
    const store = new Store(openDatabase(":memory:"));
    store.recordRun(pr("1", { status: "done", result: "**CHANGES_REQUESTED**" }));
    store.recordRun(pr("1", { status: "done", result: "Verdict: approve" }));
    store.recordRun(pr("1", { status: "skipped" }));
    store.recordRun(pr("2", { status: "done", result: "**CHANGES_REQUESTED**" }));
    store.recordRun(pr("2", { status: "started" }));
    store.recordRun(pr("3", { status: "failed" }));
    store.recordRun(run({ ruleId: "manual", source: "manual", author: null }));

    const byNumber = Object.fromEntries(store.pullRequests().map((summary) => [summary.number, summary]));
    expect(Object.keys(byNumber).sort()).toEqual(["1", "2", "3"]);
    expect(byNumber["1"]).toMatchObject({ title: "PR 1", status: "approved", reviews: 2, approved: 1, changesRequested: 1, skipped: 1, failed: 0 });
    expect(byNumber["2"]).toMatchObject({ status: "reviewing", reviews: 1, changesRequested: 1 });
    expect(byNumber["3"]).toMatchObject({ status: "failed", reviews: 0, failed: 1 });
  });

  test("is paused once the change-request streak hits the limit, and handoffs are not reviews", () => {
    const store = new Store(openDatabase(":memory:"));
    for (let i = 0; i < 3; i++) store.recordRun(pr("7", { status: "done", result: "changes requested" }));
    store.recordRun(pr("7", { ruleId: "handoff", event: HANDOFF_EVENT, status: "done", result: "handoff doc" }));

    expect(store.pullRequests()).toEqual([expect.objectContaining({ number: "7", status: "paused", reviews: 3, changesRequested: 3 })]);
  });
});
