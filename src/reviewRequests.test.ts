import { describe, expect, test } from "bun:test";
import { openDatabase } from "./db/index.ts";
import { markMerged, renderReviewMessage, requestReview, requestSecondPass, ReviewRequestError, slackMentions, type ReviewDeps } from "./reviewRequests.ts";
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
  const reactions: { channel: string; ts: string; name: string }[] = [];
  const slack = {
    post: async (channel: string, text: string, thread?: string) => (posts.push({ channel, text, thread }), { channel: "C1", ts: `${posts.length}.0` }),
    permalink: async () => "https://acme.slack.com/archives/C1/p10",
    react: async ({ channel, ts }: { channel: string; ts: string }, name: string) => void reactions.push({ channel, ts, name }),
    reply: async () => {},
  } as unknown as SlackClient;
  // No T3 projects: runs are recorded as started, then skipped in the background.
  const t3 = { projects: async () => [] } as unknown as T3Client;
  const merged = { value: false };
  const deps: ReviewDeps = {
    store,
    t3,
    slack,
    pullRequestDetails: async (ctx) => ({ ...ctx, pr_title: "Add widgets" }),
    pullRequestMerged: async () => merged.value,
  };
  return { deps, store, posts, reactions, merged };
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

describe("markMerged", () => {
  test("reacts :merge: on the thread's opening message once the PR merged", async () => {
    const { deps, reactions, merged } = setup();
    // The rules react too (⏩ and friends); only the merge mark matters here.
    const marks = () => reactions.filter((reaction) => reaction.name === "merge");
    await expect(markMerged(deps, PR)).rejects.toThrow("was not sent for review");

    await requestReview(deps, { prUrl: PR, channel: "#reviews" });
    await requestSecondPass(deps, { prUrl: PR });
    await expect(markMerged(deps, PR)).rejects.toThrow("is not merged yet");
    expect(marks()).toEqual([]);

    merged.value = true;
    expect(await markMerged(deps, PR)).toMatchObject({ channel: "C1", thread_ts: "1.0", reaction: "merge" });
    expect(marks()).toEqual([{ channel: "C1", ts: "1.0", name: "merge" }]);
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
