import { changesRequestedStreak, watchCompletion } from "./completion.ts";
import type { WebhookContext } from "./github.ts";
import { openThread, resolveProject, type HandlerDeps } from "./handler.ts";
import { logger } from "./log.ts";
import type { Run } from "./rules.ts";
import { HANDOFF_EVENT } from "./shared.ts";
import { slackOrigin } from "./slack.ts";
import { renderTemplate } from "./template.ts";

const log = logger("handoff");

/**
 * Called when a review settles. When it is the Nth change request in a row
 * for its PR (N = `maxChangesRequestedRounds` in settings) automated review
 * of that PR pauses (see `pausedReview`) and this starts one more thread: a
 * handoff that explains why the PR is not converging, so a human can take
 * over. Runs exactly at N, so a "second pass" past the limit does not write a
 * second handoff. Slack-triggered PRs get told in their thread.
 */
export function handoffIfStuck(deps: HandlerDeps, review: Run): void {
  const ctx = review.context;
  const prNumber = ctx?.pr_number;
  if (!ctx || !review.repo || !prNumber) return;
  const limit = deps.store.getSettings().maxChangesRequestedRounds;
  if (limit <= 0) return;
  const rounds = changesRequestedStreak(deps.store.finishedRunsForPullRequest(review.repo, prNumber));
  if (rounds.length !== limit) return;

  const at = { repo: review.repo, pr: prNumber, rounds: rounds.length, review: review.id };
  log.warn("review stuck: pausing reviews and writing a handoff", at);
  const run = deps.store.recordRun({
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
  const tell = (text: string) => {
    if (!origin || !deps.slack) return;
    deps.slack.reply(origin, text).catch((error: unknown) => log.warn("slack reply failed", { ...at, error }));
  };
  tell(`Automated review paused: ${rounds.length} reviews in a row requested changes. Writing a handoff document; a "second pass" mention reviews anyway.`);

  void startHandoff(deps, review, ctx as WebhookContext, rounds).then(
    (result) => {
      log.info("handoff thread started", { ...at, thread: result.threadId });
      deps.store.updateRun(run.id, result);
      watchCompletion(deps, { ...run, threadId: result.threadId });
    },
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      log.error("handoff failed to start", { ...at, error: detail });
      deps.store.updateRun(run.id, { status: "failed", detail });
      tell(`Handoff not written: ${detail}`);
    },
  );
}

/** Opens the handoff thread in the project and workspace of the rule that ran the last review. */
async function startHandoff(deps: HandlerDeps, review: Run, ctx: WebhookContext, rounds: Run[]) {
  const rule = deps.store.getRule(review.ruleId);
  if (!rule) throw new Error(`rule "${review.ruleName}" no longer exists`);
  const project = resolveProject(rule, await deps.t3.projects(), ctx.repo);
  if (!project) throw new Error(`no T3 project for ${ctx.repo}`);
  return openThread(deps, rule, project, ctx, {
    title: `Handoff: ${ctx.pr_title ?? ctx.pr_url ?? ctx.repo}`,
    prompt: handoffPrompt(deps.store.getSettings().handoffPrompt, ctx, rounds),
  });
}

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
