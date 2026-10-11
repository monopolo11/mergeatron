import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { getRun } from "./runHistory.ts";
import { backfillPullRequests, recordPullRequests, syncPullRequests } from "./runPullRequests.ts";
import { Store } from "./store.ts";
import { T3HttpError, type T3PullRequest, type T3Thread } from "./t3.ts";
import { fakeT3, runWith, testLayer } from "./testing.ts";

const pull = (number: number, linkedAt: string, snapshot: T3PullRequest["snapshot"] = null): T3PullRequest => ({
  repository: "acme/widgets",
  number,
  url: `https://github.com/acme/widgets/pull/${number}`,
  linkedAt,
  snapshot,
});

const thread = (pullRequests: T3PullRequest[], delegated: string[] = []): T3Thread => ({
  thread: { pullRequests },
  runs: [],
  messages: [],
  turnItems: [],
  subagents: delegated.map((childThreadId) => ({ origin: "app_owned", childThreadId, status: "completed", updatedAt: "2026-10-11T02:00:00Z" })),
  providerThreads: [],
});

/** A run on `threadId` (t1 by default), stored so its PRs have a row to belong to. */
const recordRun = (threadId: string | null = "t1", deliveryId = "d1") => Effect.flatMap(Store, (store) =>
  store.recordRun({
    ruleId: "r1",
    ruleName: "implement",
    deliveryId,
    event: "linear.issue",
    repo: "acme/widgets",
    source: "poll",
    author: "alice",
    status: "done",
    detail: "",
    threadId,
    threadUrl: null,
    context: null,
    result: null,
  }),
);

describe("run pull requests", () => {
  test("collects the PRs linked to the thread and its delegated tasks, once each, in link order", () => {
    const merged = { title: "Fix the widget", state: "merged", isDraft: false } as const;
    const threads: Record<string, T3Thread> = {
      t1: thread([pull(12, "2026-10-11T02:05:00Z", merged)], ["t2"]),
      // The delegated task linked the parent's PR too, and one of its own before it.
      t2: thread([pull(12, "2026-10-11T02:09:00Z"), pull(11, "2026-10-11T02:01:00Z")]),
    };
    return runWith(
      testLayer({ t3: fakeT3({ thread: (id) => Effect.succeed(threads[id]!) }) }),
      Effect.gen(function* () {
        const run = yield* recordRun();
        yield* recordPullRequests(run);
        expect((yield* getRun(run.id)).pullRequests).toEqual([
          { repository: "acme/widgets", number: 11, url: "https://github.com/acme/widgets/pull/11", title: null, state: null, isDraft: false, linkedAt: "2026-10-11T02:01:00Z" },
          { repository: "acme/widgets", number: 12, url: "https://github.com/acme/widgets/pull/12", title: "Fix the widget", state: "merged", isDraft: false, linkedAt: "2026-10-11T02:05:00Z" },
        ]);
      }),
    );
  });

  test("syncing replaces the stored PRs with T3's, and keeps them once T3 deleted the thread", () => {
    let current: T3Thread | null = thread([pull(12, "2026-10-11T02:05:00Z")]);
    return runWith(
      testLayer({ t3: fakeT3({ thread: () => (current ? Effect.succeed(current) : Effect.fail(new T3HttpError({ status: 404, message: "gone" }))) }) }),
      Effect.gen(function* () {
        const run = yield* recordRun();
        yield* recordPullRequests(run);
        current = thread([pull(12, "2026-10-11T02:05:00Z", { title: "Fix", state: "open", isDraft: true }), pull(13, "2026-10-11T03:00:00Z")]);
        expect((yield* syncPullRequests(run.id)).map((pr) => [pr.number, pr.state, pr.isDraft])).toEqual([[12, "open", true], [13, null, false]]);
        current = null;
        expect((yield* syncPullRequests(run.id)).map((pr) => pr.number)).toEqual([12, 13]);
      }),
    );
  });

  test("the backfill reads settled runs never checked, and retries those that failed on the next start", () => {
    // t2 is an older thread, from before T3 recorded linked PRs.
    const threads: Record<string, T3Thread> = { t1: thread([pull(12, "2026-10-11T02:05:00Z")]), t2: { ...thread([]), thread: {} }, flaky: thread([pull(13, "2026-10-11T03:00:00Z")]) };
    let down = true;
    const read = (id: string) =>
      id === "flaky" && down ? Effect.fail(new T3HttpError({ status: 0, message: "down" })) : threads[id] ? Effect.succeed(threads[id]) : Effect.fail(new T3HttpError({ status: 404, message: "gone" }));
    return runWith(
      testLayer({ t3: fakeT3({ thread: read }) }),
      Effect.gen(function* () {
        const linked = yield* recordRun("t1", "d1");
        for (const [threadId, deliveryId] of [["t2", "d2"], ["deleted", "d3"], ["flaky", "d4"], [null, "d5"]] as const) yield* recordRun(threadId, deliveryId);
        // Checked when it settled, so the backfill leaves it alone.
        yield* recordPullRequests(yield* recordRun("t1", "d6"));

        expect(yield* backfillPullRequests()).toEqual({ runs: 4, withPullRequests: 1, gone: 1, failed: 1 });
        expect((yield* getRun(linked.id)).pullRequests.map((pr) => pr.number)).toEqual([12]);
        down = false;
        expect(yield* backfillPullRequests()).toEqual({ runs: 1, withPullRequests: 1, gone: 0, failed: 0 });
        expect((yield* backfillPullRequests()).runs).toBe(0);
      }),
    );
  });
});
