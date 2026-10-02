import { pausedReview, watchCompletion, type CompletionDeps } from "./completion.ts";
import type { WebhookContext } from "./github.ts";
import type { Rule, Run, RunAction } from "./rules.ts";
import { logger } from "./log.ts";
import { matchRules, ruleMismatch, sameName } from "./match.ts";
import { HANDOFF_EVENT, INBOX_EVENT_PREFIX, SLACK_EVENT_PREFIX, type RunSource } from "./shared.ts";
import { SECOND_PASS_EVENT, slackOrigin } from "./slack.ts";
import type { Store } from "./store.ts";
import { renderTemplate } from "./template.ts";
import type { T3Project } from "./t3.ts";

export { matchRules, ruleMismatch } from "./match.ts";

/** One inbound event, already reduced to a rule key and template variables. */
export type Delivery = {
  deliveryId: string;
  /** Rule key: `pull_request.review_requested`, `slack.app_mention`, `inbox.github.pull_request`, ... */
  event: string;
  ctx: WebhookContext;
  /**
   * Optional slow step that finishes the context before the thread starts,
   * off the webhook response path. Slack messages use it to fetch PR details.
   */
  complete?: (ctx: WebhookContext) => Promise<WebhookContext>;
  /** Trigger to record on the runs; derived from the event key when absent. */
  source?: RunSource;
  /** A human asked: review even when the PR's automated reviews are paused. */
  force?: boolean;
};

/**
 * Reaction on a Slack message that was seen but deliberately not reviewed: no
 * rule matched, or a rule skipped it (own PR, no T3 project). Distinct from
 * the ❌ that marks a failure.
 */
const SKIPPED_REACTION = "fast_forward";
/** Reaction while a Slack-triggered review waits for its rule's concurrency limit. */
const QUEUED_REACTION = "hourglass_flowing_sand";

const log = logger("rules");

export type HandlerDeps = CompletionDeps;

/** Explicit project first, otherwise the project whose git remote points at this repository. */
export function resolveProject(rule: Pick<Rule, "projectId">, projects: T3Project[], repo: string): T3Project | null {
  if (rule.projectId) return projects.find((project) => project.id === rule.projectId) ?? null;
  return projects.find((project) => hostsRepository(project, repo)) ?? null;
}

/** True when the project's git remote is this GitHub repository (`owner/name`). */
export function hostsRepository(project: T3Project, repo: string): boolean {
  const identity = project.repositoryIdentity;
  return (
    identity?.provider === "github" &&
    !!identity.owner &&
    !!identity.name &&
    sameName(`${identity.owner}/${identity.name}`, repo)
  );
}

/**
 * Matches the delivery against the rules and starts one T3 thread per match
 * (see `runRules`). Returns as soon as runs are recorded; context completion
 * and thread creation continue in the background so GitHub gets its response
 * inside its 10s timeout (Slack envelopes are acked before this runs).
 */
export function handleDelivery(deps: HandlerDeps, delivery: Delivery) {
  const rules = deps.store.listRules();
  const candidates = matchRules(rules, delivery.event, delivery.ctx);
  const at = { delivery: delivery.deliveryId, event: delivery.event, repo: delivery.ctx.repo || undefined, pr: delivery.ctx.pr_number };
  if (candidates.length === 0) {
    const why = rules.map((rule) => `${rule.name}: ${ruleMismatch(rule, delivery.event, delivery.ctx)}`).join("; ");
    log.info("no rule matched", { ...at, why: why || "no rules configured" });
    // Slack only: tell the poster the message was seen but no rule wanted it.
    const origin = slackOrigin(delivery.ctx);
    if (origin && deps.slack) {
      deps.slack.react(origin, SKIPPED_REACTION).catch((error: unknown) => log.warn("slack react failed", { ...at, error }));
    }
    return { event: delivery.event, repo: delivery.ctx.repo, matched: [] };
  }
  const matched = candidates.filter((rule) => !deps.store.hasRun(delivery.deliveryId, rule.id));
  if (matched.length < candidates.length) {
    const handled = candidates.filter((rule) => !matched.includes(rule)).map((rule) => rule.name);
    log.info("redelivery ignored: rule already ran for this delivery", { ...at, rules: handled.join(", ") });
  }
  const runs = runRules(deps, delivery, matched);
  return { event: delivery.event, repo: delivery.ctx.repo, matched: runs.filter((run) => run.status === "started" || run.status === "queued").map((run) => run.ruleName) };
}

