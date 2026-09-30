import { describe, expect, test } from "bun:test";
import { openDatabase } from "./db/index.ts";
import { renderReviewMessage, requestReview, requestSecondPass, ReviewRequestError, slackMentions, type ReviewDeps } from "./reviewRequests.ts";
import { DEFAULT_REVIEW_REQUEST_MESSAGE } from "./shared.ts";
import type { SlackClient } from "./slack.ts";
import { Store } from "./store.ts";
import type { T3Client } from "./t3.ts";

const PR = "https://github.com/acme/widgets/pull/7";

function setup() {
  const store = new Store(openDatabase(":memory:"));
  store.createRule({
    name: "review",
    enabled: true,
    events: ["slack.message", "slack.second_pass"],
    repos: [],
    reviewer: null,
    channel: null,
    allowBots: false,
    skipSelfReview: true,
    projectId: null,
    workspace: "worktree",
    model: null,
    prompt: "review {{pr_url}} round {{review_round}}",
  });
  const posts: { channel: string; text: string; thread?: string }[] = [];
  const slack = {
    post: async (channel: string, text: string, thread?: string) => (posts.push({ channel, text, thread }), { channel: "C1", ts: `${posts.length}.0` }),
    permalink: async () => "https://acme.slack.com/archives/C1/p10",
    react: async () => {},
    reply: async () => {},
  } as unknown as SlackClient;
  // No T3 projects: runs are recorded as started, then skipped in the background.
  const t3 = { projects: async () => [] } as unknown as T3Client;
  const deps: ReviewDeps = { store, t3, slack, pullRequestDetails: async (ctx) => ({ ...ctx, pr_title: "Add widgets" }) };
  return { deps, store, posts };
}

describe("review requests", () => {
  test("request and second passes share one thread and count rounds", async () => {
    const { deps, store, posts } = setup();

    const first = await requestReview(deps, { prUrl: PR, channel: "#reviews", mentions: ["U0ALICE01"] });
    expect(first).toEqual({ channel: "C1", thread_ts: "1.0", permalink: "https://acme.slack.com/archives/C1/p10", round: 1, automated_review: ["review"] });
    expect(posts[0]).toEqual({ channel: "#reviews", text: `Review requested <@U0ALICE01>\n[acme/widgets#7](${PR}) Add widgets`, thread: undefined });
    await expect(requestReview(deps, { prUrl: PR, channel: "#reviews" })).rejects.toBeInstanceOf(ReviewRequestError);

    const second = await requestSecondPass(deps, { prUrl: PR, note: "Fixed the null check" });
    expect(second).toMatchObject({ thread_ts: "1.0", round: 2 });
    expect(posts[1]).toEqual({ channel: "C1", text: "Round 2: second pass requested\nFixed the null check", thread: "1.0" });

    expect((await requestSecondPass(deps, { prUrl: PR })).round).toBe(3);

    const runs = store.listRuns().toReversed();
    expect(runs.map((run) => [run.event, run.context?.review_round, run.context?.slack_thread_ts])).toEqual([
      ["slack.message", "1", undefined],
      ["slack.second_pass", "2", "1.0"],
      ["slack.second_pass", "3", "1.0"],
    ]);
  });

  test("later rounds need a first request", async () => {
    const { deps } = setup();
    await expect(requestSecondPass(deps, { prUrl: PR })).rejects.toThrow("has not been sent for review yet");
  });
});

describe("slackMentions", () => {
  test("tags user ids, group ids and broadcasts", () => {
    expect(slackMentions(["U0ALICE01", "@S0TEAM001", "here", "<@U0BOB0001>"])).toBe("<@U0ALICE01> <!subteam^S0TEAM001> <!here> <@U0BOB0001>");
  });

  test("rejects names and emails", () => {
    expect(() => slackMentions(["@bob"])).toThrow(ReviewRequestError);
    expect(() => slackMentions(["bob@acme.com"])).toThrow(ReviewRequestError);
  });
});

test("renderReviewMessage drops what empty variables leave behind", () => {
  expect(renderReviewMessage(DEFAULT_REVIEW_REQUEST_MESSAGE, { repo: "acme/widgets", pr_number: "7", pr_url: PR }, { round: 1, mentions: "" })).toBe(
    `Review requested\n[acme/widgets#7](${PR})`,
  );
});
