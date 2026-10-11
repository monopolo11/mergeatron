import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { linear, pr, rule } from "./inbox.test.ts";
import { DEFAULT_SETTINGS, type Run, type RunUsage } from "./rules.ts";
import { deleteRun, getRun, InvalidFollowUpError, RunActiveError, RunNotFoundError, rateRun } from "./runHistory.ts";
import { DEFAULT_POLLING, HANDOFF_EVENT } from "./shared.ts";
import { Store, type RunInput } from "./store.ts";
import { failureOf, runWith, testLayer } from "./testing.ts";

const run = (patch: Partial<RunInput>): RunInput => ({
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

describe("Store.getSettings", () => {
  test("a source added after the settings were saved polls on its defaults", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const { sentry, ...saved } = { ...DEFAULT_POLLING, github: { enabled: false, minutes: 10 } };
        yield* store.saveSettings({ ...DEFAULT_SETTINGS, polling: saved as typeof DEFAULT_POLLING });
        expect((yield* store.getSettings()).polling).toEqual({ ...DEFAULT_POLLING, github: { enabled: false, minutes: 10 } });
      }),
    ));
});

describe("Store.analytics", () => {
  test("counts runs per author and per source, split by status", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.recordRun(run({}));
        yield* store.recordRun(run({ status: "failed" }));
        yield* store.recordRun(run({ author: "bob", status: "skipped" }));
        yield* store.recordRun(run({ ruleId: "manual", source: "manual", author: null }));
        yield* store.recordRun(run({ event: "slack.message", source: "slack", author: "bob", status: "done", result: "lgtm" }));

        const analytics = yield* store.analytics();
        expect(analytics.all).toEqual({ total: 5, queued: 0, started: 2, done: 1, skipped: 1, failed: 1 });
        expect(analytics.byAuthor).toEqual([
          { author: "alice", total: 2, queued: 0, started: 1, done: 0, skipped: 0, failed: 1, totalCostUsd: null },
          { author: "bob", total: 2, queued: 0, started: 0, done: 1, skipped: 1, failed: 0, totalCostUsd: null },
        ]);
        expect(analytics.bySource).toEqual([
          { source: "github", total: 3, queued: 0, started: 1, done: 0, skipped: 1, failed: 1 },
          { source: "manual", total: 1, queued: 0, started: 1, done: 0, skipped: 0, failed: 0 },
          { source: "slack", total: 1, queued: 0, started: 0, done: 1, skipped: 0, failed: 0 },
        ]);
      }),
    ));

  test("is empty without runs", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        expect(yield* store.analytics()).toEqual({
          all: { total: 0, queued: 0, started: 0, done: 0, skipped: 0, failed: 0 },
          byAuthor: [],
          bySource: [],
          byPrompt: [],
          usage: { runs: 0, measured: 0, totalCostUsd: null },
          byModel: [],
        });
      }),
    ));
});

