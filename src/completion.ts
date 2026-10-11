import { Cause, Clock, Duration, Effect, Metric, Option, Queue, Schedule } from "effect";
import { Background, RunEvents } from "./background.ts";
import { errorMessage } from "./errors.ts";
import { logger } from "./log.ts";
import type { Run } from "./rules.ts";
import { HANDOFF_EVENT } from "./shared.ts";
import { SlackClient, slackOrigin, type SlackApiError, type SlackClientShape, type SlackOrigin } from "./slack.ts";
import { Store } from "./store.ts";
import { T3, type T3RunStatus, type T3Thread } from "./t3.ts";
import { recordPullRequests } from "./runPullRequests.ts";
import { recordUsage, Usage } from "./usage.ts";
import { changesRequestedStreak, reviewVerdict, type Verdict } from "./verdict.ts";

export { changesRequestedStreak, reviewVerdict, type Verdict } from "./verdict.ts";

const log = logger("completion");

/** Everything a watcher needs; the handler and the poller run inside the same set. */
export type CompletionServices = Store | T3 | SlackClient | Background | RunEvents | Usage;

const POLL = Duration.seconds(5);
/** A review that has run this long is not going to report back; fail it and stop polling. */
const GIVE_UP = Duration.hours(3);
/** Time allowed for the first run to appear after the thread was created. */
const RUN_APPEARS_MS = 2 * 60_000;
/**
 * After the last background task reports, T3 may take a few seconds to start
 * the run that reads its result. Wait this long with no new activity before
 * calling a completed run the end of the thread.
 */
export const QUIET_MS = 60_000;

const runsSettled = Metric.counter("orchestrator_runs_settled_total", { incremental: true, description: "Threads that finished, by outcome status" });
const watchersActive = Metric.gauge("orchestrator_watchers_active", { description: "Threads being polled for completion" });
const threadDuration = Metric.timer("orchestrator_thread_duration", { description: "Time from thread start to settle" });

export type TurnOutcome = { status: "done" | "failed"; detail: string; result: string | null };

type T3Run = T3Thread["runs"][number];

