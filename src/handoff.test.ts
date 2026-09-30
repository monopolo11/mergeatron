import { describe, expect, test } from "bun:test";
import { openDatabase } from "./db/index.ts";
import { handoffIfStuck, handoffPrompt } from "./handoff.ts";
import type { RuleInput } from "./rules.ts";
import { DEFAULT_HANDOFF_PROMPT, HANDOFF_EVENT } from "./shared.ts";
import type { SlackClient } from "./slack.ts";
import { Store } from "./store.ts";
import type { StartThreadInput, T3Client } from "./t3.ts";

const rule: RuleInput = {
  name: "review", enabled: true, events: ["slack.message"], repos: [], reviewer: null, channel: null, allowBots: false, skipSelfReview: true,
  projectId: "p1", workspace: "worktree", model: null, prompt: "review {{pr_url}}",
};
const ctx = { repo: "acme/widgets", pr_number: "5", pr_url: "https://github.com/acme/widgets/pull/5", pr_title: "Add billing", pr_author: "alice", pr_base: "main", slack_channel: "C1", slack_ts: "1.0" };

/** A store with one rule and `results.length` finished reviews of the PR, plus fakes that record what was started and said. */
function setup(results: string[], limit = 3) {
  const store = new Store(openDatabase(":memory:"));
  store.saveSettings({ ...store.getSettings(), maxChangesRequestedRounds: limit });
  const { id: ruleId } = store.createRule(rule);
  const reviews = results.map((result, index) =>
    store.recordRun({
      ruleId, ruleName: rule.name, deliveryId: `d${index}`, event: "slack.message", repo: ctx.repo, source: "slack", author: "alice",
      status: "done", detail: "", threadId: `t${index}`, threadUrl: `http://t3/t${index}`, context: ctx, result,
    }),
  );
  const started: StartThreadInput[] = [];
  const replies: string[] = [];
  const t3 = {
    projects: () => Promise.resolve([{ id: "p1", title: "widgets", workspaceRoot: "/w", deletedAt: null, defaultModelSelection: null }]),
    startThread: (input: StartThreadInput) => (started.push(input), Promise.resolve({ threadId: "handoff-thread", threadUrl: "http://t3/handoff" })),
    thread: () => new Promise(() => {}),
  } as unknown as T3Client;
  const slack = { reply: (_: unknown, text: string) => (replies.push(text), Promise.resolve()) } as unknown as SlackClient;
  return { store, reviews, started, replies, deps: { store, t3, slack } };
}

describe("handoffIfStuck", () => {
  test("the Nth change request in a row starts a handoff thread from the review's rule and tells Slack", async () => {
    const { store, reviews, started, replies, deps } = setup(["CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED: still"]);
    handoffIfStuck(deps, reviews.at(-1)!);
    await Bun.sleep(0);

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ title: "Handoff: Add billing", baseBranch: null, worktree: true, project: { id: "p1" } });
    expect(started[0]?.prompt).toContain("3 automated reviews in a row");
    const handoff = store.listRuns().find((run) => run.event === HANDOFF_EVENT);
    expect(handoff).toMatchObject({ status: "started", threadUrl: "http://t3/handoff", author: "alice", source: "slack" });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Automated review paused");
  });

  test("does nothing under the limit, past it, when an approval broke the streak, or when the limit is 0", async () => {
    for (const [results, limit] of [
      [["CHANGES_REQUESTED", "CHANGES_REQUESTED"], 3],
      [["CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED"], 3],
      [["CHANGES_REQUESTED", "APPROVED", "CHANGES_REQUESTED"], 2],
      [["CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED"], 0],
    ] as const) {
      const { reviews, started, replies, deps } = setup([...results], limit);
      handoffIfStuck(deps, reviews.at(-1)!);
      await Bun.sleep(0);
      expect(started).toHaveLength(0);
      expect(replies).toHaveLength(0);
    }
  });

  test("a handoff that cannot start is recorded as failed and reported to Slack", async () => {
    const { store, reviews, replies, deps } = setup(["CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED"]);
    deps.t3.projects = () => Promise.resolve([]);
    handoffIfStuck(deps, reviews.at(-1)!);
    await Bun.sleep(0);
    expect(store.listRuns().find((run) => run.event === HANDOFF_EVENT)).toMatchObject({ status: "failed", detail: "no T3 project for acme/widgets" });
    expect(replies.at(-1)).toBe("Handoff not written: no T3 project for acme/widgets");
  });
});

describe("handoffPrompt", () => {
  test("renders the template from settings with the rounds oldest first", () => {
    const round = (createdAt: string, result: string) => ({ ruleName: "review", createdAt, threadUrl: null, result });
    const prompt = handoffPrompt(DEFAULT_HANDOFF_PROMPT, ctx, [round("2026-09-23T10:00:00.000Z", "second: still broken"), round("2026-09-20T10:00:00.000Z", "first: broken")]);
    expect(prompt).toContain('Pull request https://github.com/acme/widgets/pull/5 ("Add billing" by alice) has had 2 automated reviews');
    expect(prompt.indexOf("Round 1 (2026-09-20")).toBeLessThan(prompt.indexOf("Round 2 (2026-09-23"));
    expect(prompt.indexOf("first: broken")).toBeLessThan(prompt.indexOf("second: still broken"));
    expect(handoffPrompt("{{rounds}} rounds on {{pr_url}}", ctx, [round("2026-09-20T10:00:00.000Z", "x")])).toBe("1 rounds on https://github.com/acme/widgets/pull/5");
  });
});
