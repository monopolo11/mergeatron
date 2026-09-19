import { describe, expect, test } from "bun:test";
import { openDatabase } from "./db/index.ts";
import type { Run } from "./rules.ts";
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
  ...patch,
});

describe("Store.analytics", () => {
  test("counts runs per author and per source, split by status", () => {
    const store = new Store(openDatabase(":memory:"));
    store.recordRun(run({}));
    store.recordRun(run({ status: "failed" }));
    store.recordRun(run({ author: "bob", status: "skipped" }));
    store.recordRun(run({ ruleId: "manual", source: "manual", author: null }));

    const analytics = store.analytics();
    expect(analytics.all).toEqual({ total: 4, started: 2, skipped: 1, failed: 1 });
    expect(analytics.byAuthor).toEqual([
      { author: "alice", total: 2, started: 1, skipped: 0, failed: 1 },
      { author: "bob", total: 1, started: 0, skipped: 1, failed: 0 },
    ]);
    expect(analytics.bySource).toEqual([
      { source: "github", total: 3, started: 1, skipped: 1, failed: 1 },
      { source: "manual", total: 1, started: 1, skipped: 0, failed: 0 },
    ]);
  });

  test("is empty without runs", () => {
    const store = new Store(openDatabase(":memory:"));
    expect(store.analytics()).toEqual({ all: { total: 0, started: 0, skipped: 0, failed: 0 }, byAuthor: [], bySource: [] });
  });
});