/**
 * Records one run per rule and starts its thread. The rules are already
 * matched and deduped; inbox automations and manual dispatches call this
 * directly with the rule (or a one-off rule) they want to run.
 *
 * A PR or issue gets one thread at a time: while a run for it is still
 * `started` or `queued`, further deliveries are recorded as skipped and point
 * at that thread instead of opening another. A PR whose reviews keep
 * requesting changes (see `pausedReview`) is skipped too, unless the delivery
 * is forced: a "second pass" on Slack or a dispatch from the inbox.
 *
 * Each rule runs at most `maxConcurrent` threads at once: past that a match
 * is recorded as `queued` with the rule's action frozen on it, and
 * `startQueued` starts it when a thread of the rule settles.
 */
export function runRules(deps: HandlerDeps, delivery: Delivery, matched: Rule[]): Run[] {
  if (matched.length === 0) return [];
  const { repo, pr_number: prNumber } = delivery.ctx;
  const source = delivery.source ?? runSource(delivery.event);
  const at = { delivery: delivery.deliveryId, event: delivery.event, repo: repo || undefined, pr: prNumber };
  const record = (rule: Rule, status: Run["status"], detail: string, thread: { threadId: string | null; threadUrl: string | null }, action: RunAction | null = null) =>
    deps.store.recordRun({
      ruleId: rule.id,
      ruleName: rule.name,
      deliveryId: delivery.deliveryId,
      event: delivery.event,
      repo: delivery.ctx.repo,
      source,
      author: runAuthor(delivery.ctx),
      status,
      detail,
      ...thread,
      context: delivery.ctx,
      result: null,
      action,
    });
  const skipAll = (detail: string, thread: { threadId: string | null; threadUrl: string | null }, alreadyRunning: boolean) => {
    const runs = matched.map((rule) => record(rule, "skipped", detail, thread));
    notifySlack(deps, delivery.ctx, { status: "skipped", detail, alreadyRunning });
    return runs;
  };
  const what = repo && prNumber ? `${repo}#${prNumber}` : (delivery.ctx.issue_url ?? null);
  if (what) {
    if (repo && prNumber) withPreviousReview(deps.store, delivery.ctx, repo, prNumber);
    const active = repo && prNumber ? deps.store.activeRunForPullRequest(repo, prNumber) : deps.store.activeRunForIssue(what);
    if (active) {
      log.info("skipped: thread already running", { ...at, rules: matched.map((rule) => rule.name).join(", "), thread: active.threadId });
      return skipAll(`review already running for ${what} (${active.ruleName})`, { threadId: active.threadId, threadUrl: active.threadUrl }, true);
    }
    const force = delivery.force || delivery.event === SECOND_PASS_EVENT;
    const paused = force || !(repo && prNumber) ? null : pausedReview(deps.store, repo, prNumber);
    if (paused) {
      log.info("skipped: review paused", { ...at, rules: matched.map((rule) => rule.name).join(", "), rounds: paused.rounds, handoff: paused.handoff?.threadId });
      const detail = `automated review of ${what} is paused: ${paused.rounds} reviews in a row requested changes. See the handoff, or ask for a second pass to review anyway`;
      return skipAll(detail, { threadId: paused.handoff?.threadId ?? null, threadUrl: paused.handoff?.threadUrl ?? null }, false);
    }
  }
  // Shared by every matched rule; created lazily so unmatched deliveries cost nothing.
  let completed: Promise<WebhookContext> | null = null;
  const context = () => (completed ??= delivery.complete ? delivery.complete(delivery.ctx) : Promise.resolve(delivery.ctx));

  return matched.map((rule) => {
    const running = rule.maxConcurrent > 0 ? deps.store.countRuns(rule.id, "started") : 0;
    if (rule.maxConcurrent > 0 && running >= rule.maxConcurrent) {
      const detail = `queued: ${running} of ${rule.maxConcurrent} threads running`;
      const run = record(rule, "queued", detail, { threadId: null, threadUrl: null }, actionOf(rule));
      log.info("rule matched, queued", { ...at, rule: rule.name, run: run.id, running, limit: rule.maxConcurrent });
      // Complete the context now so the queued start has everything, and the author shows while it waits.
      void context().then(
        (ctx) => deps.store.updateRun(run.id, { context: ctx, author: runAuthor(ctx) }),
        (error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          log.error("queued run failed", { ...at, rule: rule.name, run: run.id, error: detail });
          deps.store.updateRun(run.id, { status: "failed", detail });
        },
      );
      notifySlack(deps, delivery.ctx, { status: "queued", detail });
      return run;
    }
    const run = record(rule, "started", "starting thread", { threadId: null, threadUrl: null });
    const runAt = { ...at, rule: rule.name, run: run.id };
    log.info("rule matched, starting thread", runAt);
    void context()
      .then((ctx) => {
        // Slack deliveries only learn the PR author once `complete` has run.
        deps.store.updateRun(run.id, { context: ctx, author: runAuthor(ctx) });
        return startThreadForRule(deps, rule, ctx);
      })
      .then(
        (result) => finishStart(deps, run, delivery.ctx, result, runAt),
        (error: unknown) => failStart(deps, run, delivery.ctx, error, runAt),
      );
    return run;
  });
}

