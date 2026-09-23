import { describe, expect, test } from "bun:test";
import { openDatabase } from "./db/index.ts";
import { handleDelivery, hostsRepository, matchRules, resolveProject, ruleMismatch } from "./handler.ts";
import type { Rule } from "./rules.ts";
import { Store } from "./store.ts";
import type { SlackClient } from "./slack.ts";
import type { T3Client, T3Project } from "./t3.ts";

const base: Rule = {
  id: "r1",
  name: "review",
  enabled: true,
  events: ["pull_request.review_requested"],
  repos: [],
  reviewer: null,
  channel: null,
  skipSelfReview: true,
  projectId: null,
  workspace: "worktree",
  model: null,
  prompt: "x",
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
  test("a Slack message that matches no rule gets a skipped reaction and no run", () => {
    const store = new Store(openDatabase(":memory:"));
    store.createRule({ ...base, events: ["slack.message"], channel: "C-other" });
    const reactions: string[] = [];
    const slack = { react: (_: unknown, name: string) => (reactions.push(name), Promise.resolve()) } as unknown as SlackClient;
    const t3 = { projects: () => Promise.reject(new Error("unexpected")) } as unknown as T3Client;
    const ctx = { repo: "acme/widgets", pr_number: "1", pr_url: "https://github.com/acme/widgets/pull/1", slack_channel: "C1", slack_ts: "1.0" };

    handleDelivery({ store, t3, slack }, { deliveryId: "d0", event: "slack.message", ctx });
    expect(reactions).toEqual(["fast_forward"]);
    expect(store.listRuns()).toHaveLength(0);
  });

  test("one review per PR at a time: a second delivery is skipped and points at the running thread", () => {
    const store = new Store(openDatabase(":memory:"));
    const rule = store.createRule({ ...base, repos: [], events: ["slack.message"] });
    const ctx = { repo: "acme/widgets", pr_number: "42", pr_url: "https://github.com/acme/widgets/pull/42" };
    store.recordRun({
      ruleId: "other-rule", ruleName: "github review", deliveryId: "d1", event: "pull_request.review_requested", repo: "Acme/Widgets",
      source: "github", author: "alice", status: "started", detail: "", threadId: "t1", threadUrl: "http://t3/t1", context: ctx, result: null,
    });
    // T3 must never be reached: the lock is decided before any thread starts.
    const t3 = { projects: () => Promise.reject(new Error("unexpected")) } as unknown as T3Client;

    const result = handleDelivery({ store, t3, slack: null }, { deliveryId: "d2", event: "slack.message", ctx });
    expect(result.matched).toEqual([]);
    const skipped = store.listRuns().find((run) => run.deliveryId === "d2");
    expect(skipped).toMatchObject({ ruleId: rule.id, status: "skipped", threadUrl: "http://t3/t1" });
    expect(skipped?.detail).toContain("already running for acme/widgets#42");

    // Once the first review settles, the PR is free again and its reply feeds the next review's prompt.
    store.updateRun(store.listRuns().find((run) => run.deliveryId === "d1")!.id, { status: "done", result: "first pass findings" });
    expect(store.activeRunForPullRequest("acme/widgets", "42")).toBeNull();
    const again = handleDelivery({ store, t3, slack: null }, { deliveryId: "d3", event: "slack.message", ctx: { ...ctx } });
    expect(again.matched).toEqual([rule.name]);
    const run = store.listRuns().find((r) => r.deliveryId === "d3");
    expect(run?.context).toMatchObject({ previous_result: "first pass findings", previous_thread_url: "http://t3/t1" });
  });

  test("a PR authored by the configured GitHub login is skipped before T3 is reached", async () => {
    const store = new Store(openDatabase(":memory:"));
    store.saveSettings({ ...store.getSettings(), githubLogin: "Bernardo" });
    const rule = store.createRule({ ...base, skipSelfReview: true });
    const t3 = { projects: () => Promise.reject(new Error("unexpected")) } as unknown as T3Client;
    const ctx = { repo: "acme/widgets", pr_number: "7", pr_author: "bernardo", slack_channel: "C1", slack_ts: "1.0" };
    const reactions: string[] = [];
    const slack = {
      react: (_: unknown, name: string) => (reactions.push(name), Promise.resolve()),
      reply: () => Promise.resolve(),
    } as unknown as SlackClient;

    handleDelivery({ store, t3, slack }, { deliveryId: "d4", event: base.events[0]!, ctx });
    await Bun.sleep(0);
    const run = store.listRuns().find((r) => r.deliveryId === "d4");
    expect(run).toMatchObject({ ruleId: rule.id, status: "skipped", threadId: null });
    expect(run?.detail).toContain("self review");
    // A skip is not a failure: ⏩, never ❌.
    expect(reactions).toEqual(["fast_forward"]);

    // Rule opted out, or no login configured: not our concern, so T3 is reached and the mock rejects.
    store.updateRule(rule.id, { ...base, skipSelfReview: false });
    handleDelivery({ store, t3, slack: null }, { deliveryId: "d5", event: base.events[0]!, ctx });
    await Bun.sleep(0);
    expect(store.listRuns().find((r) => r.deliveryId === "d5")).toMatchObject({ status: "failed", detail: "unexpected" });
  });
});
