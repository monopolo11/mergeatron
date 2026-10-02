import { Clock, Duration, Effect, Metric, Option, Queue, Schedule } from "effect";
import { Background, RunEvents } from "./background.ts";
import { logger } from "./log.ts";
import type { Run } from "./rules.ts";
import { HANDOFF_EVENT } from "./shared.ts";
import { SlackClient, slackOrigin, type SlackApiError, type SlackClientShape, type SlackOrigin } from "./slack.ts";
import { Store } from "./store.ts";
import { T3, type T3ThreadTurn } from "./t3.ts";
import { changesRequestedStreak, reviewVerdict, type Verdict } from "./verdict.ts";

export { changesRequestedStreak, reviewVerdict, type Verdict } from "./verdict.ts";

const log = logger("completion");

/** Everything a watcher needs; the handler and the poller run inside the same set. */
export type CompletionServices = Store | T3 | SlackClient | Background | RunEvents;

const POLL = Duration.seconds(5);
/** A review that has run this long is not going to report back; fail it and stop polling. */
const GIVE_UP = Duration.hours(3);
/** Time allowed for the turn to appear after the thread was created. */
const TURN_APPEARS_MS = 2 * 60_000;
/**
 * After the last background task reports, T3 takes a few seconds to start the
 * turn that reads its result. Wait this long with no new activity before
 * calling a completed turn the end of the thread.
 */
export const QUIET_MS = 60_000;

const runsSettled = Metric.counter("orchestrator_runs_settled_total", { incremental: true, description: "Threads that finished, by outcome status" });
const watchersActive = Metric.gauge("orchestrator_watchers_active", { description: "Threads being polled for completion" });
const threadDuration = Metric.timer("orchestrator_thread_duration", { description: "Time from thread start to settle" });

export type TurnOutcome = { status: "done" | "failed"; detail: string; result: string | null };

/** Maps a settled turn to what the run log records. Null while the turn is still running. */
export function turnOutcome(thread: T3ThreadTurn): TurnOutcome | null {
  const turn = thread.latestTurn;
  if (!turn || turn.state === "running") return null;
  const final = thread.messages.find((m) => m.id === turn.assistantMessageId)?.text
    ?? thread.messages.filter((m) => m.role === "assistant" && m.turnId === turn.turnId).at(-1)?.text
    ?? null;
  switch (turn.state) {
    case "completed":
      return { status: "done", detail: "turn completed", result: final };
    case "interrupted":
      return { status: "done", detail: "turn interrupted", result: final };
    case "error":
      return { status: "failed", detail: thread.session?.lastError ?? "turn failed", result: final };
  }
}

/** Task activities whose status closes the task; `task.completed` always does. */
const TASK_TERMINAL_STATUS = new Set(["completed", "failed", "stopped"]);

/**
 * Ids of background tasks (subagents, background shells) that have started or
 * reported progress but not finished. Activities are keyed by `taskId`, not by
 * turn, because a task started in one turn is read by the next.
 */
export function openTasks(thread: T3ThreadTurn): Set<string> {
  const open = new Set<string>();
  const byTime = thread.activities.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const activity of byTime) {
    if (!activity.kind.startsWith("task.")) continue;
    const payload = activity.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const { taskId, status } = payload as { taskId?: unknown; status?: unknown };
    if (typeof taskId !== "string") continue;
    const terminal = activity.kind === "task.completed" || (typeof status === "string" && TASK_TERMINAL_STATUS.has(status));
    if (terminal) open.delete(taskId);
    else open.add(taskId);
  }
  return open;
}

/**
 * What the run log records once the thread is done, or null while the agent is
 * still working. A completed turn is not the end when background tasks are
 * still running or the thread was active within `QUIET_MS`: T3 will start a
 * new turn to read their results. Errors, interruptions and a stopped session
 * settle at once since nothing more can happen.
 */
export function threadOutcome(thread: T3ThreadTurn, now = Date.now()): TurnOutcome | null {
  const outcome = turnOutcome(thread);
  if (!outcome) return null;
  if (thread.latestTurn?.state !== "completed" || thread.session?.status === "stopped") return outcome;
  if (openTasks(thread).size > 0) return null;
  const lastActivity = Math.max(
    Date.parse(thread.latestTurn.completedAt ?? "") || 0,
    ...thread.activities.map((activity) => Date.parse(activity.createdAt) || 0),
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
export const watchCompletion = (run: Pick<Run, "id" | "threadId" | "createdAt">): Effect.Effect<void, never, CompletionServices> =>
  Effect.gen(function* () {
    if (!run.threadId) return;
    const background = yield* Background;
    yield* log.info("watching thread", { run: run.id, thread: run.threadId });
    yield* background.watch(run.id, watcher(run.id, run.threadId, Date.parse(run.createdAt)));
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
      if (!snapshot.success.latestTurn && now - startedAt > TURN_APPEARS_MS) return Option.some(failed("thread never started a turn"));
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
 * flips 👀 to the verdict's reaction; a handoff only posts its document. The
 * supervisor then advances the rule's queue and checks whether the PR is stuck.
 */
const settle = (runId: string, outcome: TurnOutcome, startedAt: number) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const slack = yield* SlackClient;
    const events = yield* RunEvents;
    const verdict = outcome.status === "done" ? reviewVerdict(outcome.result) : undefined;
    yield* log.info(`run ${outcome.status}`, { run: runId, detail: outcome.detail, verdict });
    yield* Metric.update(Metric.withAttributes(runsSettled, { status: outcome.status }), 1);
    yield* Metric.update(threadDuration, Duration.millis((yield* Clock.currentTimeMillis) - startedAt));
    yield* store.updateRun(runId, outcome);
    const run = yield* store.getRun(runId);
    if (!run) return;
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
