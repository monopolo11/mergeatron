import { Cause, Clock, Effect, Metric, Queue, Schedule, Semaphore } from "effect";
import { Background, RunEvents } from "./background.ts";
import { pausedReview, watchCompletion, type CompletionServices } from "./completion.ts";
import { errorMessage } from "./errors.ts";
import type { WebhookContext } from "./github.ts";
import { logger } from "./log.ts";
import { matchRules, ruleMismatch, sameName } from "./match.ts";
import type { PromptRef, Rule, Run, RunAction, Settings } from "./rules.ts";
import { CUSTOM_WEBHOOK_EVENT_PREFIX, HANDOFF_EVENT, INBOX_EVENT_PREFIX, SLACK_EVENT_PREFIX, reasoningOf, type RunSource } from "./shared.ts";
import { SECOND_PASS_EVENT, SlackClient, slackOrigin } from "./slack.ts";
import { Store } from "./store.ts";
import { T3, type T3Error, type T3HttpError, type T3Project } from "./t3.ts";
import { joinPrompts, renderTemplate } from "./template.ts";

export { matchRules, ruleMismatch } from "./match.ts";

/** One inbound event, already reduced to a rule key and template variables. */
export type Delivery = {
  deliveryId: string;
  /** Rule key: `pull_request.review_requested`, `slack.app_mention`, `inbox.github.pull_request`, `webhook.<slug>`, ... */
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
 * the ❌ that marks a failure. The `skip` emoji replaces ⏩ when the
 * `skipReaction` setting is on.
 */
const skippedReaction = (settings: Pick<Settings, "skipReaction">) => (settings.skipReaction ? "skip" : "fast_forward");
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

/** Re-reads of T3's projects while a remote is unresolved: about 3s in all. */
const IDENTITY_REREAD = Schedule.spaced("500 millis");
const IDENTITY_REREADS = 6;

/**
 * `resolveProject` against T3's live projects. T3 caches each project's git
 * identity for a minute; the first read after that answers
 * `repositoryIdentity: null` and resolves it in the background. So a miss
 * while some project is unresolved reads again shortly before giving up.
 */
export const findProject = (rule: Pick<Rule, "projectId">, repo: string): Effect.Effect<T3Project | null, T3HttpError, T3> =>
  Effect.gen(function* () {
    const t3 = yield* T3;
    const read = Effect.map(t3.projects(), (projects) => ({
      project: resolveProject(rule, projects, repo),
      unresolved: !rule.projectId && repo !== "" && projects.some((project) => !project.repositoryIdentity),
    }));
    const { project } = yield* read.pipe(
      Effect.repeat({ schedule: IDENTITY_REREAD, times: IDENTITY_REREADS, until: (found) => found.project !== null || !found.unresolved }),
    );
    return project;
  });

/**
 * True when the project's git remote is this GitHub repository (`owner/name`).
 * T3 reports one primary remote per project; in a fork checkout that is
 * `upstream`, so the `origin` remote it nests alongside counts too.
 */
export function hostsRepository(project: T3Project, repo: string): boolean {
  const identity = project.repositoryIdentity;
  if (!identity) return false;
  const isPrimary = identity.provider === "github" && !!identity.owner && !!identity.name && sameName(`${identity.owner}/${identity.name}`, repo);
  return isPrimary || (!!identity.origin && sameName(identity.origin.canonicalKey, `github.com/${repo}`));
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
    if (origin) yield* slack.react(origin, skippedReaction(yield* store.getSettings())).pipe(Effect.catch((error) => log.warn("slack react failed", { ...at, error: error.message })));
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
 * at that thread instead of opening another. An inbox automation on a busy
 * issue records nothing instead, so it fires on a later poll once the issue is
 * free: a recorded skip would use the rule up for the issue (see
 * `itemDeliveryId`). A PR whose reviews keep
 * requesting changes (see `pausedReview`) is skipped too, unless the delivery
 * is forced: a "second pass" on Slack or a dispatch from the inbox.
 *
 * Each rule runs at most `maxConcurrent` threads at once: past that a match
 * is recorded as `queued` with the rule's action frozen on it, and
 * `startQueued` starts it when a thread of the rule settles.
 *
 * `promptRefs` says which prompt versions a one-off rule's text came from (a
 * dispatch's stacked presets); stored rules record their own prompt's version.
 */
export const runRules = Effect.fn("handler.runRules")(function* (delivery: Delivery, matched: Rule[], promptRefs?: PromptRef[]) {
  if (matched.length === 0) return [] as Run[];
  const store = yield* Store;
  const background = yield* Background;
  const { repo, pr_number: prNumber } = delivery.ctx;
  const source = delivery.source ?? runSource(delivery.event);
  const at = { delivery: delivery.deliveryId, event: delivery.event, repo: repo || undefined, pr: prNumber };
  // Every run records the action it was matched with (see RunAction); a queued one starts from it.
  const record = (rule: Rule, status: Run["status"], detail: string, thread: Thread) =>
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
        action: actionOf(rule, promptRefs),
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
      const busy = { ...at, rules: matched.map((rule) => rule.name).join(", "), thread: active.threadId };
      if (source === "poll" && !(repo && prNumber)) {
        yield* log.info("deferred to a later poll: thread already running", busy);
        return [] as Run[];
      }
      yield* log.info("skipped: thread already running", busy);
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
          return { queued: true as const, running, run: yield* record(rule, "queued", detail, NO_THREAD) };
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
          const result = yield* startThreadForRule(actionOf(rule, promptRefs), ctx);
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

/** A started thread also records what it started with, for the run history; every field is a RunPatch field. */
type StartResult =
  | ({ status: "started"; detail: string; threadId: string; threadUrl: string; startedAt: string; promptRefs?: PromptRef[]; context?: WebhookContext } & Pick<Run, "modelInstanceId" | "modelId" | "reasoning">)
  | { status: "skipped"; detail: string; threadId: null; threadUrl: null };

/** Records how a thread start went and watches it; anything but `started` frees capacity for a queued run. */
const finishStart = (run: Run, ctx: WebhookContext, result: StartResult, at: Record<string, unknown>) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const events = yield* RunEvents;
    yield* log.info(`run ${result.status}`, { ...at, detail: result.detail, thread: result.threadId ?? undefined });
    yield* store.updateRun(run.id, result);
    if (result.status === "started") yield* watchCompletion({ ...run, ...result });
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

/** A rule's action; its prompt is the rule's own live version unless `promptRefs` (a dispatch's) say otherwise. */
function actionOf(rule: Rule, promptRefs: PromptRef[] = [{ owner: "rule", id: rule.id, version: rule.livePromptVersion }]): RunAction {
  const { name, skipSelfReview, projectId, workspace, model, presetId, maxConcurrent } = rule;
  return { name, skipSelfReview, projectId, workspace, model, presetId, maxConcurrent, promptRefs };
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
        const action = yield* store.getRunAction(next.id);
        const limit = (yield* store.getRule(ruleId))?.maxConcurrent ?? action?.maxConcurrent ?? 0;
        if (limit > 0 && (yield* store.countRuns(ruleId, "started")) >= limit) return;
        const ctx = next.context as WebhookContext | null;
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

/**
 * The prompt versions a dispatch's text is: the stacked presets' while the
 * text is still their bodies, otherwise the text saved as a one-off version.
 */
export const dispatchPrompt = Effect.fn("handler.dispatchPrompt")(function* (presets: readonly { id: string; version: number }[], text: string, name: string) {
  const store = yield* Store;
  const stacked = presets.map((preset): PromptRef => ({ owner: "preset", ...preset }));
  const bodies = stacked.length > 0 ? yield* store.promptBodies(stacked) : null;
  if (bodies && joinPrompts(bodies) === text) return stacked;
  return [yield* store.createDispatchPrompt(text, name)];
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
    const settings = yield* store.getSettings();
    if (rule.skipSelfReview && ctx.pr_author && settings.githubLogin && sameName(ctx.pr_author, settings.githubLogin)) {
      return skipped(`PR by ${ctx.pr_author} is your own; rule skips self review`);
    }

    const project = yield* findProject(rule, ctx.repo);
    if (!project) {
      return skipped(
        rule.projectId
          ? `T3 project ${rule.projectId} no longer exists`
          : ctx.repo
            ? `no T3 project has a git remote for ${ctx.repo}`
            : "no repository to match a T3 project by; pick a project in the rule",
      );
    }

    // A linked preset's live version is read now, not when the rule was saved; a deleted one falls back to the action's own versions.
    const preset = rule.presetId ? yield* store.getPrompt(rule.presetId) : null;
    const promptRefs: PromptRef[] = preset ? [{ owner: "preset", id: preset.id, version: preset.liveVersion }] : rule.promptRefs;
    const bodies = promptRefs.length > 0 ? yield* store.promptBodies(promptRefs) : null;
    if (!bodies) return skipped("no prompt version to start the thread with");
    const branched = yield* withProjectBranch(rule, project, ctx);
    const started = yield* openThread(rule, project, branched.ctx, {
      title: `${rule.name}: ${ctx.pr_title ?? ctx.issue_title ?? ctx.slack_text ?? ctx.webhook ?? ctx.repo}`,
      prompt: renderTemplate(joinPrompts(bodies), branched.ctx),
    });
    const detail = branched.note ? `${started.detail} (${branched.note})` : started.detail;
    return { ...started, detail, promptRefs, context: branched.ctx };
  });

/**
 * Items that name no branch (Linear and Sentry issues) would start a worktree
 * rule in the project checkout: fill `default_branch` from the checkout's git
 * instead, which also renders `{{default_branch}}`. When git cannot tell, the
 * thread keeps the checkout and the note says why.
 */
const withProjectBranch = (rule: Pick<RunAction, "workspace">, project: T3Project, ctx: WebhookContext): Effect.Effect<{ ctx: WebhookContext; note: string | null }, never, T3> =>
  Effect.gen(function* () {
    if (rule.workspace !== "worktree" || ctx.pr_head || ctx.default_branch) return { ctx, note: null };
    const t3 = yield* T3;
    return yield* t3.defaultBranch(project).pipe(
      Effect.map((branch) => ({ ctx: { ...ctx, default_branch: branch }, note: null })),
      Effect.catch((error) => Effect.succeed({ ctx, note: `no default branch for a worktree: ${error.message}` })),
    );
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

    const model = rule.model ?? project.defaultModelSelection ?? settings.model;
    const thread = yield* t3.startThread({
      project,
      title: message.title.slice(0, 120),
      prompt: message.prompt,
      modelSelection: model,
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
      modelInstanceId: model.instanceId,
      modelId: model.model,
      reasoning: reasoningOf(model.options),
      startedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
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
): Effect.Effect<void, never, SlackClient | Store> =>
  Effect.gen(function* () {
    const origin = slackOrigin(ctx);
    if (!origin) return;
    const slack = yield* SlackClient;
    const store = yield* Store;
    const action =
      result.status === "queued"
        ? slack.react(origin, QUEUED_REACTION)
        : result.status === "started"
          ? slack.react(origin, "eyes")
          : result.alreadyRunning
            ? slack.reply(origin, `Review not started: ${result.detail}.`)
            : Effect.andThen(slack.reply(origin, `Review not started: ${result.detail}`), slack.react(origin, result.status === "skipped" ? skippedReaction(yield* store.getSettings()) : "x"));
    yield* action.pipe(Effect.catch((error) => log.warn("slack notify failed", { channel: origin.channel, ts: origin.ts, error: error.message })));
  });

function skipped(detail: string): StartResult {
  return { status: "skipped", detail, threadId: null, threadUrl: null };
}

/** Trigger that produced a delivery, from its rule key. */
function runSource(event: string): RunSource {
  if (event.startsWith(SLACK_EVENT_PREFIX)) return "slack";
  if (event.startsWith(INBOX_EVENT_PREFIX)) return "poll";
  return event.startsWith(CUSTOM_WEBHOOK_EVENT_PREFIX) ? "webhook" : "github";
}

/** PR or issue author the review is for; falls back to whoever caused the event. */
function runAuthor(ctx: WebhookContext): string | null {
  return ctx.pr_author ?? ctx.issue_author ?? ctx.sender ?? null;
}
