import { pausedReview, watchCompletion, type CompletionDeps } from "./completion.ts";
import type { WebhookContext } from "./github.ts";
import type { Rule } from "./rules.ts";
import { logger } from "./log.ts";
import { HANDOFF_EVENT, SLACK_EVENT_PREFIX, type RunSource } from "./shared.ts";
import { SECOND_PASS_EVENT, slackOrigin } from "./slack.ts";
import type { Store } from "./store.ts";
import { renderTemplate } from "./template.ts";
import type { T3Project } from "./t3.ts";

/** One inbound event, already reduced to a rule key and template variables. */
export type Delivery = {
  deliveryId: string;
  /** Rule key: `pull_request.review_requested`, `slack.app_mention`, ... */
  event: string;
  ctx: WebhookContext;
  /**
   * Optional slow step that finishes the context before the thread starts,
   * off the webhook response path. Slack messages use it to fetch PR details.
   */
  complete?: (ctx: WebhookContext) => Promise<WebhookContext>;
};

/**
 * Reaction on a Slack message that was seen but deliberately not reviewed: no
 * rule matched, or a rule skipped it (own PR, no T3 project). Distinct from
 * the ❌ that marks a failure.
 */
const SKIPPED_REACTION = "fast_forward";

const log = logger("rules");

export type HandlerDeps = CompletionDeps;

/** Rules that apply to this delivery: event, repository, reviewer and channel filters all pass. */
export function matchRules(rules: Rule[], key: string, ctx: WebhookContext): Rule[] {
  return rules.filter((rule) => ruleMismatch(rule, key, ctx) === null);
}

/** Why a rule does not apply to this delivery, or null when it does. Logged for deliveries no rule wanted. */
export function ruleMismatch(rule: Rule, key: string, ctx: WebhookContext): string | null {
  if (!rule.enabled) return "disabled";
  if (!rule.events.includes(key)) return `listens to ${rule.events.join(", ")}`;
  if (rule.repos.length > 0 && !rule.repos.some((repo) => sameName(repo, ctx.repo))) {
    return `repo ${ctx.repo || "(none)"} not in ${rule.repos.join(", ")}`;
  }
  if (rule.reviewer && !sameName(rule.reviewer, ctx.requested_reviewer ?? "")) {
    return `requested reviewer ${ctx.requested_reviewer ?? "(none)"} is not ${rule.reviewer}`;
  }
  if (rule.channel && !sameName(rule.channel, ctx.slack_channel ?? "")) {
    return `channel ${ctx.slack_channel ?? "(none)"} is not ${rule.channel}`;
  }
  return null;
}

