import { Cause, Effect, Layer, Queue } from "effect";
import { RunEvents, type RunEvent } from "./background.ts";
import { errorMessage } from "./errors.ts";
import { startQueued } from "./handler.ts";
import { handoffIfStuck } from "./handoff.ts";
import { logger } from "./log.ts";
import { HANDOFF_EVENT } from "./shared.ts";

const log = logger("supervisor");

/**
 * Reacts to run events on its own fiber: whenever a run stops running the
 * rule's queue advances, and a review that finished is checked for a stuck
 * PR (see handoff.ts). Events are handled one at a time, in order.
 */
const handle = (event: RunEvent) => {
  switch (event._tag) {
    case "Capacity":
      return startQueued(event.ruleId);
    case "Settled":
      return Effect.gen(function* () {
        yield* startQueued(event.run.ruleId);
        if (event.run.event !== HANDOFF_EVENT && event.outcome.status === "done") yield* handoffIfStuck(event.run);
      });
  }
};

export const runSupervisor = Effect.gen(function* () {
  const events = yield* RunEvents;
  for (;;) {
    const event = yield* Queue.take(events);
    yield* handle(event).pipe(Effect.catchCause((cause) => log.error("run event failed", { event: event._tag, error: errorMessage(Cause.squash(cause)) })));
  }
});

/** Runs the supervisor for the life of the app. */
export const supervisorLayer = Layer.effectDiscard(Effect.forkScoped(runSupervisor));
