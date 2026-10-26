import { Clock, Data, Duration, Effect } from "effect";
import { Background } from "./background.ts";
import { startQueued } from "./handler.ts";
import { logger } from "./log.ts";
import type { QueuePause, Run } from "./rules.ts";
import { Store } from "./store.ts";

const log = logger("queue");

/**
 * A thread that stops because its provider's usage ran out pauses the queue:
 * every other thread would hit the same limit, so none starts until the
 * usage resets. Matches meanwhile are recorded as `queued` (see `runRules`)
 * and `startQueued` holds them. The queue resumes on its own at `resumeAt`,
 * the reset time T3 reported unless someone picked another, or by hand from
 * the UI. The pause is stored, so it outlives a restart.
 */

/** The resume timer's key among the background watchers. */
const RESUME = "queue-resume";

/** Rescheduling a queue that is not paused. */
export class QueueNotPausedError extends Data.TaggedError("QueueNotPausedError")<{ readonly message: string }> {}

/** The later of two resume times; null (wait for a human) only when neither says. */
const laterResume = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * Pauses the queue after `run`'s thread ran out of usage. When it is paused
 * already (several threads hit the limit together), it keeps its first
 * pause and resumes at the later reset time.
 */
export const pauseQueue = Effect.fn("queue.pause")(function* (run: Pick<Run, "id" | "threadUrl">, reason: string, resetAt: string | null) {
  const store = yield* Store;
  const current = yield* store.getQueuePause();
  const now = new Date(yield* Clock.currentTimeMillis).toISOString();
  const pause: QueuePause = current
    ? { ...current, resumeAt: laterResume(current.resumeAt, resetAt) }
    : { pausedAt: now, resumeAt: resetAt, reason, runId: run.id, threadUrl: run.threadUrl };
  yield* store.saveQueuePause(pause);
  if (!current) yield* log.warn("queue paused: usage ran out", { run: run.id, reason, resumeAt: pause.resumeAt ?? "by hand" });
  if (pause.resumeAt !== current?.resumeAt) yield* scheduleResume(pause.resumeAt);
  return pause;
});

/** Moves the paused queue's resume to `resumeAt`; a time already past resumes it now. */
export const rescheduleResume = Effect.fn("queue.reschedule")(function* (resumeAt: string) {
  const store = yield* Store;
  const current = yield* store.getQueuePause();
  if (!current) return yield* Effect.fail(new QueueNotPausedError({ message: "the queue is not paused" }));
  const pause: QueuePause = { ...current, resumeAt: new Date(resumeAt).toISOString() };
  yield* store.saveQueuePause(pause);
  yield* log.info("queue resume rescheduled", { resumeAt: pause.resumeAt });
  yield* scheduleResume(pause.resumeAt);
  return pause;
});

/** Resumes now, from the UI: the timer is dropped and queued runs start as their rules have capacity. */
export const resumeQueue = Effect.fn("queue.resumeNow")(function* () {
  yield* (yield* Background).cancel(RESUME);
  yield* resume("by hand");
});

/** Re-arms the resume timer of a pause left by the previous process. */
export const resumeTimerOnStartup = Effect.fn("queue.startup")(function* () {
  const pause = yield* (yield* Store).getQueuePause();
  if (pause?.resumeAt) yield* scheduleResume(pause.resumeAt);
});

/** Replaces the resume timer; null cancels it, leaving the queue paused until a human resumes it. */
const scheduleResume = (resumeAt: string | null) =>
  Effect.gen(function* () {
    const background = yield* Background;
    if (resumeAt === null) return yield* background.cancel(RESUME);
    const wait = Math.max(0, Date.parse(resumeAt) - (yield* Clock.currentTimeMillis));
    // Uninterruptible: a pause arriving mid-resume must not cut `startQueued` between marking a run started and starting its thread.
    yield* background.replace(RESUME, Effect.sleep(Duration.millis(wait)).pipe(Effect.andThen(Effect.uninterruptible(resume("usage reset")))));
  });

/** Lifts the pause and starts what waited, every rule with queued runs. Does nothing while the queue runs. */
const resume = (why: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    if (!(yield* store.getQueuePause())) return;
    yield* store.clearQueuePause();
    const rules = yield* store.queuedRuleIds();
    yield* log.info("queue resumed", { why, rules: rules.length });
    yield* Effect.forEach(rules, startQueued, { discard: true });
  }).pipe(Effect.withSpan("queue.resume", { attributes: { why } }));
