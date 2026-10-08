import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { dispatchPrompt, runRules } from "./handler.ts";
import { itemContext, itemEvent, type InboxLabel } from "./inbox.ts";
import { linear, pr, rule } from "./inbox.test.ts";
import { InboxSourceError, type InboxSourceClient } from "./inboxSource.ts";
import { Poller } from "./poller.ts";
import { EMPTY_FILTERS } from "./shared.ts";
import { Store } from "./store.ts";
import type { T3Project } from "./t3.ts";
import { fakeT3, runWith, settle, testLayer } from "./testing.ts";

const project: T3Project = { id: "p1", title: "widgets", workspaceRoot: "/w", deletedAt: null, defaultModelSelection: null, repositoryIdentity: { canonicalKey: "github.com/acme/widgets", provider: "github", owner: "acme", name: "widgets" } };

const failed = (message: string) => Effect.fail(new InboxSourceError({ source: "github", message }));

/** A T3 that accepts every thread, and a poller over the given GitHub source (fixed items by default). */
function setup(github: Partial<InboxSourceClient> = {}) {
  const started: string[] = [];
  const t3 = fakeT3({
    projects: () => Effect.succeed([project]),
    startThread: (input) => Effect.sync(() => (started.push(input.title), { threadId: `t${started.length}`, threadUrl: `http://t3/t${started.length}` })),
  });
  const base = testLayer({ t3 });
  const source: InboxSourceClient = { fetch: () => Effect.succeed({ login: "me", items: [pr, linear] }), labels: () => Effect.succeed([]), ...github };
  const layer = Poller.layerWith({ github: source, linear: null, sentry: null }).pipe(Layer.provideMerge(base));
  return { layer, started };
}

const { id: _id, createdAt: _c, updatedAt: _u, ...input } = rule;

