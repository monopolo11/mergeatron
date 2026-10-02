import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { markMerged, renderReviewMessage, requestReview, requestSecondPass, ReviewRequestError, slackMentions } from "./reviewRequests.ts";
import { DEFAULT_REVIEW_REQUEST_MESSAGE, EMPTY_FILTERS } from "./shared.ts";
import { Store } from "./store.ts";
import { failureOf, fakePulls, fakeSlack, fakeT3, runWith, testLayer } from "./testing.ts";

const PR = "https://github.com/acme/widgets/pull/7";

function setup() {
  const posts: { channel: string; text: string; thread?: string }[] = [];
  const reactions: { channel: string; ts: string; name: string }[] = [];
  const merged = { value: false };
  const slack = fakeSlack({
    post: (channel, text, thread) => Effect.sync(() => (posts.push({ channel, text, thread }), { channel: "C1", ts: `${posts.length}.0` })),
    permalink: () => Effect.succeed("https://acme.slack.com/archives/C1/p10"),
    react: ({ channel, ts }, name) => Effect.sync(() => void reactions.push({ channel, ts, name })),
  });
  // No T3 projects: runs are recorded as started, then skipped in the background.
  const t3 = fakeT3({ projects: () => Effect.succeed([]) });
  const pulls = fakePulls({ details: (ctx) => Effect.succeed({ ...ctx, pr_title: "Add widgets" }), merged: () => Effect.sync(() => merged.value) });
  const layer = testLayer({ slack, t3, pulls });
  // Agents may only post to the review channel or a rule's channel; these tests use #reviews.
  const withRule = Effect.flatMap(Store, (store) =>
    Effect.andThen(Effect.flatMap(store.getSettings(), (settings) => store.saveSettings({ ...settings, reviewChannel: "#reviews" })), store.createRule({
      name: "review",
      enabled: true,
      events: ["slack.message", "slack.second_pass"],
      repos: [],
      reviewer: null,
      channel: null,
      allowBots: false,
      skipSelfReview: true,
      filters: EMPTY_FILTERS, maxConcurrent: 0,
      projectId: null,
      workspace: "worktree",
      model: null,
      prompt: "review {{pr_url}} round {{review_round}}",
    })),
  );
  return { layer, withRule, posts, reactions, merged };
}

describe("review requests", () => {
  test("request and second passes share one thread and count rounds", async () => {
    const { layer, withRule, posts } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        yield* withRule;
        const first = yield* requestReview({ prUrl: PR, channel: "#reviews", mentions: ["U0ALICE01"] });
        expect(first).toEqual({ channel: "C1", thread_ts: "1.0", permalink: "https://acme.slack.com/archives/C1/p10", round: 1, automated_review: ["review"] });
        expect(posts[0]).toEqual({ channel: "#reviews", text: `Review requested <@U0ALICE01>\n[acme/widgets#7](${PR}) Add widgets`, thread: undefined });
        expect(yield* failureOf(requestReview({ prUrl: PR, channel: "#reviews" }))).toBeInstanceOf(ReviewRequestError);

        const second = yield* requestSecondPass({ prUrl: PR, note: "Fixed the null check" });
        expect(second).toMatchObject({ thread_ts: "1.0", round: 2 });
        expect(posts[1]).toEqual({ channel: "C1", text: "Round 2: second pass requested\nFixed the null check", thread: "1.0" });

        expect((yield* requestSecondPass({ prUrl: PR })).round).toBe(3);

        const runs = (yield* (yield* Store).listRuns()).toReversed();
        expect(runs.map((run) => [run.event, run.context?.review_round, run.context?.slack_thread_ts])).toEqual([
          ["slack.message", "1", undefined],
          ["slack.second_pass", "2", "1.0"],
          ["slack.second_pass", "3", "1.0"],
        ]);
      }),
    );
  });

  test("later rounds need a first request", async () => {
    const { layer } = setup();
    const error = await runWith(layer, failureOf(requestSecondPass({ prUrl: PR })));
    expect(error.message).toContain("has not been sent for review yet");
  });
});

describe("markMerged", () => {
  test("reacts :merge: on the thread's opening message once the PR merged", async () => {
    const { layer, withRule, reactions, merged } = setup();
    // The rules react too (⏩ and friends); only the merge mark matters here.
    const marks = () => reactions.filter((reaction) => reaction.name === "merge");
    await runWith(
      layer,
      Effect.gen(function* () {
        yield* withRule;
        expect((yield* failureOf(markMerged(PR))).message).toContain("was not sent for review");

        yield* requestReview({ prUrl: PR, channel: "#reviews" });
        yield* requestSecondPass({ prUrl: PR });
        expect((yield* failureOf(markMerged(PR))).message).toContain("is not merged yet");
        expect(marks()).toEqual([]);

        merged.value = true;
        expect(yield* markMerged(PR)).toMatchObject({ channel: "C1", thread_ts: "1.0", reaction: "merge" });
        expect(marks()).toEqual([{ channel: "C1", ts: "1.0", name: "merge" }]);
      }),
    );
  });
});

describe("slackMentions", () => {
  test("tags user ids, group ids and broadcasts", () => {
    expect(Effect.runSync(slackMentions(["U0ALICE01", "@S0TEAM001", "here", "<@U0BOB0001>"]))).toBe("<@U0ALICE01> <!subteam^S0TEAM001> <!here> <@U0BOB0001>");
  });

  test("rejects names and emails", () => {
    expect(Effect.runSync(failureOf(slackMentions(["@bob"])))).toBeInstanceOf(ReviewRequestError);
    expect(Effect.runSync(failureOf(slackMentions(["bob@acme.com"])))).toBeInstanceOf(ReviewRequestError);
  });
});

test("renderReviewMessage drops what empty variables leave behind", () => {
  expect(renderReviewMessage(DEFAULT_REVIEW_REQUEST_MESSAGE, { repo: "acme/widgets", pr_number: "7", pr_url: PR }, { round: 1, mentions: "" })).toBe(
    `Review requested\n[acme/widgets#7](${PR})`,
  );
});
