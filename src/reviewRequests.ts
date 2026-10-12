import { Data, Effect } from "effect";
import { assertChannelAllowed } from "./channels.ts";
import type { WebhookContext } from "./github.ts";
import { handleDelivery, type HandlerServices } from "./handler.ts";
import { logger } from "./log.ts";
import { PullRequests } from "./pulls.ts";
import type { ReviewRequest } from "./rules.ts";
import { HANDOFF_EVENT } from "./shared.ts";
import { pullRequestInText, SECOND_PASS_EVENT, SlackClient } from "./slack.ts";
import { Store } from "./store.ts";
import { renderTemplate } from "./template.ts";
import { reviewVerdict } from "./verdict.ts";

/**
 * Agent-driven review requests, behind the MCP tools in mcp.ts. An agent sends
 * a PR for review: the bot posts the request in a channel and the post feeds
 * the rules like a human's `slack.message`. Second passes reply in that thread
 * as `slack.second_pass`, so reactions and the review reply land where the
 * humans look. Once merged, the request message gets a :merge: reaction.
 */

const log = logger("mcp");

/** What the tools need: the handler's services plus GitHub lookups through `gh`. */
export type ReviewServices = HandlerServices | PullRequests;

/** A problem the calling agent can fix; its message is returned to the agent as the tool error. */
export class ReviewRequestError extends Data.TaggedError("ReviewRequestError")<{ readonly message: string }> {}

/** What the agent asked for; `mentions` become Slack tags, `note` fills `{{note}}`. */
export type ReviewAsk = { prUrl: string; mentions?: string[]; note?: string };

export type ReviewRound = {
  channel: string;
  thread_ts: string;
  permalink: string | null;
  round: number;
  /** Rules that started an automated review. Empty when none did; `reviewStatus` says why. */
  automated_review: string[];
};

/** Posts the first review request for a PR and opens its tracked thread. */
export const requestReview = Effect.fn("review.request")(function* (ask: ReviewAsk & { channel?: string }) {
  const store = yield* Store;
  const slack = yield* SlackClient;
  const pulls = yield* PullRequests;
  const pr = yield* parsePullRequest(ask.prUrl);
  const existing = yield* store.getReviewRequest(pr.repo, pr.number);
  if (existing) {
    return yield* Effect.fail(
      new ReviewRequestError({
        message: `${pr.repo}#${pr.number} was already sent for review (round ${existing.round}, ${existing.permalink ?? existing.channel}). Use request_second_pass.`,
      }),
    );
  }
  const settings = yield* store.getSettings();
  const channel = ask.channel ?? settings.reviewChannel;
  if (!channel) return yield* Effect.fail(new ReviewRequestError({ message: "No channel: pass `channel`, or set a review channel in the orchestrator's Settings." }));

  yield* assertChannelAllowed(channel);

  const ctx = yield* pulls.details({ repo: pr.repo, pr_url: pr.url, pr_number: pr.number });
  const mentions = yield* slackMentions(ask.mentions);
  const text = renderReviewMessage(settings.reviewRequestMessage, ctx, { round: 1, mentions, note: ask.note });
  const posted = yield* slack.post(channel, text);
  const permalink = yield* slack.permalink(posted.channel, posted.ts).pipe(Effect.orElseSucceed(() => null));
  const request = yield* store.createReviewRequest({ repo: pr.repo, prNumber: pr.number, prUrl: pr.url, channel: posted.channel, threadTs: posted.ts, permalink, mentions });

  const automated = yield* startReview("slack.message", { ...ctx, slack_channel: posted.channel, slack_ts: posted.ts, slack_text: text, review_round: "1" });
  return round(request, automated);
});

/**
 * Asks for another review in the PR's tracked thread and starts the next
 * round. Runs even when the PR's reviews are paused, like a human's
 * "second pass" mention. Without `mentions` it tags whoever the last round did.
 */
export const requestSecondPass = Effect.fn("review.secondPass")(function* (ask: ReviewAsk) {
  const store = yield* Store;
  const slack = yield* SlackClient;
  const pulls = yield* PullRequests;
  const pr = yield* parsePullRequest(ask.prUrl);
  const request = yield* store.getReviewRequest(pr.repo, pr.number);
  if (!request) return yield* Effect.fail(new ReviewRequestError({ message: `${pr.repo}#${pr.number} has not been sent for review yet. Use request_review first.` }));
  const settings = yield* store.getSettings();

  const ctx = yield* pulls.details({ repo: pr.repo, pr_url: request.prUrl, pr_number: pr.number });
  const mentions = ask.mentions?.length ? yield* slackMentions(ask.mentions) : request.mentions;
  const text = renderReviewMessage(settings.secondPassMessage, ctx, { round: request.round + 1, mentions, note: ask.note });
  const posted = yield* slack.post(request.channel, text, request.threadTs);
  const updated = yield* store.nextReviewRound(request.id, mentions);

  const automated = yield* startReview(SECOND_PASS_EVENT, {
    ...ctx,
    slack_channel: request.channel,
    slack_ts: posted.ts,
    slack_thread_ts: request.threadTs,
    slack_text: text,
    review_round: String(updated.round),
  });
  return round(updated, automated);
});

