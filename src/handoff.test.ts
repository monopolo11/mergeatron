import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { handoffIfStuck, handoffPrompt } from "./handoff.ts";
import type { RuleInput, Run } from "./rules.ts";
import { DEFAULT_HANDOFF_PROMPT, EMPTY_FILTERS, HANDOFF_EVENT } from "./shared.ts";
import { Store } from "./store.ts";
import type { StartThreadInput, T3Project } from "./t3.ts";
import { fakeSlack, fakeT3, runWith, settle, testLayer } from "./testing.ts";

const rule: RuleInput = {
  name: "review", enabled: true, events: ["slack.message"], reviewer: null, channel: null, allowBots: false, skipSelfReview: true, filters: EMPTY_FILTERS, maxConcurrent: 0,
  projectId: "p1", workspace: "worktree", model: null, prompt: "review {{pr_url}}", presetId: null,
};
const ctx = { repo: "acme/widgets", pr_number: "5", pr_url: "https://github.com/acme/widgets/pull/5", pr_title: "Add billing", pr_author: "alice", pr_base: "main", slack_channel: "C1", slack_ts: "1.0" };
const project: T3Project = { id: "p1", title: "widgets", workspaceRoot: "/w", deletedAt: null, defaultModelSelection: null };

/** Fakes that record what was started and said, and a store with one rule and `results.length` finished reviews of the PR. */
function setup(results: string[], limit = 3, projects: T3Project[] = [project]) {
  const started: StartThreadInput[] = [];
  const replies: string[] = [];
  const t3 = fakeT3({
    projects: () => Effect.succeed(projects),
    startThread: (input) => Effect.sync(() => (started.push(input), { threadId: "handoff-thread", threadUrl: "http://t3/handoff" })),
    thread: () => Effect.never,
  });
  const slack = fakeSlack({ reply: (_, text) => Effect.sync(() => void replies.push(text)) });
  const seed = Effect.gen(function* () {
    const store = yield* Store;
    yield* store.saveSettings({ ...(yield* store.getSettings()), maxChangesRequestedRounds: limit });
    const { id: ruleId } = yield* store.createRule(rule);
    const reviews: Run[] = [];
    for (const [index, result] of results.entries()) {
      reviews.push(
        yield* store.recordRun({
          ruleId, ruleName: rule.name, deliveryId: `d${index}`, event: "slack.message", repo: ctx.repo, source: "slack", author: "alice",
          status: "done", detail: "", threadId: `t${index}`, threadUrl: `http://t3/t${index}`, context: ctx, result,
        }),
      );
    }
    return reviews;
  });
  return { layer: testLayer({ t3, slack }), seed, started, replies };
}

describe("handoffIfStuck", () => {
  test("the Nth change request in a row starts a handoff thread from the review's rule and tells Slack", async () => {
    const { layer, seed, started, replies } = setup(["CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED: still"]);
    await runWith(
      layer,
      Effect.gen(function* () {
        const reviews = yield* seed;
        yield* handoffIfStuck(reviews.at(-1)!);
        yield* settle;

        expect(started).toHaveLength(1);
        expect(started[0]).toMatchObject({ title: "Handoff: Add billing", baseBranch: null, worktree: true, project: { id: "p1" } });
        expect(started[0]?.prompt).toContain("3 automated reviews in a row");
        const handoff = (yield* (yield* Store).listRuns()).find((run) => run.event === HANDOFF_EVENT);
        expect(handoff).toMatchObject({ status: "started", threadUrl: "http://t3/handoff", author: "alice", source: "slack" });
        expect(replies).toHaveLength(1);
        expect(replies[0]).toContain("Automated review paused");
      }),
    );
  });

  test("does nothing under the limit, past it, when an approval broke the streak, or when the limit is 0", async () => {
    for (const [results, limit] of [
      [["CHANGES_REQUESTED", "CHANGES_REQUESTED"], 3],
      [["CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED"], 3],
      [["CHANGES_REQUESTED", "APPROVED", "CHANGES_REQUESTED"], 2],
      [["CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED"], 0],
    ] as const) {
      const { layer, seed, started, replies } = setup([...results], limit);
      await runWith(
        layer,
        Effect.gen(function* () {
          const reviews = yield* seed;
          yield* handoffIfStuck(reviews.at(-1)!);
          yield* settle;
          expect(started).toHaveLength(0);
          expect(replies).toHaveLength(0);
        }),
      );
    }
  });

  test("a handoff that cannot start is recorded as failed and reported to Slack", async () => {
    const { layer, seed, replies } = setup(["CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED"], 3, []);
    await runWith(
      layer,
      Effect.gen(function* () {
        const reviews = yield* seed;
        yield* handoffIfStuck(reviews.at(-1)!);
        yield* settle;
        expect((yield* (yield* Store).listRuns()).find((run) => run.event === HANDOFF_EVENT)).toMatchObject({ status: "failed", detail: "no T3 project for acme/widgets" });
        expect(replies.at(-1)).toBe("Handoff not written: no T3 project for acme/widgets");
      }),
    );
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
