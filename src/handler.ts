import { Cause, Effect, Metric, Queue, Semaphore } from "effect";
import { Background, RunEvents } from "./background.ts";
import { pausedReview, watchCompletion, type CompletionServices } from "./completion.ts";
import { errorMessage } from "./errors.ts";
import type { WebhookContext } from "./github.ts";
import { logger } from "./log.ts";
import { matchRules, ruleMismatch, sameName } from "./match.ts";
import type { Rule, Run, RunAction } from "./rules.ts";
import { HANDOFF_EVENT, INBOX_EVENT_PREFIX, SLACK_EVENT_PREFIX, type RunSource } from "./shared.ts";
import { SECOND_PASS_EVENT, SlackClient, slackOrigin } from "./slack.ts";
import { Store } from "./store.ts";
import { T3, type T3Error, type T3Project } from "./t3.ts";
import { renderTemplate } from "./template.ts";

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
  complete?: (ctx: WebhookContext) => Effect.Effect<WebhookContext>;
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

/** Services the handler runs with: the store, T3, Slack and the background supervision the watchers need. */
export type HandlerServices = CompletionServices;

const deliveries = Metric.counter("orchestrator_deliveries_total", { incremental: true, description: "Inbound events that reached the rules, by trigger" });
const runsRecorded = Metric.counter("orchestrator_runs_total", { incremental: true, description: "Runs recorded, by initial status" });

/**
 * Queue decisions (count the rule's running threads, record the run, start
 * the next queued one) happen one at a time, so two deliveries deciding
 * together never overshoot a rule's limit.
 */
const scheduling = Semaphore.makeUnsafe(1);

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
 * and thread creation continue in background fibers so GitHub gets its
 * response inside its 10s timeout (Slack envelopes are acked before this runs).
 */
export const handleDelivery = Effect.fn("handler.handleDelivery")(function* (delivery: Delivery) {
  const store = yield* Store;
  const slack = yield* SlackClient;
  yield* Metric.update(Metric.withAttributes(deliveries, { source: delivery.source ?? runSource(delivery.event) }), 1);
  yield* Effect.annotateCurrentSpan({ delivery: delivery.deliveryId, event: delivery.event });
  const rules = yield* store.listRules();
  const candidates = matchRules(rules, delivery.event, delivery.ctx);
  const at = { delivery: delivery.deliveryId, event: delivery.event, repo: delivery.ctx.repo || undefined, pr: delivery.ctx.pr_number };
  if (candidates.length === 0) {
    const why = rules.map((rule) => `${rule.name}: ${ruleMismatch(rule, delivery.event, delivery.ctx)}`).join("; ");
    yield* log.info("no rule matched", { ...at, why: why || "no rules configured" });
    // Slack only: tell the poster the message was seen but no rule wanted it.
    const origin = slackOrigin(delivery.ctx);
    if (origin) yield* slack.react(origin, SKIPPED_REACTION).pipe(Effect.catch((error) => log.warn("slack react failed", { ...at, error: error.message })));
    return { event: delivery.event, repo: delivery.ctx.repo, matched: [] as string[] };
  }
  const matched: Rule[] = [];
  for (const rule of candidates) if (!(yield* store.hasRun(delivery.deliveryId, rule.id))) matched.push(rule);
  if (matched.length < candidates.length) {
    const handled = candidates.filter((rule) => !matched.includes(rule)).map((rule) => rule.name);
    yield* log.info("redelivery ignored: rule already ran for this delivery", { ...at, rules: handled.join(", ") });
  }
  const runs = yield* runRules(delivery, matched);
  return { event: delivery.event, repo: delivery.ctx.repo, matched: runs.filter((run) => run.status === "started" || run.status === "queued").map((run) => run.ruleName) };
});

