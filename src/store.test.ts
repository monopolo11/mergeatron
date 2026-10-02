import { describe, expect, test } from "bun:test";
import { openDatabase } from "./db/index.ts";
import { linear, pr } from "./inbox.test.ts";
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
  action: null,
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
    expect(analytics.all).toEqual({ total: 5, queued: 0, started: 2, done: 1, skipped: 1, failed: 1 });
    expect(analytics.byAuthor).toEqual([
      { author: "alice", total: 2, queued: 0, started: 1, done: 0, skipped: 0, failed: 1 },
      { author: "bob", total: 2, queued: 0, started: 0, done: 1, skipped: 1, failed: 0 },
    ]);
    expect(analytics.bySource).toEqual([
      { source: "github", total: 3, queued: 0, started: 1, done: 0, skipped: 1, failed: 1 },
      { source: "manual", total: 1, queued: 0, started: 1, done: 0, skipped: 0, failed: 0 },
      { source: "slack", total: 1, queued: 0, started: 0, done: 1, skipped: 0, failed: 0 },
    ]);
  });

  test("is empty without runs", () => {
    const store = new Store(openDatabase(":memory:"));
    expect(store.analytics()).toEqual({ all: { total: 0, queued: 0, started: 0, done: 0, skipped: 0, failed: 0 }, byAuthor: [], bySource: [] });
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

describe("Store inbox", () => {
  const t0 = "2026-10-02T10:00:00.000Z";
  const t1 = "2026-10-02T10:03:00.000Z";
  const t2 = "2026-10-04T10:06:00.000Z";
  const other = { ...pr, key: "github:acme/widgets#43", identifier: "#43", url: "https://github.com/acme/widgets/pull/43", updatedAt: "2026-01-03T00:00:00Z" };
  // Newer activity than the PR, so the active order is deterministic.
  const issue = { ...linear, updatedAt: "2026-01-05T00:00:00Z" };

  test("sync keeps first-seen across polls, marks missing items gone per source, and restarts a returning item's stay", () => {
    const store = new Store(openDatabase(":memory:"));
    expect(store.syncInbox("github", [pr, other], t0)).toEqual({ appeared: 2, returned: 0, gone: 0 });
    expect(store.syncInbox("linear", [issue], t0)).toEqual({ appeared: 1, returned: 0, gone: 0 });

    // #43 drops out of GitHub's results; the Linear issue is another source and is untouched.
    expect(store.syncInbox("github", [{ ...pr, title: "Add widgets (renamed)" }], t1)).toEqual({ appeared: 0, returned: 0, gone: 1 });
    const byKey = Object.fromEntries(store.listInbox({ gone: true }).map((item) => [item.key, item]));
    expect(byKey[pr.key]).toMatchObject({ title: "Add widgets (renamed)", firstSeenAt: t0, lastSeenAt: t1, goneAt: null });
    expect(byKey[other.key]).toMatchObject({ firstSeenAt: t0, lastSeenAt: t0, goneAt: t1 });
    expect(byKey[linear.key]).toMatchObject({ goneAt: null });
    expect(store.listInbox().map((item) => item.key)).toEqual([linear.key, pr.key]);
    expect(store.countGoneInbox()).toBe(1);

    // #43 comes back: a new stay.
    expect(store.syncInbox("github", [pr, other], t2)).toEqual({ appeared: 0, returned: 1, gone: 0 });
    expect(store.getInboxItem(other.key)).toMatchObject({ firstSeenAt: t2, lastSeenAt: t2, goneAt: null });

    // An empty poll empties the source.
    expect(store.syncInbox("github", [], t2)).toEqual({ appeared: 0, returned: 0, gone: 2 });
    expect(store.listInbox().map((item) => item.key)).toEqual([linear.key]);
  });

  test("gone items list after active ones, newest departure first, and are pruned after the retention window", () => {
    const store = new Store(openDatabase(":memory:"));
    store.syncInbox("github", [pr, other], t0);
    store.syncInbox("github", [pr], t1);
    store.syncInbox("github", [], t2);
    expect(store.listInbox({ gone: true }).map((item) => [item.key, item.goneAt])).toEqual([
      [pr.key, t2],
      [other.key, t1],
    ]);
    // Retention is 30 days from departure: #43 left at t1, #42 two days later at t2.
    expect(store.pruneInbox(Date.parse(t1) + 29 * 86_400_000)).toBe(0);
    expect(store.pruneInbox(Date.parse(t1) + 31 * 86_400_000)).toBe(1);
    expect(store.listInbox({ gone: true }).map((item) => item.key)).toEqual([pr.key]);
  });
});