/** Explicit project first, otherwise the project whose git remote points at this repository. */
export function resolveProject(rule: Rule, projects: T3Project[], repo: string): T3Project | null {
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
 * Matches the delivery against the rules and starts one T3 thread per match.
 * Returns as soon as runs are recorded; context completion and thread
 * creation continue in the background so GitHub gets its response inside
 * its 10s timeout (Slack envelopes are acked before this runs).
 *
 * A PR gets one review at a time: while a run for it is still `started`,
 * further deliveries for that PR are recorded as skipped and point at the
 * running thread instead of opening another. A PR whose reviews keep
 * requesting changes (see `pausedReview`) is skipped too, until a human asks
 * for a "second pass" on Slack, which always reviews.
 */
export function handleDelivery(deps: HandlerDeps, delivery: Delivery) {
  const rules = deps.store.listRules();
  const candidates = matchRules(rules, delivery.event, delivery.ctx);
  const { repo, pr_number: prNumber } = delivery.ctx;
  const at = { delivery: delivery.deliveryId, event: delivery.event, repo: repo || undefined, pr: prNumber };
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
  const skipAll = (detail: string, thread: { threadId: string | null; threadUrl: string | null }, alreadyRunning: boolean) => {
    for (const rule of matched) {
      deps.store.recordRun({
        ruleId: rule.id,
        ruleName: rule.name,
        deliveryId: delivery.deliveryId,
        event: delivery.event,
        repo: delivery.ctx.repo,
        source: runSource(delivery.event),
        author: runAuthor(delivery.ctx),
        status: "skipped",
        detail,
        ...thread,
        context: delivery.ctx,
        result: null,
      });
    }
    notifySlack(deps, delivery.ctx, { status: "skipped", detail, alreadyRunning });
    return { event: delivery.event, repo: delivery.ctx.repo, matched: [] };
  };
  if (matched.length > 0 && repo && prNumber) {
    withPreviousReview(deps.store, delivery.ctx, repo, prNumber);
    const active = deps.store.activeRunForPullRequest(repo, prNumber);
    if (active) {
      log.info("skipped: review already running", { ...at, rules: matched.map((rule) => rule.name).join(", "), thread: active.threadId });
      return skipAll(`review already running for ${repo}#${prNumber} (${active.ruleName})`, { threadId: active.threadId, threadUrl: active.threadUrl }, true);
    }
    const paused = delivery.event === SECOND_PASS_EVENT ? null : pausedReview(deps.store, repo, prNumber);
    if (paused) {
      log.info("skipped: review paused", { ...at, rules: matched.map((rule) => rule.name).join(", "), rounds: paused.rounds, handoff: paused.handoff?.threadId });
      const detail = `automated review of ${repo}#${prNumber} is paused: ${paused.rounds} reviews in a row requested changes. See the handoff, or ask for a second pass to review anyway`;
      return skipAll(detail, { threadId: paused.handoff?.threadId ?? null, threadUrl: paused.handoff?.threadUrl ?? null }, false);
    }
  }
  // Shared by every matched rule; created lazily so unmatched deliveries cost nothing.
  let completed: Promise<WebhookContext> | null = null;
  const context = () => (completed ??= delivery.complete ? delivery.complete(delivery.ctx) : Promise.resolve(delivery.ctx));

  for (const rule of matched) {
    const run = deps.store.recordRun({
      ruleId: rule.id,
      ruleName: rule.name,
      deliveryId: delivery.deliveryId,
      event: delivery.event,
      repo: delivery.ctx.repo,
      source: runSource(delivery.event),
      author: runAuthor(delivery.ctx),
      status: "started",
      detail: "starting thread",
      threadId: null,
      threadUrl: null,
      context: delivery.ctx,
      result: null,
    });
    const runAt = { ...at, rule: rule.name, run: run.id };
    log.info("rule matched, starting thread", runAt);
    void context()
      .then((ctx) => {
        // Slack deliveries only learn the PR author once `complete` has run.
        deps.store.updateRun(run.id, { context: ctx, author: runAuthor(ctx) });
        return startThreadForRule(deps, rule, ctx);
      })
      .then(
        (result) => {
          log.info(`run ${result.status}`, { ...runAt, detail: result.detail, thread: result.threadId ?? undefined });
          deps.store.updateRun(run.id, result);
          if (result.status === "started") watchCompletion(deps, { ...run, threadId: result.threadId });
          notifySlack(deps, delivery.ctx, result);
        },
        (error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          log.error("run failed", { ...runAt, error: detail });
          deps.store.updateRun(run.id, { status: "failed", detail, threadId: null, threadUrl: null });
          notifySlack(deps, delivery.ctx, { status: "failed", detail });
        },
      );
  }

  return { event: delivery.event, repo: delivery.ctx.repo, matched: matched.map((rule) => rule.name) };
}

/** Adds `previous_result` / `previous_thread_url` from the last finished review of this PR, so re-reviews can build on it. */
function withPreviousReview(store: Store, ctx: WebhookContext, repo: string, prNumber: string): void {
  const previous = store.finishedRunsForPullRequest(repo, prNumber).find((run) => run.event !== HANDOFF_EVENT);
  if (!previous?.result) return;
  ctx.previous_result = previous.result;
  if (previous.threadUrl) ctx.previous_thread_url = previous.threadUrl;
}

async function startThreadForRule(deps: HandlerDeps, rule: Rule, ctx: WebhookContext) {
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
          : "no repository in the message and the rule has no T3 project",
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
 * Acknowledges a Slack-triggered run on the triggering message: eyes while it
 * runs, a threaded note if it never did, ⏩ when a rule skipped it and ❌ when
 * starting failed. "Already running" gets no reaction: nothing went wrong.
 * T3 thread links stay out of Slack.
 */
function notifySlack(
  deps: HandlerDeps,
  ctx: WebhookContext,
  result: { status: "started" | "skipped" | "failed"; detail: string; alreadyRunning?: boolean },
) {
  const origin = slackOrigin(ctx);
  if (!origin || !deps.slack) return;
  const slack = deps.slack;
  const action =
    result.status === "started"
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
  return event.startsWith(SLACK_EVENT_PREFIX) ? "slack" : "github";
}

/** PR or issue author the review is for; falls back to whoever caused the event. */
function runAuthor(ctx: WebhookContext): string | null {
  return ctx.pr_author ?? ctx.issue_author ?? ctx.sender ?? null;
}

function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