type Thread = { threadId: string | null; threadUrl: string | null };
const NO_THREAD: Thread = { threadId: null, threadUrl: null };

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
export const runRules = Effect.fn("handler.runRules")(function* (delivery: Delivery, matched: Rule[]) {
  if (matched.length === 0) return [] as Run[];
  const store = yield* Store;
  const background = yield* Background;
  const { repo, pr_number: prNumber } = delivery.ctx;
  const source = delivery.source ?? runSource(delivery.event);
  const at = { delivery: delivery.deliveryId, event: delivery.event, repo: repo || undefined, pr: prNumber };
  const record = (rule: Rule, status: Run["status"], detail: string, thread: Thread, action: RunAction | null = null) =>
    store
      .recordRun({
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
      })
      .pipe(Effect.tap(() => Metric.update(Metric.withAttributes(runsRecorded, { status }), 1)));
  const skipAll = (detail: string, thread: Thread, alreadyRunning: boolean) =>
    Effect.gen(function* () {
      const runs = yield* Effect.forEach(matched, (rule) => record(rule, "skipped", detail, thread));
      yield* notifySlack(delivery.ctx, { status: "skipped", detail, alreadyRunning });
      return runs;
    });

  const what = repo && prNumber ? `${repo}#${prNumber}` : (delivery.ctx.issue_url ?? null);
  if (what) {
    if (repo && prNumber) yield* withPreviousReview(delivery.ctx, repo, prNumber);
    const active = repo && prNumber ? yield* store.activeRunForPullRequest(repo, prNumber) : yield* store.activeRunForIssue(what);
    if (active) {
      yield* log.info("skipped: thread already running", { ...at, rules: matched.map((rule) => rule.name).join(", "), thread: active.threadId });
      return yield* skipAll(`review already running for ${what} (${active.ruleName})`, { threadId: active.threadId, threadUrl: active.threadUrl }, true);
    }
    const force = delivery.force || delivery.event === SECOND_PASS_EVENT;
    const paused = force || !(repo && prNumber) ? null : yield* pausedReview(repo, prNumber);
    if (paused) {
      yield* log.info("skipped: review paused", { ...at, rules: matched.map((rule) => rule.name).join(", "), rounds: paused.rounds, handoff: paused.handoff?.threadId });
      const detail = `automated review of ${what} is paused: ${paused.rounds} reviews in a row requested changes. See the handoff, or ask for a second pass to review anyway`;
      return yield* skipAll(detail, { threadId: paused.handoff?.threadId ?? null, threadUrl: paused.handoff?.threadUrl ?? null }, false);
    }
  }

  // Shared by every matched rule and evaluated once, lazily: unmatched deliveries cost nothing.
  const context = yield* Effect.cached(delivery.complete ? delivery.complete(delivery.ctx) : Effect.succeed(delivery.ctx));

  const runs: Run[] = [];
  for (const rule of matched) {
    const decision = yield* Semaphore.withPermits(scheduling, 1)(
      Effect.gen(function* () {
        const running = rule.maxConcurrent > 0 ? yield* store.countRuns(rule.id, "started") : 0;
        if (rule.maxConcurrent > 0 && running >= rule.maxConcurrent) {
          const detail = `queued: ${running} of ${rule.maxConcurrent} threads running`;
          return { queued: true as const, running, run: yield* record(rule, "queued", detail, NO_THREAD, actionOf(rule)) };
        }
        return { queued: false as const, running, run: yield* record(rule, "started", "starting thread", NO_THREAD) };
      }),
    );
    const run = decision.run;
    const runAt = { ...at, rule: rule.name, run: run.id };
    if (decision.queued) {
      yield* log.info("rule matched, queued", { ...runAt, running: decision.running, limit: rule.maxConcurrent });
      // Complete the context now so the queued start has everything, and the author shows while it waits.
      yield* background.fork(Effect.flatMap(context, (ctx) => store.updateRun(run.id, { context: ctx, author: runAuthor(ctx) })));
      yield* notifySlack(delivery.ctx, { status: "queued", detail: run.detail });
    } else {
      yield* log.info("rule matched, starting thread", runAt);
      yield* background.fork(
        Effect.gen(function* () {
          // Slack deliveries only learn the PR author once `complete` has run.
          const ctx = yield* context;
          yield* store.updateRun(run.id, { context: ctx, author: runAuthor(ctx) });
          const result = yield* startThreadForRule(rule, ctx);
          yield* finishStart(run, delivery.ctx, result, runAt);
        }).pipe(
          Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : failStart(run, delivery.ctx, Cause.squash(cause), runAt))),
          Effect.withSpan("handler.startThread", { attributes: { rule: rule.name, run: run.id } }),
        ),
      );
    }
    runs.push(run);
  }
  return runs;
});

