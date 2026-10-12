import { describe, expect, test } from "bun:test";
import { Effect, Schedule } from "effect";
import { Background } from "./background.ts";
import { Store } from "./store.ts";
import { T3HttpError, type T3Thread } from "./t3.ts";
import { fakeT3, fakeUsage, runWith, testLayer } from "./testing.ts";
import { parseSession, recordUsage, startBackfill, type SessionUsage } from "./usage.ts";

/** Trimmed from `ccusage session --id <id> --json` (ccusage 20): a main-agent message and a subagent's. */
const CCUSAGE_OUTPUT = JSON.stringify({
  entries: [
    { cacheCreationTokens: 43387, cacheReadTokens: 16948, costUSD: 0, inputTokens: 2, model: "claude-opus-5-5", outputTokens: 308, timestamp: "2026-10-11T02:07:45.096Z" },
    { cacheCreationTokens: 2390, cacheReadTokens: 76172, costUSD: 0, inputTokens: 4, model: "claude-haiku-5-5", outputTokens: 436, timestamp: "2026-10-11T02:08:01.136Z" },
  ],
  sessionId: "ef720684-fedd-4de6-ad41-9aa7750a73e1",
  totalCost: 0.4271,
  totalTokens: 139647,
});

describe("parseSession", () => {
  test("sums the entries by kind and takes the session's cost", async () => {
    expect(await Effect.runPromise(parseSession(CCUSAGE_OUTPUT))).toEqual({
      inputTokens: 6,
      outputTokens: 744,
      cacheCreationTokens: 45777,
      cacheReadTokens: 93120,
      totalTokens: 139647,
      costUsd: 0.4271,
      models: ["claude-opus-5-5", "claude-haiku-5-5"],
    });
  });

  test("an unknown session is null", async () => {
    expect(await Effect.runPromise(parseSession("null\n"))).toBeNull();
  });
});

describe("recordUsage", () => {
  const session = (costUsd: number, model: string): SessionUsage => ({
    inputTokens: 1,
    outputTokens: 10,
    cacheCreationTokens: 100,
    cacheReadTokens: 1000,
    totalTokens: 1111,
    costUsd,
    models: [model],
  });
  const sessions: Record<string, SessionUsage> = {
    s1: session(0.5, "claude-opus-5-5"),
    s2: session(0.25, "claude-sonnet-5-5"),
    native: session(9, "claude-haiku-5-5"),
  };
  const provider = (nativeId: string | null): T3Thread["providerThreads"][number] => ({
    nativeThreadRef: nativeId ? { driver: "claudeAgent", nativeId } : null,
    updatedAt: "2026-10-11T02:08:57.338Z",
  });
  const task = (origin: "provider_native" | "app_owned", childThreadId: string): T3Thread["subagents"][number] => ({
    origin,
    childThreadId,
    status: "completed",
    updatedAt: "2026-10-11T02:08:57.338Z",
  });
  const thread = (providerThreads: T3Thread["providerThreads"], subagents: T3Thread["subagents"] = []): T3Thread => ({
    thread: { pullRequests: [] },
    runs: [],
    messages: [],
    turnItems: [],
    subagents,
    providerThreads,
  });
  /**
   * t1 delegated t2 through T3 (which points back at t1) and a thread since
   * deleted; its own subagent's child thread must not count twice.
   */
  const threads: Record<string, T3Thread> = {
    t1: thread([provider("s1"), provider("s1"), provider("gone"), provider(null)], [task("app_owned", "t2"), task("provider_native", "tn"), task("app_owned", "deleted")]),
    t2: thread([provider("s2")], [task("app_owned", "t1")]),
    tn: thread([provider("native")]),
  };
  const layer = () =>
    testLayer({
      t3: fakeT3({ thread: (id) => (threads[id] ? Effect.succeed(threads[id]) : Effect.fail(new T3HttpError({ status: 404, message: "gone" }))) }),
      usage: fakeUsage({ session: (id) => Effect.succeed(sessions[id] ?? null) }),
    });
  /** A run on t1, stored so its usage has a row to belong to. */
  const recordRun = (deliveryId = "d1") => Effect.flatMap(Store, (store) =>
    store.recordRun({
      ruleId: "r1",
      ruleName: "review",
      deliveryId,
      event: "pull_request.review_requested",
      repo: "acme/widgets",
      source: "github",
      author: "alice",
      status: "done",
      detail: "",
      threadId: "t1",
      threadUrl: null,
      context: null,
      result: null,
    }),
  );

  test("sums the thread's sessions and those of the tasks it delegated through T3", () =>
    runWith(
      layer(),
      Effect.gen(function* () {
        const run = yield* recordRun();
        yield* recordUsage(run);
        expect((yield* (yield* Store).runUsage([run.id])).get(run.id)).toMatchObject({
          outputTokens: 20,
          totalTokens: 2222,
          costUsd: 0.75,
          models: ["claude-opus-5-5", "claude-sonnet-5-5"],
          sessionIds: ["s1", "s2"],
        });
      }),
    ));

  test("with delegated tasks turned off, counts the run's own thread only", () =>
    runWith(
      layer(),
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveSettings({ ...(yield* store.getSettings()), usageIncludesDelegatedTasks: false });
        expect(yield* recordUsage(yield* recordRun())).toMatchObject({ costUsd: 0.5, sessionIds: ["s1"] });
      }),
    ));

  test("the backfill measures every settled run that has no usage yet", () =>
    runWith(
      layer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const runs = [yield* recordRun("d1"), yield* recordRun("d2")];
        expect(yield* startBackfill()).toEqual({ pending: 2, running: true });
        const background = yield* Background;
        yield* Effect.repeat(background.watching, { schedule: Schedule.spaced("5 millis"), until: (running) => running === 0 });
        expect([...(yield* store.runUsage(runs.map((run) => run.id))).values()].map((usage) => usage.costUsd)).toEqual([0.75, 0.75]);
        expect(yield* startBackfill()).toEqual({ pending: 0, running: false });
      }),
    ));

  test("the backfill stops counting runs with no session to measure", () =>
    runWith(
      testLayer({ t3: fakeT3({ thread: () => Effect.succeed(thread([provider("gone")])) }) }),
      Effect.gen(function* () {
        const store = yield* Store;
        const run = yield* recordRun();
        expect(yield* startBackfill()).toEqual({ pending: 1, running: true });
        const background = yield* Background;
        yield* Effect.repeat(background.watching, { schedule: Schedule.spaced("5 millis"), until: (running) => running === 0 });
        expect((yield* store.runUsage([run.id])).size).toBe(0);
        expect(yield* startBackfill()).toEqual({ pending: 0, running: false });
      }),
    ));

  test("stores nothing when no session is found", () =>
    runWith(
      testLayer({ t3: fakeT3({ thread: () => Effect.succeed(thread([provider("gone")])) }) }),
      Effect.gen(function* () {
        const run = yield* recordRun();
        expect(yield* recordUsage(run)).toBeNull();
        expect((yield* (yield* Store).runUsage([run.id])).size).toBe(0);
      }),
    ));
});
