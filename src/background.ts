import { Context, Effect, FiberMap, FiberSet, Layer, Queue } from "effect";
import type { TurnOutcome } from "./completion.ts";
import type { Run } from "./rules.ts";

/**
 * Supervision for work that outlives an HTTP request or a Slack envelope:
 * thread starts, completion watchers, label syncs. Every fiber lives in the
 * app's scope, so shutting down interrupts them instead of leaving promises
 * dangling, and tests can wait for the set to drain instead of sleeping.
 */
export type BackgroundShape = {
  /** Runs `job` in its own supervised fiber. The job must handle its own errors. */
  readonly fork: <R>(job: Effect.Effect<unknown, never, R>) => Effect.Effect<void, never, R>;
  /** Like `fork`, keyed: a second `watch` for a key still running is ignored (a resumed watcher does not double up). */
  readonly watch: <R>(key: string, job: Effect.Effect<unknown, never, R>) => Effect.Effect<void, never, R>;
  readonly watching: Effect.Effect<number>;
  /** Resolves once every forked job (watchers excluded) has finished. */
  readonly awaitIdle: Effect.Effect<void>;
};

export class Background extends Context.Service<Background, BackgroundShape>()("Background", {
  make: Effect.gen(function* () {
    const jobs = yield* FiberSet.make<unknown, never>();
    const watchers = yield* FiberMap.make<string, unknown, never>();
    const shape: BackgroundShape = {
      fork: (job) => Effect.asVoid(FiberSet.run(jobs, job)),
      watch: (key, job) => Effect.asVoid(FiberMap.run(watchers, key, job, { onlyIfMissing: true })),
      watching: FiberMap.size(watchers),
      awaitIdle: FiberSet.awaitEmpty(jobs),
    };
    return shape;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

/**
 * What happens to runs, for the supervisor (see supervisor.ts): a thread
 * settled, or a rule has capacity again because a run stopped running. Keeping
 * the queue advance and the stuck-PR check out of the watcher avoids a cycle
 * between completion and the handler, and keeps them off the watcher's fiber.
 */
export type RunEvent =
  | { readonly _tag: "Settled"; readonly run: Run; readonly outcome: TurnOutcome }
  | { readonly _tag: "Capacity"; readonly ruleId: string };

export class RunEvents extends Context.Service<RunEvents, Queue.Queue<RunEvent>>()("RunEvents") {
  static readonly layer = Layer.effect(this, Queue.unbounded<RunEvent>());
}
