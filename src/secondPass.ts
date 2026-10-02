import { Effect } from "effect";
import type { WebhookContext } from "./github.ts";
import { handleDelivery, matchRules } from "./handler.ts";
import { logger } from "./log.ts";
import { PullRequests } from "./pulls.ts";
import { SECOND_PASS_EVENT, SlackClient, slackDelivery, slackOrigin } from "./slack.ts";
import { Store } from "./store.ts";

const log = logger("slack");

/**
 * A "second pass" mention posted inside a review thread re-reviews that PR in
 * a new T3 thread. The PR comes from the run that started the thread (its
 * parent message), or from a PR link in the mention itself. Returns what to
 * tell the user when neither exists.
 */
export const resolveSecondPassTarget = (ctx: WebhookContext): Effect.Effect<string | null, never, Store> =>
  Effect.gen(function* () {
    if (ctx.pr_url) return null;
    const store = yield* Store;
    const parent = ctx.slack_thread_ts && ctx.slack_channel ? yield* store.runForSlackMessage(ctx.slack_channel, ctx.slack_thread_ts) : null;
    const pr = parent?.context;
    if (!pr?.pr_url || !pr.pr_number || !pr.repo) {
      return ctx.slack_thread_ts
        ? "This thread did not start from a PR review, so there is nothing to re-review. Include a PR link in the mention."
        : "Ask for a second pass inside the review's thread, or include a PR link in the mention.";
    }
    ctx.repo = pr.repo;
    ctx.pr_url = pr.pr_url;
    ctx.pr_number = pr.pr_number;
    return null;
  });

/**
 * Why a bot's post should not reach the rules, or null when it should. Our
 * own posts never do (the MCP tools already started their review), and other
 * bots' posts only when a rule accepting bots matches, so bot chatter in a
 * channel gets no ⏩.
 */
export const botPostIgnored = (event: string, ctx: WebhookContext): Effect.Effect<string | null, never, SlackClient | Store> =>
  Effect.gen(function* () {
    const slack = yield* SlackClient;
    const store = yield* Store;
    const own = yield* slack.botId.pipe(Effect.orElseSucceed(() => null));
    if (!own) return "posted by a bot, and this bot's own id is unknown (auth.test failed)";
    if (own === ctx.slack_bot_id) return "posted by this bot";
    if (matchRules(yield* store.listRules(), event, ctx).length === 0) return "posted by a bot; no rule accepting bots matches";
    return null;
  });

/** Turns one Socket Mode Events API payload into a delivery and starts matching rules. */
export const handleSlackEvent = Effect.fn("slack.handleEvent")(function* (payload: unknown) {
  const deliveryId = (payload as { event_id?: string }).event_id ?? crypto.randomUUID();
  const delivery = slackDelivery(payload);
  if ("ignored" in delivery) {
    yield* log.info("event ignored", { delivery: deliveryId, reason: delivery.ignored });
    return;
  }
  const { ctx } = delivery;
  // Before the bot check: a second pass names no repo until its thread does, and repo-scoped rules need one to match.
  const problem = delivery.event === SECOND_PASS_EVENT ? yield* resolveSecondPassTarget(ctx) : null;
  const botIgnored = ctx.slack_bot_id ? yield* botPostIgnored(delivery.event, ctx) : null;
  if (botIgnored) {
    yield* log.info("event ignored", { delivery: deliveryId, reason: botIgnored });
    return;
  }
  yield* log.info("event received", { delivery: deliveryId, event: delivery.event, channel: ctx.slack_channel, user: ctx.slack_user, pr: ctx.pr_url });

  if (problem) {
    yield* log.info("second pass has no PR to review", { delivery: deliveryId, reason: problem });
    const origin = slackOrigin(ctx);
    if (origin) {
      const slack = yield* SlackClient;
      yield* slack.reply(origin, problem).pipe(Effect.catch((error) => log.warn("reply failed", { delivery: deliveryId, error: error.message })));
    }
    return;
  }

  const pulls = yield* PullRequests;
  yield* handleDelivery({ deliveryId, ...delivery, complete: (ctx) => pulls.details(ctx) });
});