describe("run history", () => {
  const preset = (version: number) => ({ owner: "preset" as const, id: "p1", version });
  const unmeasured = {
    measured: 0,
    totalCostUsd: null,
    avgCostUsd: null,
    avgInputTokens: null,
    avgOutputTokens: null,
    avgCacheCreationTokens: null,
    avgCacheReadTokens: null,
  };
  const opus = { modelInstanceId: "claudeAgent", modelId: "claude-opus-5-5" };
  const fable = { modelInstanceId: "claudeAgent", modelId: "claude-fable-5-1" };

  test("lists runs by prompt version, model and rating, and compares their ratings", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const p1 = yield* store.createPrompt({ name: "review", body: "x" });
        yield* store.createPromptVersion("preset", p1.id, { body: "x2", note: null, source: "ui" });
        const ref = (version: number) => ({ ...preset(version), id: p1.id });
        const edited = yield* store.createDispatchPrompt("x2, edited", "Review PR");
        const v1 = yield* store.recordRun(run({ status: "done", promptRefs: [ref(1)], ...opus }));
        const v2 = yield* store.recordRun(run({ status: "done", promptRefs: [ref(2)], ...opus }));
        const v2b = yield* store.recordRun(run({ status: "done", promptRefs: [ref(2), edited], ...fable }));
        yield* store.recordRun(run({ status: "skipped" }));

        expect(yield* store.rateRun(v1.id, { rating: 4, feedback: "missed the bug", followUpOf: null })).toMatchObject({ rating: 4, feedback: "missed the bug", followUpOf: null });
        yield* store.rateRun(v2.id, { rating: 9, feedback: "found it", followUpOf: null });
        yield* store.rateRun(v2b.id, { rating: null, feedback: "no score, just notes", followUpOf: null });
        expect(yield* store.rateRun("gone", { rating: 1, feedback: "x", followUpOf: null })).toBeNull();

        const ids = (runs: { id: string }[]) => runs.map((r) => r.id);
        expect(ids(yield* store.listRuns({ prompt: { owner: "preset", id: p1.id } }))).toEqual([v2b.id, v2.id, v1.id]);
        expect(ids(yield* store.listRuns({ prompt: { owner: "preset", id: p1.id, version: 2 } }))).toEqual([v2b.id, v2.id]);
        expect(ids(yield* store.listRuns({ model: "claude-fable-5-1" }))).toEqual([v2b.id]);
        expect(ids(yield* store.listRuns({ rated: true, limit: 2 }))).toEqual([v2b.id, v2.id]);
        expect(yield* store.listRuns({ rated: false })).toHaveLength(1);

        const { byPrompt, byModel } = yield* store.analytics();
        const counts = { queued: 0, started: 0, done: 2, skipped: 0, failed: 0, ...unmeasured };
        expect(byPrompt).toEqual([
          { ...edited, name: "Review PR", live: false, ...counts, total: 1, done: 1, rated: 0, avgRating: null, avgElapsedMs: null },
          { ...ref(2), name: "review", live: false, ...counts, total: 2, rated: 1, avgRating: 9, avgElapsedMs: null },
          { ...ref(1), name: "review", live: true, ...counts, total: 1, done: 1, rated: 1, avgRating: 4, avgElapsedMs: null },
        ]);
        expect(byModel).toEqual([
          { ...opus, ...counts, total: 2, rated: 2, avgRating: 6.5, avgElapsedMs: null },
          { ...fable, ...counts, total: 1, done: 1, rated: 0, avgRating: null, avgElapsedMs: null },
        ]);
      }),
    ));

  test("lists measured runs by cost, averages usage per prompt version, and finds runs left to measure", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const p1 = yield* store.createPrompt({ name: "review", body: "x" });
        const refs = [{ ...preset(1), id: p1.id }];
        const cheap = yield* store.recordRun(run({ status: "done", threadId: "t1", promptRefs: refs, ...opus }));
        const pricey = yield* store.recordRun(run({ status: "done", threadId: "t2", promptRefs: refs, ...opus }));
        const unmeasured = yield* store.recordRun(run({ status: "failed", threadId: "t3", promptRefs: refs, ...opus }));
        yield* store.recordRun(run({ status: "skipped" }));
        const usage = (costUsd: number, outputTokens: number): RunUsage => ({
          inputTokens: 10,
          outputTokens,
          cacheCreationTokens: 100,
          cacheReadTokens: 1000,
          totalTokens: 1110 + outputTokens,
          costUsd,
          models: ["claude-opus-5-5"],
          sessionIds: ["s1"],
          collectedAt: "2026-10-11T00:00:00.000Z",
        });
        yield* store.saveRunUsage(cheap.id, usage(0.5, 100));
        yield* store.saveRunUsage(pricey.id, usage(1, 200));
        yield* store.saveRunUsage(pricey.id, usage(1.5, 300)); // measured again: replaces

        expect((yield* store.listRuns({ sort: "cost" })).map((r) => r.id)).toEqual([pricey.id, cheap.id]);
        expect((yield* getRun(cheap.id)).usage).toMatchObject({ costUsd: 0.5, outputTokens: 100 });
        expect(yield* store.runsWithoutUsage("2026-01-01T00:00:00.000Z")).toEqual([{ id: unmeasured.id, threadId: "t3" }]);
        const analytics = yield* store.analytics();
        expect(analytics.byPrompt).toMatchObject([
          { total: 3, measured: 2, totalCostUsd: 2, avgCostUsd: 1, avgInputTokens: 10, avgOutputTokens: 200, avgCacheCreationTokens: 100, avgCacheReadTokens: 1000 },
        ]);
        expect(analytics.usage).toEqual({ runs: 3, measured: 2, totalCostUsd: 2 });
        expect(analytics.byAuthor).toMatchObject([{ author: "alice", total: 4, totalCostUsd: 2 }]);
      }),
    ));

  test("deleting a preset unlinks it from the actions of queued runs, which keep their own prompt", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const p1 = yield* store.createPrompt({ name: "review", body: "x" });
        const own = { owner: "preset" as const, id: p1.id, version: 1 };
        const action = { name: "review", skipSelfReview: true, projectId: null, workspace: "worktree" as const, model: null, presetId: p1.id, maxConcurrent: 1, promptRefs: [own] };
        const queued = yield* store.recordRun(run({ status: "queued", action }));
        expect(yield* store.getRunAction(queued.id)).toEqual(action);

        yield* store.deletePrompt(p1.id);
        expect(yield* store.getRunAction(queued.id)).toEqual({ ...action, presetId: null });
      }),
    ));

  test("deleting a settled run takes its prompt versions and action with it; queued and working runs stay", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const p1 = yield* store.createPrompt({ name: "review", body: "x" });
        const action = { name: "review", skipSelfReview: true, projectId: null, workspace: "worktree" as const, model: null, presetId: p1.id, maxConcurrent: 1, promptRefs: [{ ...preset(1), id: p1.id }] };
        const done = yield* store.recordRun(run({ status: "done", action }));
        const started = yield* store.recordRun(run({ status: "started" }));

        yield* deleteRun(done.id);
        expect(yield* store.getRun(done.id)).toBeNull();
        expect(yield* store.getRunAction(done.id)).toBeNull();
        expect((yield* store.runPromptRefs([done.id])).size).toBe(0);

        expect(yield* failureOf(deleteRun(started.id))).toBeInstanceOf(RunActiveError);
        expect(yield* store.getRun(started.id)).not.toBeNull();
        expect(yield* failureOf(deleteRun(done.id))).toBeInstanceOf(RunNotFoundError);
      }),
    ));

  test("a follow-up run links to the run it addresses, which must exist and not be itself", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const original = yield* store.recordRun(run({ status: "done" }));
        const fix = yield* store.recordRun(run({ status: "done" }));
        const rating = { rating: 8, feedback: "fixed it" };

        expect(yield* rateRun(fix.id, { ...rating, followUpOf: original.id })).toMatchObject({ followUpOf: original.id });
        expect(yield* failureOf(rateRun(fix.id, { ...rating, followUpOf: fix.id }))).toBeInstanceOf(InvalidFollowUpError);
        expect(yield* failureOf(rateRun(fix.id, { ...rating, followUpOf: "gone" }))).toBeInstanceOf(RunNotFoundError);
        expect((yield* getRun(fix.id)).followUpOf).toBe(original.id);

        yield* deleteRun(original.id);
        expect((yield* getRun(fix.id)).followUpOf).toBeNull();
      }),
    ));

  test("a run that ends records when it settled and how long its thread worked", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const started = yield* store.recordRun(run(opus));
        expect(started).toMatchObject({ startedAt: null, settledAt: null, elapsedMs: null });

        const startedAt = new Date(Date.now() - 90_000).toISOString();
        yield* store.updateRun(started.id, { threadId: "t", startedAt });
        yield* store.updateRun(started.id, { status: "done", result: "ok" });
        const done = (yield* store.getRun(started.id))!;
        expect(done.settledAt! >= startedAt).toBe(true);
        expect(done.elapsedMs).toBe(Date.parse(done.settledAt!) - Date.parse(startedAt));
        expect((yield* store.analytics()).byModel[0]?.avgElapsedMs).toBe(done.elapsedMs);

        // Skipped before a thread opened: settled, no elapsed time.
        const skipped = yield* store.recordRun(run({ status: "skipped" }));
        expect(skipped.settledAt).not.toBeNull();
        expect(skipped.elapsedMs).toBeNull();
      }),
    ));
});

