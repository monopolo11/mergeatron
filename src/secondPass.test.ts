import { describe, expect, test } from "bun:test";
import { openDatabase } from "./db/index.ts";
import { botPostIgnored, resolveSecondPassTarget } from "./secondPass.ts";
import type { SlackClient } from "./slack.ts";
import type { T3Client } from "./t3.ts";
import { Store } from "./store.ts";

const pr = { repo: "acme/widgets", pr_number: "42", pr_url: "https://github.com/acme/widgets/pull/42" };
const mention = { repo: "", event: "slack.second_pass", slack_channel: "C1", slack_ts: "2.0", slack_thread_ts: "1.0", slack_text: "second pass" };

describe("resolveSecondPassTarget", () => {
  test("takes the PR from the run that started the thread", () => {
    const store = new Store(openDatabase(":memory:"));
    store.recordRun({ ruleId: "r", ruleName: "review", deliveryId: "d", event: "slack.message", repo: pr.repo, source: "slack", author: "alice", status: "done", detail: "", threadId: "t", threadUrl: "u", context: { ...pr, slack_channel: "C1", slack_ts: "1.0" }, result: "first pass" });
    const ctx = { ...mention };
    expect(resolveSecondPassTarget(store, ctx)).toBeNull();
    expect(ctx).toMatchObject(pr);
  });

  test("a PR link in the mention wins, and unknown threads get an explanation", () => {
    const store = new Store(openDatabase(":memory:"));
    const linked = { ...mention, ...pr };
    expect(resolveSecondPassTarget(store, linked)).toBeNull();
    expect(resolveSecondPassTarget(store, { ...mention })).toContain("did not start from a PR review");
    expect(resolveSecondPassTarget(store, { ...mention, slack_thread_ts: undefined })).toContain("inside the review's thread");
  });
});

describe("botPostIgnored", () => {
  const store = new Store(openDatabase(":memory:"));
  const rule = {
    name: "review", enabled: true, events: ["slack.message"], repos: [], reviewer: null, channel: "C1", allowBots: true, skipSelfReview: true,
    projectId: null, workspace: "worktree" as const, model: null, prompt: "x",
  };
  store.createRule(rule);
  const deps = { store, t3: {} as T3Client, slack: { botId: async () => "B_OWN" } as unknown as SlackClient };
  const ctx = { repo: "acme/widgets", slack_channel: "C1" };

  test("never lets our own posts through, other bots only where a rule accepts them", async () => {
    expect(await botPostIgnored(deps, "slack.message", { ...ctx, slack_bot_id: "B_OWN" })).toBe("posted by this bot");
    expect(await botPostIgnored(deps, "slack.message", { ...ctx, slack_bot_id: "B_OTHER" })).toBeNull();
    expect(await botPostIgnored(deps, "slack.message", { ...ctx, slack_channel: "C2", slack_bot_id: "B_OTHER" })).toBe("posted by a bot; no rule accepting bots matches");
  });
});
