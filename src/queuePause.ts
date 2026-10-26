import { Clock, Data, Duration, Effect } from "effect";
import { Background } from "./background.ts";
import { startQueued } from "./handler.ts";
import { logger } from "./log.ts";
import type { QueuePause, Run } from "./rules.ts";
import { Store } from "./store.ts";

const log = logger("queue");

/**
 * A thread that stops because its provider's usage ran out pauses that
 * provider instance (`claudeAgent`, `codex`…): every other thread on it would
 * hit the same limit. Runs that would start on it go back to `queued` with
 * the provider recorded (see `startThreadForRule`), and `startQueued` passes
 * over them, so runs on other providers keep starting. The provider resumes
 * on its own at `resumeAt`, the reset time T3 reported unless someone picked
 * another, or by hand from the UI. Pauses are stored, so they outlive a
 * restart.
 */

/** A paused provider's resume timer key among the background watchers. */
const timerKey = (instanceId: string) => `queue-resume:${instanceId}`;

/** Rescheduling a provider that is not paused. */
export class QueueNotPausedError extends Data.TaggedError("QueueNotPausedError")<{ readonly message: string }> {}

/** The later of two resume times; null (wait for a human) only when neither says. */
const laterResume = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * Pauses the provider instance `run`'s thread ran out of usage on. When it is
 * paused already (several of its threads hit the limit together), it keeps
 * its first pause and resumes at the later reset time.
 */
export const pauseProvider = Effect.fn("queue.pause")(function* (instanceId: string, run: Pick<Run, "id" | "threadUrl">, reason: string, resetAt: string | null) {
  const store = yield* Store;
  const current = yield* store.getQueuePause(instanceId);
  const now = new Date(yield* Clock.currentTimeMillis).toISOString();
  const pause: QueuePause = current
    ? { ...current, resumeAt: laterResume(current.resumeAt, resetAt) }
    : { instanceId, pausedAt: now, resumeAt: resetAt, reason, runId: run.id, threadUrl: run.threadUrl };
  yield* store.saveQueuePause(pause);
  if (!current) yield* log.warn("provider paused: usage ran out", { provider: instanceId, run: run.id, reason, resumeAt: pause.resumeAt ?? "by hand" });
  if (pause.resumeAt !== current?.resumeAt) yield* scheduleResume(instanceId, pause.resumeAt);
  return pause;
});

/** Moves a paused provider's resume to `resumeAt`; a time already past resumes it now. */
export const rescheduleResume = Effect.fn("queue.reschedule")(function* (instanceId: string, resumeAt: string) {
  const store = yield* Store;
  const current = yield* store.getQueuePause(instanceId);
  if (!current) return yield* Effect.fail(new QueueNotPausedError({ message: `${instanceId} is not paused` }));
  const pause: QueuePause = { ...current, resumeAt: new Date(resumeAt).toISOString() };
  yield* store.saveQueuePause(pause);
  yield* log.info("provider resume rescheduled", { provider: instanceId, resumeAt: pause.resumeAt });
  yield* scheduleResume(instanceId, pause.resumeAt);
  return pause;
});

/** Resumes a provider now, from the UI: its timer is dropped and queued runs start as their rules have capacity. */
export const resumeProvider = Effect.fn("queue.resumeNow")(function* (instanceId: string) {
  yield* (yield* Background).cancel(timerKey(instanceId));
  yield* resume(instanceId, "by hand");
});

/** Re-arms the resume timers of pauses left by the previous process. */
export const resumeTimersOnStartup = Effect.fn("queue.startup")(function* () {
  const pauses = yield* (yield* Store).listQueuePauses();
  yield* Effect.forEach(pauses, (pause) => scheduleResume(pause.instanceId, pause.resumeAt), { discard: true });
});

/** Replaces a provider's resume timer; null cancels it, leaving the provider paused until a human resumes it. */
const scheduleResume = (instanceId: string, resumeAt: string | null) =>
  Effect.gen(function* () {
    const background = yield* Background;
    if (resumeAt === null) return yield* background.cancel(timerKey(instanceId));
    const wait = Math.max(0, Date.parse(resumeAt) - (yield* Clock.currentTimeMillis));
    // Uninterruptible: a pause arriving mid-resume must not cut `startQueued` between marking a run started and starting its thread.
    const job = Effect.sleep(Duration.millis(wait)).pipe(Effect.andThen(Effect.uninterruptible(resume(instanceId, "usage reset"))));
    yield* background.replace(timerKey(instanceId), job);
  });

/** Lifts a provider's pause and starts what waited, every rule with queued runs. Does nothing while it runs. */
const resume = (instanceId: string, why: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    if (!(yield* store.getQueuePause(instanceId))) return;
    yield* store.clearQueuePause(instanceId);
    const rules = yield* store.queuedRuleIds();
    yield* log.info("provider resumed", { provider: instanceId, why, rules: rules.length });
    yield* Effect.forEach(rules, startQueued, { discard: true });
  }).pipe(Effect.withSpan("queue.resume", { attributes: { provider: instanceId, why } }));