/** Records how a thread start went and watches it; anything but `started` frees capacity for a queued run. */
function finishStart(deps: HandlerDeps, run: Run, ctx: WebhookContext, result: Awaited<ReturnType<typeof startThreadForRule>>, at: Record<string, unknown>) {
  log.info(`run ${result.status}`, { ...at, detail: result.detail, thread: result.threadId ?? undefined });
  deps.store.updateRun(run.id, result);
  if (result.status === "started") watchCompletion(deps, { id: run.id, threadId: result.threadId, createdAt: new Date().toISOString() });
  else deps.onCapacity?.(run.ruleId);
  notifySlack(deps, ctx, result);
}

function failStart(deps: HandlerDeps, run: Run, ctx: WebhookContext, error: unknown, at: Record<string, unknown>) {
  const detail = error instanceof Error ? error.message : String(error);
  log.error("run failed", { ...at, error: detail });
  deps.store.updateRun(run.id, { status: "failed", detail, threadId: null, threadUrl: null });
  deps.onCapacity?.(run.ruleId);
  notifySlack(deps, ctx, { status: "failed", detail });
}

function actionOf(rule: Rule): RunAction {
  const { name, skipSelfReview, projectId, workspace, model, prompt, maxConcurrent } = rule;
  return { name, skipSelfReview, projectId, workspace, model, prompt, maxConcurrent };
}

/**
 * Starts queued runs of a rule while it has capacity, oldest first. Wired to
 * `onCapacity`, so it runs whenever a thread of the rule settles or fails to
 * start, after a limit is raised, and on boot. The limit is the rule's current
 * one, or the frozen action's for dispatches, whose rule is not stored. A
 * queued run whose PR or issue got a thread meanwhile is skipped.
 */
export function startQueued(deps: HandlerDeps, ruleId: string): void {
  for (;;) {
    const next = deps.store.oldestQueuedRun(ruleId);
    if (!next) return;
    const limit = deps.store.getRule(ruleId)?.maxConcurrent ?? next.action?.maxConcurrent ?? 0;
    if (limit > 0 && deps.store.countRuns(ruleId, "started") >= limit) return;
    const ctx = next.context as WebhookContext | null;
    const action = next.action;
    const at = { run: next.id, rule: next.ruleName, delivery: next.deliveryId };
    if (!ctx || !action) {
      log.error("queued run has no context or action", at);
      deps.store.updateRun(next.id, { status: "failed", detail: "queued run lost its context" });
      continue;
    }
    const { repo, pr_number: prNumber } = ctx;
    const running =
      repo && prNumber
        ? deps.store.activeRunForPullRequest(repo, prNumber, ["started"])
        : ctx.issue_url
          ? deps.store.activeRunForIssue(ctx.issue_url, ["started"])
          : null;
    if (running) {
      const what = repo && prNumber ? `${repo}#${prNumber}` : ctx.issue_url;
      log.info("queued run skipped: thread already running", { ...at, thread: running.threadId });
      deps.store.updateRun(next.id, { status: "skipped", detail: `review already running for ${what} (${running.ruleName})`, threadId: running.threadId, threadUrl: running.threadUrl });
      continue;
    }
    deps.store.updateRun(next.id, { status: "started", detail: "starting thread" });
    log.info("queued run starting", at);
    const origin = slackOrigin(ctx);
    if (origin && deps.slack) deps.slack.unreact(origin, QUEUED_REACTION).catch(() => {});
    void startThreadForRule(deps, action, ctx).then(
      (result) => finishStart(deps, next, ctx, result, at),
      (error: unknown) => failStart(deps, next, ctx, error, at),
    );
  }
}

/** Adds `previous_result` / `previous_thread_url` from the last finished review of this PR, so re-reviews can build on it. */
function withPreviousReview(store: Store, ctx: WebhookContext, repo: string, prNumber: string): void {
  const previous = store.finishedRunsForPullRequest(repo, prNumber).find((run) => run.event !== HANDOFF_EVENT);
  if (!previous?.result) return;
  ctx.previous_result = previous.result;
  if (previous.threadUrl) ctx.previous_thread_url = previous.threadUrl;
}

