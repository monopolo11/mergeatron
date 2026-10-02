import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { botPostIgnored, handleSlackEvent, resolveSecondPassTarget } from "./secondPass.ts";
import { EMPTY_FILTERS } from "./shared.ts";
import { Store } from "./store.ts";
import { fakeSlack, runWith, testLayer } from "./testing.ts";

const pr = { repo: "acme/widgets", pr_number: "42", pr_url: "https://github.com/acme/widgets/pull/42" };
const mention = { repo: "", event: "slack.second_pass", slack_channel: "C1", slack_ts: "2.0", slack_thread_ts: "1.0", slack_text: "second pass" };

describe("resolveSecondPassTarget", () => {
  test("takes the PR from the run that started the thread", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.recordRun({ ruleId: "r", ruleName: "review", deliveryId: "d", event: "slack.message", repo: pr.repo, source: "slack", author: "alice", status: "done", detail: "", threadId: "t", threadUrl: "u", context: { ...pr, slack_channel: "C1", slack_ts: "1.0" }, result: "first pass" });
        const ctx = { ...mention };
        expect(yield* resolveSecondPassTarget(ctx)).toBeNull();
        expect(ctx).toMatchObject(pr);
      }),
    ));

  test("a PR link in the mention wins, and unknown threads get an explanation", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const linked = { ...mention, ...pr };
        expect(yield* resolveSecondPassTarget(linked)).toBeNull();
        expect(yield* resolveSecondPassTarget({ ...mention })).toContain("did not start from a PR review");
        expect(yield* resolveSecondPassTarget({ ...mention, slack_thread_ts: undefined })).toContain("inside the review's thread");
      }),
    ));
});

describe("botPostIgnored", () => {
  const rule = {
    name: "review", enabled: true, events: ["slack.message"], repos: [], reviewer: null, channel: "C1", allowBots: true, skipSelfReview: true, filters: EMPTY_FILTERS, maxConcurrent: 0,
    projectId: null, workspace: "worktree" as const, model: null, prompt: "x",
  };
  const ctx = { repo: "acme/widgets", slack_channel: "C1" };

  test("never lets our own posts through, other bots only where a rule accepts them", () =>
    runWith(
      testLayer({ slack: fakeSlack({ botId: Effect.succeed("B_OWN") }) }),
      Effect.gen(function* () {
        yield* (yield* Store).createRule(rule);
        expect(yield* botPostIgnored("slack.message", { ...ctx, slack_bot_id: "B_OWN" })).toBe("posted by this bot");
        expect(yield* botPostIgnored("slack.message", { ...ctx, slack_bot_id: "B_OTHER" })).toBeNull();
        expect(yield* botPostIgnored("slack.message", { ...ctx, slack_channel: "C2", slack_bot_id: "B_OTHER" })).toBe("posted by a bot; no rule accepting bots matches");
      }),
    ));
});

describe("handleSlackEvent", () => {
  test("another bot's second pass reaches repo-scoped rules through its thread's PR", () =>
    runWith(
      testLayer({ slack: fakeSlack({ botId: Effect.succeed("B_OWN") }) }),
      Effect.gen(function* () {
        const store = yield* Store;
        const rule = yield* store.createRule({
          name: "review", enabled: true, events: ["slack.second_pass"], repos: [pr.repo], reviewer: null, channel: null, allowBots: true, skipSelfReview: true, filters: EMPTY_FILTERS, maxConcurrent: 0,
          projectId: null, workspace: "worktree", model: null, prompt: "x",
        });
        // Still running, so the second pass is recorded as skipped without reaching T3 or GitHub.
        yield* store.recordRun({ ruleId: "r", ruleName: "review", deliveryId: "d", event: "slack.message", repo: pr.repo, source: "slack", author: "alice", status: "started", detail: "", threadId: "t", threadUrl: "u", context: { ...pr, slack_channel: "C1", slack_ts: "1.0" }, result: null });
        const event = { type: "app_mention", channel: "C1", ts: "2.0", thread_ts: "1.0", text: "<@U_OWN> Round 2: second pass requested", bot_id: "B_OTHER", user: "U_OTHER" };
        yield* handleSlackEvent({ type: "event_callback", event_id: "Ev1", event });
        expect(yield* store.hasRun("Ev1", rule.id)).toBe(true);
      }),
    ));
});