describe("Poller", () => {
  test("a poll keeps the items and starts rules on activity newer than the rule, once per head", async () => {
    const { layer, started } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const poller = yield* Poller;
        const saved = yield* store.createRule({ ...input, projectId: "p1" });
        // The fixture PR's last activity predates the rule, so the poll keeps it but fires nothing.
        const status = yield* poller.poll("github");
        expect(status).toMatchObject({ login: "me", items: 2, lastError: null, polling: false });
        expect((yield* poller.list()).map((item) => item.key)).toEqual(["github:acme/widgets#42", "linear:ENG-7"]);
        expect(yield* store.listRuns()).toHaveLength(0);

        // "Run now" backfills regardless.
        const backfilled = yield* poller.runAutomations(yield* poller.list(), { armed: false, ruleId: saved.id });
        expect(backfilled.map((run) => [run.status, run.deliveryId, run.source])).toEqual([["started", "github:acme/widgets#42@abc123def456", "poll"]]);
        yield* settle;
        expect(started).toEqual(["review: Add widgets"]);
        expect(yield* store.getRun(backfilled[0]!.id)).toMatchObject({ status: "started", threadUrl: "http://t3/t1" });
        expect(yield* poller.runAutomations(yield* poller.list(), { armed: false })).toEqual([]);

        // A push after the rule was saved: new head, new delivery, fires on its own (and is skipped: the first review still runs).
        const pushed = { ...pr, headSha: "fedcba987654321", updatedAt: new Date(Date.now() + 60_000).toISOString() };
        expect((yield* poller.runAutomations([pushed])).map((run) => [run.status, run.deliveryId])).toEqual([["skipped", "github:acme/widgets#42@fedcba987654"]]);
      }),
    );
  });

  test("an issue fires a rule again each time it re-enters the rule's filters", async () => {
    const { layer, started } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const poller = yield* Poller;
        const issueRule = { ...input, events: ["inbox.linear.issue"], filters: { ...EMPTY_FILTERS, labels: "ready for dev" }, projectId: "p1", workspace: "local" as const };
        const implement = yield* store.createRule({ ...issueRule, name: "implement" });
        // A disabled rule that once ran for the issue never re-arms.
        const off = yield* store.createRule({ ...issueRule, name: "off", enabled: false });
        yield* store.recordRun({ ruleId: off.id, ruleName: "off", deliveryId: linear.key, event: itemEvent(linear), repo: "", source: "poll", author: null, status: "done", detail: "", threadId: null, threadUrl: null, context: itemContext(linear), result: null });
        const later = new Date(Date.now() + 60_000).toISOString();
        const ready = { ...linear, updatedAt: later };
        const regroom = { ...ready, labels: ["needs grooming"] };
        const poll = (item: typeof linear) => Effect.map(poller.runAutomations([item]), (runs) => runs.map((run) => run.deliveryId));

        expect(yield* poll(ready)).toEqual(["linear:ENG-7"]);
        yield* settle;
        yield* store.updateRun((yield* store.listRuns({ ruleId: implement.id }))[0]!.id, { status: "done" });
        // Still matching: nothing new.
        expect(yield* poll(ready)).toEqual([]);

        // Sent back to grooming: the rule's next generation starts, once.
        expect(yield* poll(regroom)).toEqual([]);
        expect(yield* poll(regroom)).toEqual([]);
        expect(yield* store.itemGenerations(linear.key)).toEqual(new Map([[implement.id, 1]]));

        // Ready again: fires in the new generation.
        expect(yield* poll(ready)).toEqual(["linear:ENG-7#1"]);
        yield* settle;
        expect(started).toEqual(["implement: Rate limit the API", "implement: Rate limit the API"]);
      }),
    );
  });

  test("an issue busy with another thread is left for the next poll instead of using the rule up", async () => {
    const { layer, started } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const poller = yield* Poller;
        yield* store.createRule({ ...input, name: "implement", events: ["inbox.linear.issue"], projectId: "p1", workspace: "local" });
        const grooming = yield* store.recordRun({ ruleId: "groom", ruleName: "groom", deliveryId: linear.key, event: itemEvent(linear), repo: "", source: "poll", author: null, status: "started", detail: "", threadId: "t0", threadUrl: "http://t3/t0", context: itemContext(linear), result: null });
        const ready = { ...linear, updatedAt: new Date(Date.now() + 60_000).toISOString() };

        expect(yield* poller.runAutomations([ready])).toEqual([]);
        expect((yield* store.listRuns()).map((run) => run.ruleName)).toEqual(["groom"]);

        // The grooming thread settles: the next poll fires.
        yield* store.updateRun(grooming.id, { status: "done" });
        expect((yield* poller.runAutomations([ready])).map((run) => [run.status, run.deliveryId])).toEqual([["started", "linear:ENG-7"]]);
        yield* settle;
        expect(started).toEqual(["implement: Rate limit the API"]);
      }),
    );
  });

  test("a failing source keeps the previous items and records the error", async () => {
    let fail = false;
    const { layer } = setup({ fetch: () => (fail ? failed("gh: not logged in") : Effect.succeed({ login: "me", items: [pr] })) });
    await runWith(
      layer,
      Effect.gen(function* () {
        const poller = yield* Poller;
        yield* poller.poll("github");
        fail = true;
        const status = yield* poller.poll("github");
        expect(status.lastError).toBe("gh: not logged in");
        // A failed poll marks nothing gone: the last good inbox stays.
        expect((yield* poller.list()).map((item) => [item.key, item.goneAt])).toEqual([["github:acme/widgets#42", null]]);
        expect((yield* poller.statuses).linear).toMatchObject({ configured: false, nextAt: null });
      }),
    );
  });

  test("an item the store rejects fails the poll visibly instead of stopping the source", async () => {
    // A source returning an item with a missing timestamp, as Sentry did with collapse=stats: the insert throws.
    const { layer } = setup({ fetch: () => Effect.succeed({ login: "me", items: [{ ...pr, createdAt: null as unknown as string }] }) });
    await runWith(
      layer,
      Effect.gen(function* () {
        const poller = yield* Poller;
        const status = yield* poller.poll("github");
        expect(status).toMatchObject({ polling: false, items: 0 });
        expect(status.lastError).toContain("NOT NULL constraint failed: inbox_items.created_at");
        expect(status.lastPolledAt).not.toBeNull();
      }),
    );
  });

  test("labels sync for the repos of inbox items and rules, again only when those change or fail", async () => {
    const asked: string[][] = [];
    let fail = false;
    const labels = (repos: string[]) =>
      Effect.suspend(() => {
        asked.push(repos);
        return fail ? failed("gh: rate limited") : Effect.succeed(repos.map((repo): InboxLabel => ({ name: "ready", scope: repo })));
      });
    const { layer } = setup({ fetch: () => Effect.succeed({ login: "me", items: [pr] }), labels });
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const poller = yield* Poller;
        yield* poller.poll("github");
        yield* settle;
        expect(asked).toEqual([["acme/widgets"]]);
        expect(yield* poller.labelCatalog).toEqual({ github: [{ name: "ready", scope: "acme/widgets" }], linear: [], sentry: [] });

        // Fresh and covering the same repos: no new sync.
        yield* poller.syncLabels("github");
        expect(asked).toHaveLength(1);

        // A rule naming another repo widens the sync; a failure keeps the last labels.
        yield* store.createRule({ ...input, repos: ["Acme/Gadgets", "not a repo"] });
        fail = true;
        yield* poller.syncLabels("github");
        expect(asked[1]).toEqual(["acme/gadgets", "acme/widgets"]);
        expect((yield* poller.labelCatalog).github).toHaveLength(1);
      }),
    );
  });
});