describe("Store.pullRequests", () => {
  const pr = (number: string, patch: Partial<Run> = {}) => run({ context: { pr_number: number, pr_title: `PR ${number}` }, ...patch });

  test("groups runs per PR with verdict counts and a derived status", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.recordRun(pr("1", { status: "done", result: "**CHANGES_REQUESTED**" }));
        yield* store.recordRun(pr("1", { status: "done", result: "Verdict: approve" }));
        yield* store.recordRun(pr("1", { status: "skipped" }));
        yield* store.recordRun(pr("2", { status: "done", result: "**CHANGES_REQUESTED**" }));
        yield* store.recordRun(pr("2", { status: "started" }));
        yield* store.recordRun(pr("3", { status: "failed" }));
        yield* store.recordRun(run({ ruleId: "manual", source: "manual", author: null }));

        const byNumber = Object.fromEntries((yield* store.pullRequests()).map((summary) => [summary.number, summary]));
        expect(Object.keys(byNumber).sort()).toEqual(["1", "2", "3"]);
        expect(byNumber["1"]).toMatchObject({ title: "PR 1", status: "approved", reviews: 2, approved: 1, changesRequested: 1, skipped: 1, failed: 0 });
        expect(byNumber["2"]).toMatchObject({ status: "reviewing", reviews: 1, changesRequested: 1 });
        expect(byNumber["3"]).toMatchObject({ status: "failed", reviews: 0, failed: 1 });
      }),
    ));

  test("is paused once the change-request streak hits the limit, and handoffs are not reviews", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        for (let i = 0; i < 3; i++) yield* store.recordRun(pr("7", { status: "done", result: "changes requested" }));
        yield* store.recordRun(pr("7", { ruleId: "handoff", event: HANDOFF_EVENT, status: "done", result: "handoff doc" }));

        expect(yield* store.pullRequests()).toEqual([expect.objectContaining({ number: "7", status: "paused", reviews: 3, changesRequested: 3 })]);
      }),
    ));
});