type StartResult =
  | { status: "started"; detail: string; threadId: string; threadUrl: string }
  | { status: "skipped"; detail: string; threadId: null; threadUrl: null };

/** Records how a thread start went and watches it; anything but `started` frees capacity for a queued run. */
const finishStart = (run: Run, ctx: WebhookContext, result: StartResult, at: Record<string, unknown>) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const events = yield* RunEvents;
    yield* log.info(`run ${result.status}`, { ...at, detail: result.detail, thread: result.threadId ?? undefined });
    yield* store.updateRun(run.id, result);
    if (result.status === "started") yield* watchCompletion({ id: run.id, threadId: result.threadId, createdAt: new Date().toISOString() });
    else yield* Queue.offer(events, { _tag: "Capacity", ruleId: run.ruleId });
    yield* notifySlack(ctx, result);
  });

const failStart = (run: Run, ctx: WebhookContext, error: unknown, at: Record<string, unknown>) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const events = yield* RunEvents;
    const detail = errorMessage(error);
    yield* log.error("run failed", { ...at, error: detail });
    yield* store.updateRun(run.id, { status: "failed", detail, threadId: null, threadUrl: null });
    yield* Queue.offer(events, { _tag: "Capacity", ruleId: run.ruleId });
    yield* notifySlack(ctx, { status: "failed", detail });
  });

function actionOf(rule: Rule): RunAction {
  const { name, skipSelfReview, projectId, workspace, model, prompt, maxConcurrent } = rule;
  return { name, skipSelfReview, projectId, workspace, model, prompt, maxConcurrent };
}

/**
 * Starts queued runs of a rule while it has capacity, oldest first. The
 * supervisor calls it whenever a thread of the rule settles or fails to
 * start; the API calls it after a limit is raised, and startup for every
 * rule with queued runs. The limit is the rule's current one, or the frozen
 * action's for dispatches, whose rule is not stored. A queued run whose PR or
 * issue got a thread meanwhile is skipped.
 */
export const startQueued = Effect.fn("handler.startQueued")(function* (ruleId: string) {
  const store = yield* Store;
  const slack = yield* SlackClient;
  const background = yield* Background;
  yield* Semaphore.withPermits(scheduling, 1)(
    Effect.gen(function* () {
      for (;;) {
        const next = yield* store.oldestQueuedRun(ruleId);
        if (!next) return;
        const limit = (yield* store.getRule(ruleId))?.maxConcurrent ?? next.action?.maxConcurrent ?? 0;
        if (limit > 0 && (yield* store.countRuns(ruleId, "started")) >= limit) return;
        const ctx = next.context as WebhookContext | null;
        const action = next.action;
        const at = { run: next.id, rule: next.ruleName, delivery: next.deliveryId };
        if (!ctx || !action) {
          yield* log.error("queued run has no context or action", at);
          yield* store.updateRun(next.id, { status: "failed", detail: "queued run lost its context" });
          continue;
        }
        const { repo, pr_number: prNumber } = ctx;
        const running =
          repo && prNumber
            ? yield* store.activeRunForPullRequest(repo, prNumber, ["started"])
            : ctx.issue_url
              ? yield* store.activeRunForIssue(ctx.issue_url, ["started"])
              : null;
        if (running) {
          const what = repo && prNumber ? `${repo}#${prNumber}` : ctx.issue_url;
          yield* log.info("queued run skipped: thread already running", { ...at, thread: running.threadId });
          yield* store.updateRun(next.id, {
            status: "skipped",
            detail: `review already running for ${what} (${running.ruleName})`,
            threadId: running.threadId,
            threadUrl: running.threadUrl,
          });
          continue;
        }
        yield* store.updateRun(next.id, { status: "started", detail: "starting thread" });
        yield* log.info("queued run starting", at);
        const origin = slackOrigin(ctx);
        if (origin) yield* Effect.ignore(slack.unreact(origin, QUEUED_REACTION));
        yield* background.fork(
          startThreadForRule(action, ctx).pipe(
            Effect.flatMap((result) => finishStart(next, ctx, result, at)),
            Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : failStart(next, ctx, Cause.squash(cause), at))),
            Effect.withSpan("handler.startThread", { attributes: { rule: next.ruleName, run: next.id } }),
          ),
        );
      }
    }),
  );
});