const RUN_FINISHED = new Set<T3RunStatus>(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const WORK_ACTIVE = new Set(["pending", "running", "waiting"]);

/** Maps a finished run to what the run log records: its last non-empty reply, and for a failure the reason. */
function runOutcome(thread: T3Thread, run: T3Run): TurnOutcome {
  const result = thread.messages
    .filter((message) => message.runId === run.id && message.role === "assistant" && message.text.trim() !== "")
    .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .at(-1)?.text ?? null;
  if (run.status === "failed") {
    const error = thread.turnItems
      .filter((item) => item.runId === run.id && item.type === "error")
      .toSorted((a, b) => a.ordinal - b.ordinal)
      .at(-1);
    return { status: "failed", detail: error?.failure?.message ?? "turn failed", result };
  }
  return { status: "done", detail: `turn ${run.status === "completed" ? "completed" : "interrupted"}`, result };
}

/**
 * True while background work will wake the thread again: a live subagent, a
 * finished one whose result T3 has not delivered yet, or provider-owned work
 * such as a background shell. Mirrors `delegatedTaskProgress` in T3's
 * apps/server/src/orchestration-v2/SubagentProjection.ts.
 */
function hasBackgroundWork(thread: T3Thread): boolean {
  return (
    thread.subagents.some(
      (task) => WORK_ACTIVE.has(task.status) || task.completionDelivery?.state === "pending" || task.completionDelivery?.state === "claimed",
    ) || thread.providerThreads.some((provider) => (provider.pendingBackgroundTasks?.length ?? 0) > 0)
  );
}

/**
 * What the run log records once the thread is done, or null while the agent is
 * still working. The result is the latest run's (rolled back runs do not
 * count). A completed run is not the end while background work is pending or
 * the thread was active within `QUIET_MS`: T3 will start a new run to read
 * its results. Failures and interruptions settle at once.
 */
export function threadOutcome(thread: T3Thread, now = Date.now()): TurnOutcome | null {
  const runs = thread.runs.filter((run) => run.status !== "rolled_back");
  if (runs.some((run) => !RUN_FINISHED.has(run.status))) return null;
  const run = runs.filter((run) => run.startedAt !== null || run.ordinal === 1).toSorted((a, b) => a.ordinal - b.ordinal).at(-1);
  if (!run) return null;
  const outcome = runOutcome(thread, run);
  if (run.status !== "completed") return outcome;
  if (hasBackgroundWork(thread)) return null;
  const lastActivity = Math.max(
    Date.parse(run.completedAt ?? "") || 0,
    ...[...thread.subagents, ...thread.providerThreads].map((work) => Date.parse(work.updatedAt) || 0),
  );
  return now - lastActivity >= QUIET_MS ? outcome : null;
}

/**
 * Polls T3 until the thread is done, records the outcome on the run and, for
 * Slack-triggered runs, replies in the Slack thread. Runs as a supervised
 * background watcher keyed by run id, so it returns at once.
 * A 404 means the thread was deleted in T3, and a thread still busy after
 * `GIVE_UP` is abandoned: either way the run fails and polling stops,
 * which also releases the PR for a new review.
 */
export const watchCompletion = (run: Pick<Run, "id" | "threadId" | "createdAt" | "startedAt">): Effect.Effect<void, never, CompletionServices> =>
  Effect.gen(function* () {
    if (!run.threadId) return;
    const background = yield* Background;
    yield* log.info("watching thread", { run: run.id, thread: run.threadId });
    // Runs from before `startedAt` was recorded fall back to when they were created.
    yield* background.watch(run.id, watcher(run.id, run.threadId, Date.parse(run.startedAt ?? run.createdAt)));
  });

const watcher = (runId: string, threadId: string, startedAt: number) =>
  Effect.gen(function* () {
    yield* Metric.modify(watchersActive, 1);
    const t3 = yield* T3;
    const at = { run: runId, thread: threadId };
    const failed = (detail: string): TurnOutcome => ({ status: "failed", detail, result: null });

    /** One snapshot: the outcome when the thread is done, none while it is still working. */
    const poll = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const snapshot = yield* Effect.result(t3.thread(threadId));
      if (snapshot._tag === "Failure") {
        if (snapshot.failure.status === 404) return Option.some(failed("thread no longer exists in T3"));
        yield* log.warn("snapshot failed", { ...at, error: snapshot.failure.message });
        return Option.none<TurnOutcome>();
      }
      const outcome = threadOutcome(snapshot.success, now);
      if (outcome) return Option.some(outcome);
      if (snapshot.success.runs.length === 0 && now - startedAt > RUN_APPEARS_MS) return Option.some(failed("thread never started a turn"));
      return Option.none<TurnOutcome>();
    });

    // Resumed watchers (after a restart) keep the original deadline.
    const remaining = Math.max(0, Duration.toMillis(GIVE_UP) - ((yield* Clock.currentTimeMillis) - startedAt));
    const settled = yield* Effect.sleep(POLL).pipe(
      Effect.andThen(poll.pipe(Effect.repeat({ schedule: Schedule.spaced(POLL), until: Option.isSome }))),
      Effect.timeoutOption(Duration.millis(remaining)),
    );
    const outcome = Option.isSome(settled) ? settled.value : Option.none<TurnOutcome>();
    if (Option.isSome(outcome)) {
      yield* settle(runId, outcome.value, startedAt);
    } else {
      const hours = Duration.toHours(GIVE_UP);
      yield* log.warn("gave up watching", { ...at, hours });
      yield* settle(runId, failed(`no result after ${hours}h`), startedAt);
    }
  }).pipe(
    Effect.ensuring(Metric.modify(watchersActive, -1)),
    Effect.withSpan("completion.watch", { attributes: { run: runId, thread: threadId } }),
  );

/** Re-attaches watchers to runs left `started` by a previous process. */
export const resumeWatchers: Effect.Effect<void, never, CompletionServices> = Effect.gen(function* () {
  const store = yield* Store;
  const unsettled = (yield* store.listUnsettledRuns()).filter((run) => run.threadId);
  yield* Effect.forEach(unsettled, watchCompletion, { discard: true });
  if (unsettled.length > 0) yield* log.info("resumed watchers for unsettled runs", { count: unsettled.length });
});

