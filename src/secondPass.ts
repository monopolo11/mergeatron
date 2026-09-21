import type { WebhookContext } from "./github.ts";
import { handleDelivery, type HandlerDeps } from "./handler.ts";
import { withPullRequestDetails } from "./pulls.ts";
import { SECOND_PASS_EVENT, slackDelivery, slackOrigin } from "./slack.ts";
import type { Store } from "./store.ts";

/**
 * A "second pass" mention posted inside a review thread re-reviews that PR in
 * a new T3 thread. The PR comes from the run that started the thread (its
 * parent message), or from a PR link in the mention itself. Returns what to
 * tell the user when neither exists.
 */
export function resolveSecondPassTarget(store: Store, ctx: WebhookContext): string | null {
  if (ctx.pr_url) return null;
  const parent = ctx.slack_thread_ts && ctx.slack_channel ? store.runForSlackMessage(ctx.slack_channel, ctx.slack_thread_ts) : null;
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
}

/** Turns one Socket Mode Events API payload into a delivery and starts matching rules. */
export function handleSlackEvent(deps: HandlerDeps, payload: unknown): void {
  const delivery = slackDelivery(payload);
  if (!delivery) return;
  const eventId = (payload as { event_id?: string }).event_id;

  if (delivery.event === SECOND_PASS_EVENT) {
    const problem = resolveSecondPassTarget(deps.store, delivery.ctx);
    if (problem) {
      const origin = slackOrigin(delivery.ctx);
      if (origin && deps.slack) {
        deps.slack.reply(origin, problem).catch((error: unknown) => console.warn("[slack] reply failed:", error instanceof Error ? error.message : error));
      }
      return;
    }
  }

  const result = handleDelivery(deps, { deliveryId: eventId ?? crypto.randomUUID(), ...delivery, complete: withPullRequestDetails });
  console.log(`[slack] ${result.event} ${delivery.ctx.slack_channel} -> ${result.matched.length} rule(s)`);
}
