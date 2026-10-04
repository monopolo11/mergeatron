import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { handleDelivery, hostsRepository, matchRules, resolveProject, ruleMismatch } from "./handler.ts";
import { DEFAULT_SETTINGS, type Rule } from "./rules.ts";
import { EMPTY_FILTERS, HANDOFF_EVENT } from "./shared.ts";
import { getRun } from "./runHistory.ts";
import { Store } from "./store.ts";
import type { StartThreadInput, T3Project } from "./t3.ts";
import { fakeSlack, fakeT3, runWith, settle, testLayer } from "./testing.ts";

const base: Rule = {
  id: "r1",
  name: "review",
  enabled: true,
  events: ["pull_request.review_requested"],
  repos: [],
  reviewer: null,
  channel: null,
  allowBots: false,
  skipSelfReview: true,
  filters: EMPTY_FILTERS, maxConcurrent: 0,
  projectId: null,
  workspace: "worktree",
  model: null,
  prompt: "x",
  livePromptVersion: 1,
  presetId: null,
  createdAt: "",
  updatedAt: "",
};

const ctx = { repo: "Acme/Widgets", requested_reviewer: "bernardo" };

describe("matchRules", () => {
  test("matches any of the rule's event keys and respects enabled", () => {
    expect(matchRules([base], "pull_request.review_requested", ctx)).toHaveLength(1);
    expect(matchRules([base], "pull_request.opened", ctx)).toHaveLength(0);
    const both = { ...base, events: ["pull_request.review_requested", "slack.message"] };
    expect(matchRules([both], "slack.message", { repo: "acme/widgets" })).toHaveLength(1);
    expect(matchRules([{ ...base, enabled: false }], "pull_request.review_requested", ctx)).toHaveLength(0);
  });

  test("repository filter is case-insensitive and empty means any", () => {
    expect(matchRules([{ ...base, repos: ["acme/widgets"] }], base.events[0]!, ctx)).toHaveLength(1);
    expect(matchRules([{ ...base, repos: ["acme/other"] }], base.events[0]!, ctx)).toHaveLength(0);
  });

  test("channel filter compares against the Slack channel", () => {
    const slack = { ...base, events: ["slack.app_mention"], channel: "C123" };
    expect(matchRules([slack], "slack.app_mention", { repo: "", slack_channel: "C123" })).toHaveLength(1);
    expect(matchRules([slack], "slack.app_mention", { repo: "", slack_channel: "C999" })).toHaveLength(0);
    expect(matchRules([{ ...slack, channel: null }], "slack.app_mention", { repo: "", slack_channel: "C999" })).toHaveLength(1);
  });

  test("bot posts only match rules that accept bots", () => {
    const slack = { ...base, events: ["slack.message"] };
    const bot = { repo: "acme/widgets", slack_bot_id: "B2" };
    expect(ruleMismatch(slack, "slack.message", bot)).toBe("posted by a bot; rule does not accept bots");
    expect(ruleMismatch({ ...slack, allowBots: true }, "slack.message", bot)).toBeNull();
  });

  test("reviewer filter compares against the requested reviewer", () => {
    expect(matchRules([{ ...base, reviewer: "Bernardo" }], base.events[0]!, ctx)).toHaveLength(1);
    expect(matchRules([{ ...base, reviewer: "someone" }], base.events[0]!, ctx)).toHaveLength(0);
    expect(matchRules([{ ...base, reviewer: "bernardo" }], base.events[0]!, { repo: "acme/widgets" })).toHaveLength(0);
  });

  test("ruleMismatch names the first filter that failed", () => {
    expect(ruleMismatch(base, "pull_request.opened", ctx)).toBe("listens to pull_request.review_requested");
    expect(ruleMismatch({ ...base, repos: ["acme/other"] }, base.events[0]!, ctx)).toBe("repo Acme/Widgets not in acme/other");
    expect(ruleMismatch({ ...base, reviewer: "someone" }, base.events[0]!, ctx)).toBe("requested reviewer bernardo is not someone");
    expect(ruleMismatch(base, base.events[0]!, ctx)).toBeNull();
  });
});

describe("resolveProject", () => {
  const projects: T3Project[] = [
    { id: "p1", title: "widgets", workspaceRoot: "/w", deletedAt: null, defaultModelSelection: null, repositoryIdentity: { canonicalKey: "github.com/acme/widgets", provider: "github", owner: "acme", name: "widgets" } },
    { id: "p2", title: "no-remote", workspaceRoot: "/n", deletedAt: null, defaultModelSelection: null, repositoryIdentity: null },
  ];

  test("prefers the explicit project id", () => {
    expect(resolveProject({ ...base, projectId: "p2" }, projects, "acme/widgets")?.id).toBe("p2");
    expect(resolveProject({ ...base, projectId: "gone" }, projects, "acme/widgets")).toBeNull();
  });

  test("falls back to the project whose remote matches the repository", () => {
    expect(resolveProject(base, projects, "ACME/widgets")?.id).toBe("p1");
    expect(resolveProject(base, projects, "acme/other")).toBeNull();
  });

  test("hostsRepository requires a GitHub identity with matching owner/name", () => {
    expect(hostsRepository(projects[0]!, "acme/widgets")).toBe(true);
    expect(hostsRepository(projects[1]!, "acme/widgets")).toBe(false);
    expect(hostsRepository({ ...projects[0]!, repositoryIdentity: { canonicalKey: "x", owner: "acme", name: "widgets" } }, "acme/widgets")).toBe(false);
  });
});