/** Adds `previous_result` / `previous_thread_url` from the last finished review of this PR, so re-reviews can build on it. */
const withPreviousReview = (ctx: WebhookContext, repo: string, prNumber: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const previous = (yield* store.finishedRunsForPullRequest(repo, prNumber)).find((run) => run.event !== HANDOFF_EVENT);
    if (!previous?.result) return;
    ctx.previous_result = previous.result;
    if (previous.threadUrl) ctx.previous_thread_url = previous.threadUrl;
  });

const startThreadForRule = (rule: RunAction, ctx: WebhookContext): Effect.Effect<StartResult, T3Error, Store | T3> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const t3 = yield* T3;
    const settings = yield* store.getSettings();
    if (rule.skipSelfReview && ctx.pr_author && settings.githubLogin && sameName(ctx.pr_author, settings.githubLogin)) {
      return skipped(`PR by ${ctx.pr_author} is your own; rule skips self review`);
    }

    const project = resolveProject(rule, yield* t3.projects(), ctx.repo);
    if (!project) {
      return skipped(
        rule.projectId
          ? `T3 project ${rule.projectId} no longer exists`
          : ctx.repo
            ? `no T3 project has a git remote for ${ctx.repo}`
            : "no repository to match a T3 project by; pick a project in the rule",
      );
    }

    return yield* openThread(rule, project, ctx, {
      title: `${rule.name}: ${ctx.pr_title ?? ctx.issue_title ?? ctx.slack_text ?? ctx.repo}`,
      prompt: renderTemplate(rule.prompt, ctx),
    });
  });

/**
 * Starts a T3 thread for the PR (or issue) in `ctx`, with the rule's workspace
 * and model. Shared by reviews and the handoff written when reviews stall.
 */
export const openThread = (
  rule: Pick<Rule, "workspace" | "model">,
  project: T3Project,
  ctx: WebhookContext,
  message: { title: string; prompt: string },
): Effect.Effect<Extract<StartResult, { status: "started" }>, T3Error, Store | T3> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const t3 = yield* T3;
    const settings = yield* store.getSettings();
    const prNumber = ctx.pr_number ? Number(ctx.pr_number) : null;
    const baseBranch = ctx.pr_head ?? ctx.default_branch ?? null;
    const worktree = rule.workspace === "worktree";

    const thread = yield* t3.startThread({
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
  });

/**
 * Acknowledges a Slack-triggered run on the triggering message: ⏳ while it
 * waits for capacity, eyes while it runs, a threaded note if it never did, ⏩
 * when a rule skipped it and ❌ when starting failed. "Already running" gets
 * no reaction: nothing went wrong. T3 thread links stay out of Slack.
 */
const notifySlack = (
  ctx: WebhookContext,
  result: { status: "queued" | "started" | "skipped" | "failed"; detail: string; alreadyRunning?: boolean },
): Effect.Effect<void, never, SlackClient> =>
  Effect.gen(function* () {
    const origin = slackOrigin(ctx);
    if (!origin) return;
    const slack = yield* SlackClient;
    const action =
      result.status === "queued"
        ? slack.react(origin, QUEUED_REACTION)
        : result.status === "started"
          ? slack.react(origin, "eyes")
          : result.alreadyRunning
            ? slack.reply(origin, `Review not started: ${result.detail}.`)
            : Effect.andThen(slack.reply(origin, `Review not started: ${result.detail}`), slack.react(origin, result.status === "skipped" ? SKIPPED_REACTION : "x"));
    yield* action.pipe(Effect.catch((error) => log.warn("slack notify failed", { channel: origin.channel, ts: origin.ts, error: error.message })));
  });

function skipped(detail: string): StartResult {
  return { status: "skipped", detail, threadId: null, threadUrl: null };
}

/** Trigger that produced a delivery, from its rule key. */
function runSource(event: string): RunSource {
  return event.startsWith(SLACK_EVENT_PREFIX) ? "slack" : event.startsWith(INBOX_EVENT_PREFIX) ? "poll" : "github";
}

/** PR or issue author the review is for; falls back to whoever caused the event. */
function runAuthor(ctx: WebhookContext): string | null {
  return ctx.pr_author ?? ctx.issue_author ?? ctx.sender ?? null;
}