/** Slack emoji marking a review thread whose PR merged. A custom emoji: Slack rejects it with `invalid_name` where the workspace lacks it. */
export const MERGED_REACTION = "merge";

/**
 * Reacts :merge: on the message that opened the PR's review thread, once
 * GitHub says the PR is merged. Safe to repeat.
 */
export const markMerged = Effect.fn("review.markMerged")(function* (prUrl: string) {
  const store = yield* Store;
  const slack = yield* SlackClient;
  const pulls = yield* PullRequests;
  const pr = yield* parsePullRequest(prUrl);
  const request = yield* store.getReviewRequest(pr.repo, pr.number);
  if (!request) return yield* Effect.fail(new ReviewRequestError({ message: `${pr.repo}#${pr.number} was not sent for review with request_review, so there is no thread to mark.` }));
  const merged = yield* pulls.merged(pr.repo, pr.number);
  if (merged === null) return yield* Effect.fail(new ReviewRequestError({ message: `Could not check whether ${pr.repo}#${pr.number} is merged: the gh CLI failed (see the orchestrator log).` }));
  if (!merged) return yield* Effect.fail(new ReviewRequestError({ message: `${pr.repo}#${pr.number} is not merged yet. Call mark_merged after it merges.` }));

  yield* slack.react({ channel: request.channel, ts: request.threadTs, thread: request.threadTs }, MERGED_REACTION);
  yield* log.info("marked merged", { pr: request.prUrl, channel: request.channel, ts: request.threadTs });
  return { channel: request.channel, thread_ts: request.threadTs, permalink: request.permalink, reaction: MERGED_REACTION };
});

/**
 * Where a PR's review stands: its tracked Slack thread and round (when an
 * agent requested it), the orchestrator's status, and the latest review's
 * reply so the agent can act on the findings.
 */
export const reviewStatus = Effect.fn("review.status")(function* (prUrl: string) {
  const store = yield* Store;
  const pr = yield* parsePullRequest(prUrl);
  const request = yield* store.getReviewRequest(pr.repo, pr.number);
  const summary = (yield* store.pullRequests()).find((row) => row.repo.toLowerCase() === pr.repo.toLowerCase() && row.number === pr.number);
  const latest = (yield* store.finishedRunsForPullRequest(pr.repo, pr.number)).find((run) => run.event !== HANDOFF_EVENT);
  return {
    slack: request ? { channel: request.channel, thread_ts: request.threadTs, permalink: request.permalink, round: request.round } : null,
    status: summary?.status ?? "not reviewed",
    reviews: summary?.reviews ?? 0,
    latest_review: latest ? { verdict: reviewVerdict(latest.result), at: latest.createdAt, result: latest.result } : null,
  };
});

/** Renders a review message template and drops the blank lines and trailing spaces empty variables leave behind. */
export function renderReviewMessage(template: string, ctx: WebhookContext, vars: { round: number; mentions: string; note?: string }): string {
  return renderTemplate(template, { ...ctx, round: String(vars.round), mentions: vars.mentions, note: vars.note })
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Turns mentions into Slack tags: user ids (`U…`), user group ids (`S…`),
 * `here`/`channel`/`everyone`, or tags already in Slack syntax. Anything
 * else, such as a name or email, is an error rather than silent plain text.
 */
export const slackMentions = (entries: string[] = []): Effect.Effect<string, ReviewRequestError> =>
  Effect.map(Effect.forEach(entries, (entry) => slackMention(entry.trim())), (tags) => tags.join(" "));

function slackMention(entry: string): Effect.Effect<string, ReviewRequestError> {
  if (/^<[@!][^>]+>$/.test(entry)) return Effect.succeed(entry);
  const bare = entry.replace(/^[@!]/, "");
  if (/^(here|channel|everyone)$/i.test(bare)) return Effect.succeed(`<!${bare.toLowerCase()}>`);
  if (/^[UW][A-Z0-9]{6,}$/.test(bare)) return Effect.succeed(`<@${bare}>`);
  if (/^S[A-Z0-9]{6,}$/.test(bare)) return Effect.succeed(`<!subteam^${bare}>`);
  return Effect.fail(new ReviewRequestError({ message: `Cannot tag "${entry}": use a Slack user id (U…), a user group id (S…), or here/channel.` }));
}

function parsePullRequest(url: string): Effect.Effect<{ repo: string; number: string; url: string }, ReviewRequestError> {
  const pr = pullRequestInText(url);
  return pr ? Effect.succeed(pr) : Effect.fail(new ReviewRequestError({ message: `Not a GitHub pull request URL: ${url}` }));
}

/** Feeds the bot's own post to the rules; the Socket Mode handler ignores bot messages, so nothing fires twice. */
const startReview = (event: string, ctx: WebhookContext) =>
  Effect.gen(function* () {
    const deliveryId = `mcp:${ctx.slack_channel}:${ctx.slack_ts}`;
    yield* log.info("review requested", { delivery: deliveryId, event, pr: ctx.pr_url, round: ctx.review_round });
    return (yield* handleDelivery({ deliveryId, event, ctx: { ...ctx, event } })).matched;
  });

function round(request: ReviewRequest, automated: string[]): ReviewRound {
  return { channel: request.channel, thread_ts: request.threadTs, permalink: request.permalink, round: request.round, automated_review: automated };
}
