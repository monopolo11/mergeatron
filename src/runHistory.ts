import { Data, Effect } from "effect";
import { logger } from "./log.ts";
import type { PromptRef, Run, RunAction, RunUsage } from "./rules.ts";
import { SETTLED, Store, type RunFilter, type RunRating } from "./store.ts";
import { joinPrompts, renderTemplate } from "./template.ts";

const log = logger("runs");

/** The run asked for does not exist. */
export class RunNotFoundError extends Data.TaggedError("RunNotFoundError")<{ readonly message: string }> {}

/** A run cannot follow itself up. */
export class InvalidFollowUpError extends Data.TaggedError("InvalidFollowUpError")<{ readonly message: string }> {}

/** The run is queued or its thread is still working, so it holds a slot in its rule's queue. */
export class RunActiveError extends Data.TaggedError("RunActiveError")<{ readonly message: string }> {}

/**
 * The run history behind the MCP tools: every run with the trigger, prompt
 * versions and model it started with, what its thread spent, and an optional
 * rating with a written review and a link to the run it follows up, so prompt versions and models can be compared
 * (see Store.analytics).
 */

/**
 * A run with the prompt versions its first message is made of (see
 * `runPrompts`) and its tokens and estimated cost (see usage.ts), null until measured.
 */
type RunWithPrompts = Run & { promptRefs: PromptRef[]; usage: RunUsage | null };

/**
 * The PR or issue a run is about, from its context. `ref` is `#12` for PRs
 * and GitHub issues, the tracker's key (`FOU-12`) for Linear and Sentry.
 */
type RunSubject = { title: string | null; url: string | null; ref: string | null };

/** A run without its large fields (context, reply), for lists. */
export type RunSummary = Omit<RunWithPrompts, "context" | "result"> & RunSubject;

/**
 * One run in full: what it was set to start with (its rule's settings, see
 * RunAction) and its first message, rendered again from its prompt versions
 * and context. Null for handoffs and connection tests, which have neither.
 */
export type RunDetail = RunWithPrompts & RunSubject & { action: RunAction | null; prompt: string | null };

const withPromptRefs = (runs: Run[]) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ids = runs.map((run) => run.id);
    const refs = yield* store.runPromptRefs(ids);
    const usage = yield* store.runUsage(ids);
    return runs.map((run): RunWithPrompts => ({ ...run, promptRefs: refs.get(run.id) ?? [], usage: usage.get(run.id) ?? null }));
  });

const subject = (context: Run["context"]): RunSubject => {
  const number = context?.pr_number ?? context?.issue_number;
  return {
    title: context?.pr_title ?? context?.issue_title ?? null,
    url: context?.pr_url ?? context?.issue_url ?? null,
    ref: context?.issue_identifier ?? (number ? `#${number}` : null),
  };
};

const summarize = ({ context, result, ...run }: RunWithPrompts): RunSummary => ({ ...run, ...subject(context) });

export const listRuns = Effect.fn("runs.list")(function* (filter: RunFilter) {
  return (yield* withPromptRefs(yield* (yield* Store).listRuns(filter))).map(summarize);
});

export const getRun = Effect.fn("runs.get")(function* (id: string) {
  const store = yield* Store;
  const run = yield* store.getRun(id);
  if (!run) return yield* Effect.fail(new RunNotFoundError({ message: `No run ${id}.` }));
  const [withPrompts] = yield* withPromptRefs([run]);
  const bodies = withPrompts!.promptRefs.length > 0 ? yield* store.promptBodies(withPrompts!.promptRefs) : null;
  const detail: RunDetail = {
    ...withPrompts!,
    ...subject(run.context),
    action: yield* store.getRunAction(id),
    prompt: bodies && run.context ? renderTemplate(joinPrompts(bodies), run.context) : null,
  };
  return detail;
});

/** Rates a run, replacing an earlier rating. `followUpOf` must be another existing run. */
export const rateRun = Effect.fn("runs.rate")(function* (id: string, rating: RunRating) {
  const store = yield* Store;
  if (rating.followUpOf === id) return yield* Effect.fail(new InvalidFollowUpError({ message: "A run cannot follow itself up." }));
  if (rating.followUpOf && !(yield* store.getRun(rating.followUpOf))) return yield* Effect.fail(new RunNotFoundError({ message: `No run ${rating.followUpOf}.` }));
  const run = yield* store.rateRun(id, rating);
  if (!run) return yield* Effect.fail(new RunNotFoundError({ message: `No run ${id}.` }));
  yield* log.info("run rated", { run: id, rating: rating.rating ?? undefined });
  const [detail] = yield* withPromptRefs([run]);
  return summarize(detail!);
});

/** Deletes a settled run with its rating. A queued or working run stays until it settles. */
export const deleteRun = Effect.fn("runs.delete")(function* (id: string) {
  const store = yield* Store;
  const run = yield* store.getRun(id);
  if (!run) return yield* Effect.fail(new RunNotFoundError({ message: `No run ${id}.` }));
  if (!SETTLED.has(run.status)) return yield* Effect.fail(new RunActiveError({ message: `Run ${id} is ${run.status}; delete it once it settles.` }));
  yield* store.deleteRun(id);
  yield* log.info("run deleted", { run: id });
});

export const runAnalytics = Effect.fn("runs.analytics")(function* () {
  return yield* (yield* Store).analytics();
});
