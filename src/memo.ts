import { Duration, Effect, Exit } from "effect";

/**
 * Memoizes an effect's success for `ttl` (forever by default). Failures are
 * not cached, so the next call retries: a flaky lookup does not pin its error.
 */
export const memoSuccess = <A, E, R>(effect: Effect.Effect<A, E, R>, ttl: Duration.Input = Duration.infinity) =>
  Effect.cachedWithTTL(effect, (exit: Exit.Exit<A, E>) => (Exit.isSuccess(exit) ? ttl : Duration.zero));