describe("dispatchPrompt", () => {
  test("is the stacked presets' versions until the text is edited, then a one-off version of the text", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const a = yield* store.createPrompt({ name: "a", body: "A {{pr_url}}" });
        const b = yield* store.createPrompt({ name: "b", body: "B" });
        const stacked = [{ id: a.id, version: 1 }, { id: b.id, version: 1 }];
        expect(yield* dispatchPrompt(stacked, "A {{pr_url}}\n\nB", "a + b")).toEqual([
          { owner: "preset", id: a.id, version: 1 },
          { owner: "preset", id: b.id, version: 1 },
        ]);

        const [edited] = yield* dispatchPrompt(stacked, "A {{pr_url}}\n\nB, but shorter", "a + b");
        expect(edited).toMatchObject({ owner: "dispatch", version: 1 });
        expect(yield* store.promptBodies([edited!])).toEqual(["A {{pr_url}}\n\nB, but shorter"]);
      }),
    ));
});

describe("runRules for a dispatch", () => {
  test("one thread per item at a time; a forced dispatch ignores the pause", async () => {
    const { layer, started } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveSettings({ ...(yield* store.getSettings()), maxChangesRequestedRounds: 1 });
        const ctx = itemContext(pr);
        yield* store.recordRun({ ruleId: "x", ruleName: "review", deliveryId: "d0", event: "pull_request.opened", repo: "acme/widgets", source: "github", author: "alice", status: "done", detail: "", threadId: "t0", threadUrl: "u0", context: ctx, result: "CHANGES_REQUESTED", action: null });
        const dispatch = { ...rule, id: "dispatch", name: "Review PR", projectId: "p1", skipSelfReview: false };
        const refs = [yield* store.createDispatchPrompt(rule.prompt, "Review PR")];

        const [paused] = yield* runRules({ deliveryId: "d1", event: itemEvent(pr), ctx, source: "manual" }, [dispatch], refs);
        expect(paused).toMatchObject({ status: "skipped", source: "manual" });
        expect(paused!.detail).toContain("paused");

        const [forced] = yield* runRules({ deliveryId: "d2", event: itemEvent(pr), ctx, source: "manual", force: true }, [dispatch], refs);
        expect(forced).toMatchObject({ status: "started", ruleName: "Review PR" });
        expect(forced!.context?.previous_result).toBe("CHANGES_REQUESTED");

        const [again] = yield* runRules({ deliveryId: "d3", event: itemEvent(pr), ctx, source: "manual", force: true }, [dispatch], refs);
        expect(again).toMatchObject({ status: "skipped" });
        expect(again!.detail).toContain("already running for acme/widgets#42");

        // Issues lock on their URL the same way.
        const issueCtx = itemContext(linear);
        const [first] = yield* runRules({ deliveryId: "d4", event: itemEvent(linear), ctx: issueCtx, source: "manual" }, [dispatch], refs);
        const [second] = yield* runRules({ deliveryId: "d5", event: itemEvent(linear), ctx: issueCtx, source: "manual" }, [dispatch], refs);
        expect(first!.status).toBe("started");
        expect(second!.detail).toContain("already running for https://linear.app/acme/issue/ENG-7");
        yield* settle;
        expect(started).toEqual(["Review PR: Add widgets", "Review PR: Rate limit the API"]);
      }),
    );
  });
});
