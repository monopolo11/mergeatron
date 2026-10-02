import { describe, expect, test } from "bun:test";
import { openDatabase } from "./db/index.ts";
import { runRules } from "./handler.ts";
import { itemContext, itemEvent } from "./inbox.ts";
import { linear, pr, rule } from "./inbox.test.ts";
import { Poller } from "./poller.ts";
import { Store } from "./store.ts";
import type { T3Client, T3Project } from "./t3.ts";

const project: T3Project = { id: "p1", title: "widgets", workspaceRoot: "/w", deletedAt: null, defaultModelSelection: null, repositoryIdentity: { canonicalKey: "github.com/acme/widgets", provider: "github", owner: "acme", name: "widgets" } };

/** A T3 that accepts every thread, and a poller whose sources return fixed items. */
function setup(items = [pr, linear]) {
  const store = new Store(openDatabase(":memory:"));
  const started: string[] = [];
  const t3 = {
    projects: async () => [project],
    startThread: async (input: { title: string }) => (started.push(input.title), { threadId: `t${started.length}`, threadUrl: `http://t3/t${started.length}` }),
  } as unknown as T3Client;
  const deps = { store, t3, slack: null };
  const poller = new Poller(deps, { github: { fetch: async () => ({ login: "me", items }) }, linear: null });
  return { store, deps, poller, started };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("Poller", () => {
  test("a poll keeps the items and starts rules on activity newer than the rule, once per head", async () => {
    const { store, poller, started } = setup();
    const { id, createdAt, updatedAt, ...input } = rule;
    const saved = store.createRule({ ...input, projectId: "p1" });
    // The fixture PR's last activity predates the rule, so the poll keeps it but fires nothing.
    const status = await poller.poll("github");
    expect(status).toMatchObject({ login: "me", items: 2, lastError: null, polling: false });
    expect(poller.list().map((item) => item.key)).toEqual(["github:acme/widgets#42", "linear:ENG-7"]);
    expect(store.listRuns()).toHaveLength(0);

    // "Run now" backfills regardless.
    const backfilled = poller.runAutomations(poller.list(), { armed: false, ruleId: saved.id });
    expect(backfilled.map((run) => [run.status, run.deliveryId, run.source])).toEqual([["started", "github:acme/widgets#42@abc123def456", "poll"]]);
    await settle();
    expect(started).toEqual(["review: Add widgets"]);
    expect(store.getRun(backfilled[0]!.id)).toMatchObject({ status: "started", threadUrl: "http://t3/t1" });
    expect(poller.runAutomations(poller.list(), { armed: false })).toEqual([]);

    // A push after the rule was saved: new head, new delivery, fires on its own (and is skipped: the first review still runs).
    const pushed = { ...pr, headSha: "fedcba987654321", updatedAt: new Date(Date.now() + 60_000).toISOString() };
    expect(poller.runAutomations([pushed]).map((run) => [run.status, run.deliveryId])).toEqual([["skipped", "github:acme/widgets#42@fedcba987654"]]);
  });

  test("a failing source keeps the previous items and records the error", async () => {
    const { deps } = setup();
    let fail = false;
    const poller = new Poller(deps, { github: { fetch: async () => { if (fail) throw new Error("gh: not logged in"); return { login: "me", items: [pr] }; } }, linear: null });
    await poller.poll("github");
    fail = true;
    const status = await poller.poll("github");
    expect(status.lastError).toBe("gh: not logged in");
    // A failed poll marks nothing gone: the last good inbox stays.
    expect(poller.list().map((item) => [item.key, item.goneAt])).toEqual([["github:acme/widgets#42", null]]);
    expect(poller.statuses().linear).toMatchObject({ configured: false, nextAt: null });
  });
});

describe("runRules for a dispatch", () => {
  test("one thread per item at a time; a forced dispatch ignores the pause", async () => {
    const { store, deps, started } = setup();
    store.saveSettings({ ...store.getSettings(), maxChangesRequestedRounds: 1 });
    const ctx = itemContext(pr);
    store.recordRun({ ruleId: "x", ruleName: "review", deliveryId: "d0", event: "pull_request.opened", repo: "acme/widgets", source: "github", author: "alice", status: "done", detail: "", threadId: "t0", threadUrl: "u0", context: ctx, result: "CHANGES_REQUESTED", action: null });
    const dispatch = { ...rule, id: "dispatch", name: "Review PR", projectId: "p1", skipSelfReview: false };

    const [paused] = runRules(deps, { deliveryId: "d1", event: itemEvent(pr), ctx, source: "manual" }, [dispatch]);
    expect(paused).toMatchObject({ status: "skipped", source: "manual" });
    expect(paused!.detail).toContain("paused");

    const [forced] = runRules(deps, { deliveryId: "d2", event: itemEvent(pr), ctx, source: "manual", force: true }, [dispatch]);
    expect(forced).toMatchObject({ status: "started", ruleName: "Review PR" });
    expect(forced!.context?.previous_result).toBe("CHANGES_REQUESTED");

    const [again] = runRules(deps, { deliveryId: "d3", event: itemEvent(pr), ctx, source: "manual", force: true }, [dispatch]);
    expect(again).toMatchObject({ status: "skipped" });
    expect(again!.detail).toContain("already running for acme/widgets#42");

    // Issues lock on their URL the same way.
    const issueCtx = itemContext(linear);
    const [first] = runRules(deps, { deliveryId: "d4", event: itemEvent(linear), ctx: issueCtx, source: "manual" }, [dispatch]);
    const [second] = runRules(deps, { deliveryId: "d5", event: itemEvent(linear), ctx: issueCtx, source: "manual" }, [dispatch]);
    expect(first!.status).toBe("started");
    expect(second!.detail).toContain("already running for https://linear.app/acme/issue/ENG-7");
    await settle();
    expect(started).toEqual(["Review PR: Add widgets", "Review PR: Rate limit the API"]);
  });
});