describe("handleDelivery", () => {
  test("a rule linked to a preset starts threads with the preset's live version, recorded on the run; deleting the preset restores the rule's own text", () => {
    const started: StartThreadInput[] = [];
    const project: T3Project = { id: "p1", title: "widgets", workspaceRoot: "/w", deletedAt: null, defaultModelSelection: null };
    const t3 = fakeT3({
      projects: () => Effect.succeed([project]),
      startThread: (input) => Effect.sync(() => (started.push(input), { threadId: "t", threadUrl: "http://t3/t" })),
      thread: () => Effect.never,
    });
    return runWith(
      testLayer({ t3 }),
      Effect.gen(function* () {
        const store = yield* Store;
        const preset = yield* store.createPrompt({ name: "review", body: "preset v1 {{pr_url}}" });
        const rule = yield* store.createRule({ ...base, projectId: "p1", prompt: "own {{pr_url}}", presetId: preset.id });
        const lastRun = Effect.map(store.listRuns({ limit: 1 }), ([run]) => run!);
        const lastRefs = Effect.flatMap(lastRun, (run) => Effect.map(store.runPromptRefs([run.id]), (refs) => refs.get(run.id)));
        const deliver = (n: number) =>
          Effect.andThen(
            handleDelivery({ deliveryId: `d${n}`, event: "pull_request.review_requested", ctx: { repo: "acme/widgets", pr_number: `${n}`, pr_url: `https://github.com/acme/widgets/pull/${n}`, requested_reviewer: "bernardo" } }),
            settle,
          );

        // A saved but unpromoted version is a draft: runs keep the live one.
        yield* store.createPromptVersion("preset", preset.id, { body: "preset v2 {{pr_url}}", note: null, source: "ui" });
        yield* deliver(1);
        expect(started.at(-1)?.prompt).toBe("preset v1 https://github.com/acme/widgets/pull/1");
        // The message is not stored: it renders again from the version and the run's context.
        expect((yield* getRun((yield* lastRun).id)).prompt).toBe("preset v1 https://github.com/acme/widgets/pull/1");
        expect(yield* lastRun).toMatchObject({
          modelInstanceId: DEFAULT_SETTINGS.model.instanceId,
          modelId: DEFAULT_SETTINGS.model.model,
          startedAt: expect.any(String),
          settledAt: null,
        });
        expect(yield* lastRefs).toEqual([{ owner: "preset", id: preset.id, version: 1 }]);

        yield* store.promotePromptVersion("preset", preset.id, 2);
        yield* deliver(2);
        expect(started.at(-1)?.prompt).toBe("preset v2 https://github.com/acme/widgets/pull/2");
        expect(yield* lastRefs).toEqual([{ owner: "preset", id: preset.id, version: 2 }]);

        yield* store.deletePrompt(preset.id);
        expect((yield* store.listRules())[0]?.presetId).toBeNull();
        yield* deliver(3);
        expect(started.at(-1)?.prompt).toBe("own https://github.com/acme/widgets/pull/3");
        expect(yield* lastRefs).toEqual([{ owner: "rule", id: rule.id, version: 1 }]);
      }),
    );
  });

  // The default fake T3 fails every call with "unexpected": these deliveries must be decided before T3 is reached.

  test("a Slack message that matches no rule gets a skipped reaction and no run", async () => {
    const reactions: string[] = [];
    const slack = fakeSlack({ react: (_, name) => Effect.sync(() => void reactions.push(name)) });
    await runWith(
      testLayer({ slack }),
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createRule({ ...base, events: ["slack.message"], channel: "C-other" });
        const ctx = { repo: "acme/widgets", pr_number: "1", pr_url: "https://github.com/acme/widgets/pull/1", slack_channel: "C1", slack_ts: "1.0" };
        yield* handleDelivery({ deliveryId: "d0", event: "slack.message", ctx });
        expect(reactions).toEqual(["fast_forward"]);
        expect(yield* store.listRuns()).toHaveLength(0);
      }),
    );
  });

  test("one review per PR at a time: a second delivery is skipped and points at the running thread", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const rule = yield* store.createRule({ ...base, repos: [], events: ["slack.message"] });
        const ctx = { repo: "acme/widgets", pr_number: "42", pr_url: "https://github.com/acme/widgets/pull/42" };
        yield* store.recordRun({
          ruleId: "other-rule", ruleName: "github review", deliveryId: "d1", event: "pull_request.review_requested", repo: "Acme/Widgets",
          source: "github", author: "alice", status: "started", detail: "", threadId: "t1", threadUrl: "http://t3/t1", context: ctx, result: null,
        });

        const result = yield* handleDelivery({ deliveryId: "d2", event: "slack.message", ctx });
        expect(result.matched).toEqual([]);
        const skipped = (yield* store.listRuns()).find((run) => run.deliveryId === "d2");
        expect(skipped).toMatchObject({ ruleId: rule.id, status: "skipped", threadUrl: "http://t3/t1" });
        expect(skipped?.detail).toContain("already running for acme/widgets#42");

        // Once the first review settles, the PR is free again and its reply feeds the next review's prompt.
        const first = (yield* store.listRuns()).find((run) => run.deliveryId === "d1")!;
        yield* store.updateRun(first.id, { status: "done", result: "first pass findings" });
        expect(yield* store.activeRunForPullRequest("acme/widgets", "42")).toBeNull();
        const again = yield* handleDelivery({ deliveryId: "d3", event: "slack.message", ctx: { ...ctx } });
        expect(again.matched).toEqual([rule.name]);
        const run = (yield* store.listRuns()).find((r) => r.deliveryId === "d3");
        expect(run?.context).toMatchObject({ previous_result: "first pass findings", previous_thread_url: "http://t3/t1" });
      }),
    ));

  test("a PR authored by the configured GitHub login is skipped before T3 is reached", async () => {
    const reactions: string[] = [];
    const slack = fakeSlack({ react: (_, name) => Effect.sync(() => void reactions.push(name)) });
    await runWith(
      testLayer({ slack }),
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveSettings({ ...(yield* store.getSettings()), githubLogin: "Bernardo" });
        const rule = yield* store.createRule({ ...base, skipSelfReview: true });
        const ctx = { repo: "acme/widgets", pr_number: "7", pr_author: "bernardo", slack_channel: "C1", slack_ts: "1.0" };

        yield* handleDelivery({ deliveryId: "d4", event: base.events[0]!, ctx });
        yield* settle;
        const run = (yield* store.listRuns()).find((r) => r.deliveryId === "d4");
        expect(run).toMatchObject({ ruleId: rule.id, status: "skipped", threadId: null });
        expect(run?.detail).toContain("self review");
        // A skip is not a failure: ⏩, never ❌.
        expect(reactions).toEqual(["fast_forward"]);

        // Rule opted out, or no login configured: not our concern, so T3 is reached and the fake fails.
        yield* store.updateRule(rule.id, { ...rule, skipSelfReview: false });
        yield* handleDelivery({ deliveryId: "d5", event: base.events[0]!, ctx: { ...ctx, slack_channel: undefined, slack_ts: undefined } });
        yield* settle;
        expect((yield* store.listRuns()).find((r) => r.deliveryId === "d5")).toMatchObject({ status: "failed", detail: "unexpected" });
      }),
    );
  });

  test("a paused PR is skipped and points at the handoff; a Slack second pass reviews anyway", async () => {
    const replies: string[] = [];
    const slack = fakeSlack({ reply: (_, text) => Effect.sync(() => void replies.push(text)) });
    await runWith(
      testLayer({ slack }),
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveSettings({ ...(yield* store.getSettings()), maxChangesRequestedRounds: 2 });
        const rule = yield* store.createRule({ ...base, events: ["slack.message", "slack.second_pass"] });
        const ctx = { repo: "acme/widgets", pr_number: "9", pr_url: "https://github.com/acme/widgets/pull/9", slack_channel: "C1", slack_ts: "1.0" };
        const done = (result: string, event = "slack.message", threadUrl: string | null = null) =>
          store.recordRun({
            ruleId: rule.id, ruleName: rule.name, deliveryId: crypto.randomUUID(), event, repo: ctx.repo, source: "slack", author: "alice",
            status: "done", detail: "", threadId: threadUrl, threadUrl, context: ctx, result,
          });
        yield* done("CHANGES_REQUESTED: 4 comments");
        yield* done("CHANGES_REQUESTED: 2 comments");
        yield* done("# Handoff\nScope moved twice.", HANDOFF_EVENT, "http://t3/handoff");

        expect((yield* handleDelivery({ deliveryId: "d6", event: "slack.message", ctx })).matched).toEqual([]);
        const skipped = (yield* store.listRuns()).find((run) => run.deliveryId === "d6");
        expect(skipped).toMatchObject({ status: "skipped", threadUrl: "http://t3/handoff" });
        expect(skipped?.detail).toContain("paused");
        expect(replies[0]).toContain("2 reviews in a row requested changes");

        // A human asking for a second pass overrides the pause, and the handoff never feeds the review prompt.
        const again = yield* handleDelivery({ deliveryId: "d7", event: "slack.second_pass", ctx: { ...ctx } });
        expect(again.matched).toEqual([rule.name]);
        yield* settle;
        expect((yield* store.listRuns()).find((run) => run.deliveryId === "d7")?.context?.previous_result).toBe("CHANGES_REQUESTED: 2 comments");
      }),
    );
  });
});
