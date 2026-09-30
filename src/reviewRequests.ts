import { reviewVerdict } from "./completion.ts";
import type { WebhookContext } from "./github.ts";
import { handleDelivery, type HandlerDeps } from "./handler.ts";
import { logger } from "./log.ts";
import { withPullRequestDetails } from "./pulls.ts";
import type { ReviewRequest } from "./rules.ts";
import { HANDOFF_EVENT } from "./shared.ts";
import { pullRequestInText, SECOND_PASS_EVENT, type SlackClient } from "./slack.ts";
import type { Store } from "./store.ts";
import { renderTemplate } from "./template.ts";

/**
 * Agent-driven review requests, behind the MCP tools in mcp.ts. An agent sends
 * a PR for review: the bot posts the request in a channel and the post feeds
 * the rules like a human's `slack.message`. Second passes reply in that thread
 * as `slack.second_pass`, so reactions and the review reply land where the
 * humans look.
 */

const log = logger("mcp");

export type ReviewDeps = HandlerDeps & {
  slack: SlackClient;
  /** Fills PR title, head and author from GitHub; defaults to the `gh` CLI (pulls.ts). */
  pullRequestDetails?: typeof withPullRequestDetails;
};

/** A problem the calling agent can fix; its message is returned to the agent as the tool error. */
export class ReviewRequestError extends Error {
  override name = "ReviewRequestError";
}

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
export async function requestReview(deps: ReviewDeps, ask: ReviewAsk & { channel?: string }): Promise<ReviewRound> {
  const pr = parsePullRequest(ask.prUrl);
  const existing = deps.store.getReviewRequest(pr.repo, pr.number);
  if (existing) {
    throw new ReviewRequestError(
      `${pr.repo}#${pr.number} was already sent for review (round ${existing.round}, ${existing.permalink ?? existing.channel}). Use request_second_pass.`,
    );
  }
  const settings = deps.store.getSettings();
  const channel = ask.channel ?? settings.reviewChannel;
  if (!channel) throw new ReviewRequestError("No channel: pass `channel`, or set a review channel in the orchestrator's Settings.");

  const ctx = await (deps.pullRequestDetails ?? withPullRequestDetails)({ repo: pr.repo, pr_url: pr.url, pr_number: pr.number });
  const text = renderReviewMessage(settings.reviewRequestMessage, ctx, { round: 1, mentions: slackMentions(ask.mentions), note: ask.note });
  const posted = await deps.slack.post(channel, text);
  const permalink = await deps.slack.permalink(posted.channel, posted.ts).catch(() => null);
  const request = deps.store.createReviewRequest({ repo: pr.repo, prNumber: pr.number, prUrl: pr.url, channel: posted.channel, threadTs: posted.ts, permalink });

  const automated = startReview(deps, "slack.message", { ...ctx, slack_channel: posted.channel, slack_ts: posted.ts, slack_text: text, review_round: "1" });
  return round(request, automated);
}

/**
 * Asks for another review in the PR's tracked thread and starts the next
 * round. Runs even when the PR's reviews are paused, like a human's
 * "second pass" mention.
 */
export async function requestSecondPass(deps: ReviewDeps, ask: ReviewAsk): Promise<ReviewRound> {
  const pr = parsePullRequest(ask.prUrl);
  const request = deps.store.getReviewRequest(pr.repo, pr.number);
  if (!request) throw new ReviewRequestError(`${pr.repo}#${pr.number} has not been sent for review yet. Use request_review first.`);
  const settings = deps.store.getSettings();

  const ctx = await (deps.pullRequestDetails ?? withPullRequestDetails)({ repo: pr.repo, pr_url: request.prUrl, pr_number: pr.number });
  const text = renderReviewMessage(settings.secondPassMessage, ctx, { round: request.round + 1, mentions: slackMentions(ask.mentions), note: ask.note });
  const posted = await deps.slack.post(request.channel, text, request.threadTs);
  const updated = deps.store.nextReviewRound(request.id);

  const automated = startReview(deps, SECOND_PASS_EVENT, {
    ...ctx,
    slack_channel: request.channel,
    slack_ts: posted.ts,
    slack_thread_ts: request.threadTs,
    slack_text: text,
    review_round: String(updated.round),
  });
  return round(updated, automated);
}

/**
 * Where a PR's review stands: its tracked Slack thread and round (when an
 * agent requested it), the orchestrator's status, and the latest review's
 * reply so the agent can act on the findings.
 */
export function reviewStatus(store: Store, prUrl: string) {
  const pr = parsePullRequest(prUrl);
  const request = store.getReviewRequest(pr.repo, pr.number);
  const summary = store.pullRequests().find((row) => row.repo.toLowerCase() === pr.repo.toLowerCase() && row.number === pr.number);
  const latest = store.finishedRunsForPullRequest(pr.repo, pr.number).find((run) => run.event !== HANDOFF_EVENT);
  return {
    slack: request ? { channel: request.channel, thread_ts: request.threadTs, permalink: request.permalink, round: request.round } : null,
    status: summary?.status ?? "not reviewed",
    reviews: summary?.reviews ?? 0,
    latest_review: latest ? { verdict: reviewVerdict(latest.result), at: latest.createdAt, result: latest.result } : null,
  };
}

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
export function slackMentions(entries: string[] = []): string {
  return entries.map((entry) => slackMention(entry.trim())).join(" ");
}

function slackMention(entry: string): string {
  if (/^<[@!][^>]+>$/.test(entry)) return entry;
  const bare = entry.replace(/^[@!]/, "");
  if (/^(here|channel|everyone)$/i.test(bare)) return `<!${bare.toLowerCase()}>`;
  if (/^[UW][A-Z0-9]{6,}$/.test(bare)) return `<@${bare}>`;
  if (/^S[A-Z0-9]{6,}$/.test(bare)) return `<!subteam^${bare}>`;
  throw new ReviewRequestError(`Cannot tag "${entry}": use a Slack user id (U…), a user group id (S…), or here/channel.`);
}

function parsePullRequest(url: string) {
  const pr = pullRequestInText(url);
  if (!pr) throw new ReviewRequestError(`Not a GitHub pull request URL: ${url}`);
  return pr;
}

/** Feeds the bot's own post to the rules; the Socket Mode handler ignores bot messages, so nothing fires twice. */
function startReview(deps: ReviewDeps, event: string, ctx: WebhookContext): string[] {
  const deliveryId = `mcp:${ctx.slack_channel}:${ctx.slack_ts}`;
  log.info("review requested", { delivery: deliveryId, event, pr: ctx.pr_url, round: ctx.review_round });
  return handleDelivery(deps, { deliveryId, event, ctx: { ...ctx, event } }).matched;
}

function round(request: ReviewRequest, automated: string[]): ReviewRound {
  return { channel: request.channel, thread_ts: request.threadTs, permalink: request.permalink, round: request.round, automated_review: automated };
}
