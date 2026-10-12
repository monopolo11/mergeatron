import { Cause, Data, Effect } from "effect";
import { Background } from "./background.ts";
import { changesRequestedStreak, watchCompletion } from "./completion.ts";
import { errorMessage } from "./errors.ts";
import type { WebhookContext } from "./github.ts";
import { findProject, openThread } from "./handler.ts";
import { logger } from "./log.ts";
import type { Run } from "./rules.ts";
import { HANDOFF_EVENT } from "./shared.ts";
import { SlackClient, slackOrigin } from "./slack.ts";
import { Store } from "./store.ts";
import { renderTemplate } from "./template.ts";

const log = logger("handoff");

/** The handoff thread could not be opened: the review's rule or project is gone. */
export class HandoffError extends Data.TaggedError("HandoffError")<{ readonly message: string }> {}

/**
 * Called when a review settles. When it is the Nth change request in a row
 * for its PR (N = `maxChangesRequestedRounds` in settings) automated review
 * of that PR pauses (see `pausedReview`) and this starts one more thread: a
 * handoff that explains why the PR is not converging, so a human can take
 * over. Runs exactly at N, so a "second pass" past the limit does not write a
 * second handoff. Slack-triggered PRs get told in their thread.
 */
export const handoffIfStuck = Effect.fn("handoff.ifStuck")(function* (review: Run) {
  const ctx = review.context;
  const prNumber = ctx?.pr_number;
  if (!ctx || !review.repo || !prNumber) return;
  const store = yield* Store;
  const slack = yield* SlackClient;
  const background = yield* Background;
  const limit = (yield* store.getSettings()).maxChangesRequestedRounds;
  if (limit <= 0) return;
  const rounds = changesRequestedStreak(yield* store.finishedRunsForPullRequest(review.repo, prNumber));
  if (rounds.length !== limit) return;

  const at = { repo: review.repo, pr: prNumber, rounds: rounds.length, review: review.id };
  yield* log.warn("review stuck: pausing reviews and writing a handoff", at);
  const run = yield* store.recordRun({
    // Not a rule's run: the log shows it as "handoff", like "manual" for connection tests.
    ruleId: "handoff",
    ruleName: "handoff",
    deliveryId: crypto.randomUUID(),
    event: HANDOFF_EVENT,
    repo: review.repo,
    source: review.source,
    author: review.author,
    status: "started",
    detail: `${rounds.length} reviews in a row requested changes; writing the handoff`,
    threadId: null,
    threadUrl: null,
    context: ctx,
    result: null,
    action: null,
  });
  const origin = slackOrigin(ctx);
  const tell = (text: string) =>
    origin ? slack.reply(origin, text).pipe(Effect.catch((error) => log.warn("slack reply failed", { ...at, error: error.message }))) : Effect.void;
  yield* tell(`Automated review paused: ${rounds.length} reviews in a row requested changes. Writing a handoff document; a "second pass" mention reviews anyway.`);

  yield* background.fork(
    startHandoff(review, ctx as WebhookContext, rounds).pipe(
      Effect.flatMap((result) =>
        Effect.gen(function* () {
          yield* log.info("handoff thread started", { ...at, thread: result.threadId });
          yield* store.updateRun(run.id, result);
          yield* watchCompletion({ ...run, ...result });
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) return;
          const detail = errorMessage(Cause.squash(cause));
          yield* log.error("handoff failed to start", { ...at, error: detail });
          yield* store.updateRun(run.id, { status: "failed", detail });
          yield* tell(`Handoff not written: ${detail}`);
        }),
      ),
      Effect.withSpan("handoff.start", { attributes: at }),
    ),
  );
});

/** Opens the handoff thread in the project and workspace of the rule that ran the last review. */
const startHandoff = (review: Run, ctx: WebhookContext, rounds: Run[]) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const rule = yield* store.getRule(review.ruleId);
    if (!rule) return yield* Effect.fail(new HandoffError({ message: `rule "${review.ruleName}" no longer exists` }));
    const project = yield* findProject(rule, ctx.repo);
    if (!project) return yield* Effect.fail(new HandoffError({ message: `no T3 project for ${ctx.repo}` }));
    return yield* openThread(rule, project, ctx, {
      title: `Handoff: ${ctx.pr_title ?? ctx.pr_url ?? ctx.repo}`,
      prompt: handoffPrompt((yield* store.getSettings()).handoffPrompt, ctx, rounds),
    });
  });

/**
 * First message of the handoff thread: the template from Settings with the PR
 * variables plus `rounds` and `review_history` (the reports, oldest first).
 */
export function handoffPrompt(template: string, ctx: WebhookContext, rounds: Pick<Run, "ruleName" | "createdAt" | "threadUrl" | "result">[]): string {
  const review_history = rounds
    .toReversed()
    .map((run, index) => `## Round ${index + 1} (${run.createdAt.slice(0, 10)}, rule "${run.ruleName}")\n\n${run.result ?? "(no reply)"}`)
    .join("\n\n");
  return renderTemplate(template, { ...ctx, rounds: String(rounds.length), review_history });
}
