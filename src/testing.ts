import { Effect, Layer } from "effect";
import { Background, RunEvents } from "./background.ts";
import { loggerLayer } from "./log.ts";
import { PullRequests, type PullRequestsShape } from "./pulls.ts";
import { SlackClient, type SlackClientShape } from "./slack.ts";
import { Store } from "./store.ts";
import { T3, T3HttpError, type T3Shape } from "./t3.ts";

/**
 * Fakes and layers for tests: an in-memory store, background supervision,
 * and T3, Slack and GitHub stand-ins whose behaviour each test overrides.
 */

/** Fails like T3 would; tests that must never reach T3 see "unexpected" on the run. */
export const unexpected = <A = never>(what = "unexpected"): Effect.Effect<A, T3HttpError> => Effect.fail(new T3HttpError({ status: 0, message: what }));

export const fakeT3 = (overrides: Partial<T3Shape> = {}): T3Shape => ({
  origin: "http://t3",
  environment: unexpected(),
  projects: () => unexpected(),
  providers: () => unexpected(),
  thread: () => unexpected(),
  startThread: () => unexpected(),
  ...overrides,
});

/** Accepts every call silently; override what the test observes. */
export const fakeSlack = (overrides: Partial<SlackClientShape> = {}): SlackClientShape => ({
  react: () => Effect.void,
  unreact: () => Effect.void,
  reply: () => Effect.void,
  post: () => Effect.succeed({ channel: "C1", ts: "1.0" }),
  botId: Effect.succeed("B_OWN"),
  permalink: () => Effect.succeed("https://acme.slack.com/archives/C1/p10"),
  ...overrides,
});

/** Leaves the context as is and cannot tell whether a PR is merged. */
export const fakePulls = (overrides: Partial<PullRequestsShape> = {}): PullRequestsShape => ({
  details: (ctx) => Effect.succeed(ctx),
  merged: () => Effect.succeed(null),
  ...overrides,
});

/** Fresh services per use: in-memory store, supervision, the line logger, and the fakes (Slack off unless given). */
export const testLayer = (fakes: { t3?: T3Shape; slack?: SlackClientShape; pulls?: PullRequestsShape } = {}) =>
  Layer.mergeAll(
    loggerLayer,
    Store.layerMemory,
    Background.layer,
    RunEvents.layer,
    Layer.succeed(T3, fakes.t3 ?? fakeT3()),
    Layer.succeed(SlackClient, fakes.slack ?? SlackClient.disabled),
    Layer.succeed(PullRequests, fakes.pulls ?? fakePulls()),
  );

export type TestServices = Layer.Success<ReturnType<typeof testLayer>>;

/** Runs a test body against one set of services. */
export const runWith = <A, E, R>(layer: Layer.Layer<R>, body: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(Effect.provide(body, layer));

/** Waits for every background job (thread starts, label syncs) to finish. */
export const settle: Effect.Effect<void, never, Background> = Effect.flatMap(Background, (background) => background.awaitIdle);

/** The error an effect fails with, as a value. */
export const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<E, never, R> =>
  Effect.flatMap(Effect.result(effect), (result) => (result._tag === "Failure" ? Effect.succeed(result.failure) : Effect.die(new Error("expected a failure, got success"))));