describe("Store inbox", () => {
  const t0 = "2026-10-02T10:00:00.000Z";
  const t1 = "2026-10-02T10:03:00.000Z";
  const t2 = "2026-10-04T10:06:00.000Z";
  const other = { ...pr, key: "github:acme/widgets#43", identifier: "#43", url: "https://github.com/acme/widgets/pull/43", updatedAt: "2026-01-03T00:00:00Z" };
  // Newer activity than the PR, so the active order is deterministic.
  const issue = { ...linear, updatedAt: "2026-01-05T00:00:00Z" };

  test("sync keeps first-seen across polls, marks missing items gone per source, and restarts a returning item's stay", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        expect(yield* store.syncInbox("github", [pr, other], t0)).toEqual({ appeared: 2, returned: 0, gone: 0 });
        expect(yield* store.syncInbox("linear", [issue], t0)).toEqual({ appeared: 1, returned: 0, gone: 0 });

        // #43 drops out of GitHub's results; the Linear issue is another source and is untouched.
        expect(yield* store.syncInbox("github", [{ ...pr, title: "Add widgets (renamed)" }], t1)).toEqual({ appeared: 0, returned: 0, gone: 1 });
        expect(yield* store.getInboxItem(pr.key)).toMatchObject({ title: "Add widgets (renamed)", firstSeenAt: t0, lastSeenAt: t1, goneAt: null });
        expect(yield* store.getInboxItem(other.key)).toMatchObject({ firstSeenAt: t0, lastSeenAt: t0, goneAt: t1 });
        expect(yield* store.getInboxItem(linear.key)).toMatchObject({ goneAt: null });
        expect((yield* store.listInbox()).map((item) => item.key)).toEqual([linear.key, pr.key]);

        // #43 comes back: a new stay.
        expect(yield* store.syncInbox("github", [pr, other], t2)).toEqual({ appeared: 0, returned: 1, gone: 0 });
        expect(yield* store.getInboxItem(other.key)).toMatchObject({ firstSeenAt: t2, lastSeenAt: t2, goneAt: null });

        // An empty poll empties the source.
        expect(yield* store.syncInbox("github", [], t2)).toEqual({ appeared: 0, returned: 0, gone: 2 });
        expect((yield* store.listInbox()).map((item) => item.key)).toEqual([linear.key]);
      }),
    ));

  test("gone items list after active ones, newest departure first, and are pruned after the retention window", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        for (const item of [pr, other]) yield* store.recordRun(run({ context: { pr_url: item.url } }));
        yield* store.syncInbox("github", [pr, other], t0);
        yield* store.syncInbox("github", [pr], t1);
        yield* store.syncInbox("github", [], t2);
        expect((yield* store.listInbox({ gone: true })).map((item) => [item.key, item.goneAt])).toEqual([
          [pr.key, t2],
          [other.key, t1],
        ]);
        // Retention is 30 days from departure: #43 left at t1, #42 two days later at t2.
        expect(yield* store.pruneInbox(Date.parse(t1) + 29 * 86_400_000)).toBe(0);
        expect(yield* store.pruneInbox(Date.parse(t1) + 31 * 86_400_000)).toBe(1);
        expect((yield* store.listInbox({ gone: true })).map((item) => item.key)).toEqual([pr.key]);
      }),
    ));

  test("only departed items something ran on are listed and counted; the rest stay stored for their return", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        // #42 got a review from a rule, the Linear issue a dispatch by hand; #43 never ran.
        yield* store.recordRun(run({ source: "poll", context: { pr_url: pr.url } }));
        yield* store.recordRun(run({ source: "manual", context: { issue_url: issue.url } }));
        yield* store.syncInbox("github", [pr, other], t0);
        yield* store.syncInbox("linear", [issue], t0);
        yield* store.syncInbox("github", [], t1);
        yield* store.syncInbox("linear", [], t1);

        expect((yield* store.listInbox({ gone: true })).map((item) => item.key).toSorted()).toEqual([pr.key, linear.key]);
        expect(yield* store.countGoneInbox()).toBe(2);
        expect(yield* store.getInboxItem(other.key)).toMatchObject({ goneAt: t1 });
        expect(yield* store.syncInbox("github", [other], t2)).toEqual({ appeared: 0, returned: 1, gone: 0 });
      }),
    ));
});