async function startThreadForRule(deps: HandlerDeps, rule: RunAction, ctx: WebhookContext) {
  const settings = deps.store.getSettings();
  if (rule.skipSelfReview && ctx.pr_author && settings.githubLogin && sameName(ctx.pr_author, settings.githubLogin)) {
    return skipped(`PR by ${ctx.pr_author} is your own; rule skips self review`);
  }

  const project = resolveProject(rule, await deps.t3.projects(), ctx.repo);
  if (!project) {
    return skipped(
      rule.projectId
        ? `T3 project ${rule.projectId} no longer exists`
        : ctx.repo
          ? `no T3 project has a git remote for ${ctx.repo}`
          : "no repository to match a T3 project by; pick a project in the rule",
    );
  }

  return openThread(deps, rule, project, ctx, {
    title: `${rule.name}: ${ctx.pr_title ?? ctx.issue_title ?? ctx.slack_text ?? ctx.repo}`,
    prompt: renderTemplate(rule.prompt, ctx),
  });
}

/**
 * Starts a T3 thread for the PR (or issue) in `ctx`, with the rule's workspace
 * and model. Shared by reviews and the handoff written when reviews stall.
 */
export async function openThread(
  deps: Pick<HandlerDeps, "store" | "t3">,
  rule: Pick<Rule, "workspace" | "model">,
  project: T3Project,
  ctx: WebhookContext,
  message: { title: string; prompt: string },
) {
  const settings = deps.store.getSettings();
  const prNumber = ctx.pr_number ? Number(ctx.pr_number) : null;
  const baseBranch = ctx.pr_head ?? ctx.default_branch ?? null;
  const worktree = rule.workspace === "worktree";

  const thread = await deps.t3.startThread({
    project,
    title: message.title.slice(0, 120),
    prompt: message.prompt,
    modelSelection: rule.model ?? project.defaultModelSelection ?? settings.model,
    runtimeMode: settings.runtimeMode,
    baseBranch,
    worktree,
    // T3 derives the legacy PR field from the project's remote and crashes the
    // thread snapshot when the link's repository is not the project's, so only
    // link when the project really is this GitHub repository.
    pullRequest:
      prNumber !== null && ctx.pr_url && hostsRepository(project, ctx.repo)
        ? { repository: ctx.repo, number: prNumber, url: ctx.pr_url }
        : null,
  });

  return {
    status: "started" as const,
    detail: worktree && baseBranch ? `worktree from origin/${baseBranch}` : `checkout ${project.workspaceRoot}`,
    ...thread,
  };
}

/**
 * Acknowledges a Slack-triggered run on the triggering message: ⏳ while it
 * waits for capacity, eyes while it runs, a threaded note if it never did, ⏩
 * when a rule skipped it and ❌ when starting failed. "Already running" gets
 * no reaction: nothing went wrong. T3 thread links stay out of Slack.
 */
function notifySlack(
  deps: HandlerDeps,
  ctx: WebhookContext,
  result: { status: "queued" | "started" | "skipped" | "failed"; detail: string; alreadyRunning?: boolean },
) {
  const origin = slackOrigin(ctx);
  if (!origin || !deps.slack) return;
  const slack = deps.slack;
  const action =
    result.status === "queued"
      ? slack.react(origin, QUEUED_REACTION)
      : result.status === "started"
      ? slack.react(origin, "eyes")
      : result.alreadyRunning
        ? slack.reply(origin, `Review not started: ${result.detail}.`)
        : slack
            .reply(origin, `Review not started: ${result.detail}`)
            .then(() => slack.react(origin, result.status === "skipped" ? SKIPPED_REACTION : "x"));
  action.catch((error: unknown) => log.warn("slack notify failed", { channel: origin.channel, ts: origin.ts, error }));
}

function skipped(detail: string) {
  return { status: "skipped" as const, detail, threadId: null, threadUrl: null };
}

/** Trigger that produced a delivery, from its rule key. */
function runSource(event: string): RunSource {
  return event.startsWith(SLACK_EVENT_PREFIX) ? "slack" : event.startsWith(INBOX_EVENT_PREFIX) ? "poll" : "github";
}

/** PR or issue author the review is for; falls back to whoever caused the event. */
function runAuthor(ctx: WebhookContext): string | null {
  return ctx.pr_author ?? ctx.issue_author ?? ctx.sender ?? null;
}