/**
 * Records the outcome and, for Slack runs, posts the reply. A review then
 * flips 👀 to the verdict's reaction; a handoff only posts its document.
 * What the thread spent is measured, and the PRs linked to it read, in the
 * background (see usage.ts, runPullRequests.ts). The
 * supervisor then advances the rule's queue and checks whether the PR is stuck.
 */
const settle = (runId: string, outcome: TurnOutcome, startedAt: number) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const slack = yield* SlackClient;
    const events = yield* RunEvents;
    const background = yield* Background;
    const verdict = outcome.status === "done" ? reviewVerdict(outcome.result) : undefined;
    yield* log.info(`run ${outcome.status}`, { run: runId, detail: outcome.detail, verdict });
    yield* Metric.update(Metric.withAttributes(runsSettled, { status: outcome.status }), 1);
    yield* Metric.update(threadDuration, Duration.millis((yield* Clock.currentTimeMillis) - startedAt));
    yield* store.updateRun(runId, outcome);
    const run = yield* store.getRun(runId);
    if (!run) return;
    yield* background.fork(
      recordUsage(run).pipe(
        // Measurement is all or nothing, so ride out a hiccup (T3 restarting, ccusage's first download) rather than wait for the next startup's backfill.
        Effect.retry({ schedule: Schedule.spaced("30 seconds"), times: 2, while: (error) => !(error._tag === "T3HttpError" && error.status === 404) }),
        Effect.catchCause((cause) => log.warn("usage not recorded", { run: runId, error: errorMessage(Cause.squash(cause)) })),
      ),
    );
    // Opening the run in the UI reads them again, so a miss here is not lost.
    yield* background.fork(recordPullRequests(run).pipe(Effect.catchCause((cause) => log.warn("pull requests not recorded", { run: runId, error: errorMessage(Cause.squash(cause)) }))));
    const review = run.event !== HANDOFF_EVENT;
    const origin = slackOrigin(run.context);
    if (origin) {
      yield* slack.reply(origin, outcome.status === "done" ? (outcome.result ?? "_(no reply)_") : `Review failed: ${outcome.detail}`).pipe(
        Effect.andThen(review ? Effect.andThen(slack.unreact(origin, "eyes"), reactVerdict(slack, origin, outcome)) : Effect.void),
        Effect.catch((error) => log.warn("slack reply failed", { run: runId, error: error.message })),
      );
    }
    yield* Queue.offer(events, { _tag: "Settled", run, outcome });
  });

/**
 * Why automated review of this PR is paused: at least `maxChangesRequestedRounds`
 * reviews in a row requested changes. Null while under the limit or when the
 * limit is 0. `handoff` is the run that wrote the handoff document, if it exists.
 */
export const pausedReview = (repo: string, prNumber: string): Effect.Effect<{ rounds: number; handoff: Run | null } | null, never, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const limit = (yield* store.getSettings()).maxChangesRequestedRounds;
    if (limit <= 0) return null;
    const finished = yield* store.finishedRunsForPullRequest(repo, prNumber);
    const rounds = changesRequestedStreak(finished).length;
    if (rounds < limit) return null;
    return { rounds, handoff: finished.find((run) => run.event === HANDOFF_EVENT) ?? null };
  });

/**
 * Reaction per outcome on the triggering message: ❌ failed, 🔁 changes
 * requested, 💬 no verdict, and the workspace's `chayanne-approved` for an
 * approval, or ✅ where that emoji does not exist.
 */
const VERDICT_REACTION: Record<Verdict, string> = {
  approved: "chayanne-approved",
  changes_requested: "repeat",
  commented: "speech_balloon",
};
const APPROVED_FALLBACK = "white_check_mark";

export const reactVerdict = (slack: Pick<SlackClientShape, "react">, origin: SlackOrigin, outcome: TurnOutcome): Effect.Effect<void, SlackApiError> => {
  if (outcome.status === "failed") return slack.react(origin, "x");
  const verdict = reviewVerdict(outcome.result);
  return slack.react(origin, VERDICT_REACTION[verdict]).pipe(
    Effect.catchIf(
      (error) => verdict === "approved" && error.code === "invalid_name",
      () => slack.react(origin, APPROVED_FALLBACK),
    ),
  );
};