describe("Store prompt versions", () => {
  const { id, livePromptVersion, createdAt, updatedAt, ...input } = rule;

  test("saving appends a draft; promoting makes it the text runs use, and rolls back to older versions", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const created = yield* store.createRule({ ...input, prompt: "v1" });
        const draft = { note: null, source: "ui" as const };

        const v2 = yield* store.createPromptVersion("rule", created.id, { ...draft, body: "v2" });
        expect(v2?.version).toBe(2);
        expect(yield* store.getRule(created.id)).toMatchObject({ prompt: "v1", livePromptVersion: 1 });

        // The same body again saves nothing new.
        expect((yield* store.createPromptVersion("rule", created.id, { ...draft, body: "v2" }))?.version).toBe(2);

        yield* store.promotePromptVersion("rule", created.id, 2);
        expect(yield* store.getRule(created.id)).toMatchObject({ prompt: "v2", livePromptVersion: 2 });
        yield* store.promotePromptVersion("rule", created.id, 1);
        expect(yield* store.getRule(created.id)).toMatchObject({ prompt: "v1", livePromptVersion: 1 });

        yield* store.createPromptVersion("rule", created.id, { ...draft, body: "v3" }, true);
        expect(yield* store.getRule(created.id)).toMatchObject({ prompt: "v3", livePromptVersion: 3 });
        expect((yield* store.listPromptVersions("rule", created.id)).map((v) => v.version)).toEqual([3, 2, 1]);
      }),
    ));

  test("a missing owner or version is null, and versions outlive their owner", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const preset = yield* store.createPrompt({ name: "review", body: "v1" });
        expect(yield* store.promotePromptVersion("preset", preset.id, 2)).toBeNull();
        expect(yield* store.createPromptVersion("rule", preset.id, { body: "x", note: null, source: "mcp" })).toBeNull();

        // Runs reference versions, so deleting the preset keeps them.
        yield* store.deletePrompt(preset.id);
        expect(yield* store.listPromptVersions("preset", preset.id)).toHaveLength(1);
      }),
    ));
});
