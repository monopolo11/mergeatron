import { Data, Effect } from "effect";
import { logger } from "./log.ts";
import type { PromptRef, Run, RunAction, RunPullRequest, RunUsage } from "./rules.ts";
import { SETTLED, Store, type RunFilter, type RunRating } from "./store.ts";
import { T3, type T3WorkflowRun, type T3WorkflowStep } from "./t3.ts";
import { joinPrompts, renderJsonTemplate, renderTemplate } from "./template.ts";

const log = logger("runs");

/** The run asked for does not exist. */
export class RunNotFoundError extends Data.TaggedError("RunNotFoundError")<{ readonly message: string }> {}

/** A run cannot follow itself up. */
export class InvalidFollowUpError extends Data.TaggedError("InvalidFollowUpError")<{ readonly message: string }> {}

/** The run is queued or its thread is still working, so it holds a slot in its rule's queue. */
export class RunActiveError extends Data.TaggedError("RunActiveError")<{ readonly message: string }> {}

/** The run started no T3 workflow, so it has no steps to show. */
export class RunWithoutWorkflowError extends Data.TaggedError("RunWithoutWorkflowError")<{ readonly message: string }> {}

/** The run never opened a T3 thread of its own (it failed to start, or was skipped), so there is nothing to read its status from. */
export class RunWithoutThreadError extends Data.TaggedError("RunWithoutThreadError")<{ readonly message: string }> {}

/**
 * The run history behind the MCP tools: every run with the trigger, prompt
 * versions and model it started with, what its thread spent, the PRs linked
 * to its thread, and an optional rating with a written review and a link to
 * the run it follows up, so prompt versions and models can be compared (see
 * Store.analytics).
 */

/**
 * A run with the prompt versions its first message is made of (see
 * `runPrompts`), its tokens and estimated cost (see usage.ts), null until
 * measured, and the PRs linked to its thread as last read (see runPullRequests.ts).
 */
type RunWithPrompts = Run & { promptRefs: PromptRef[]; usage: RunUsage | null; pullRequests: RunPullRequest[] };

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
 * and context; for a workflow run, the JSON input it started with. Null for
 * handoffs and connection tests, which have neither.
 */
export type RunDetail = RunWithPrompts & RunSubject & { action: RunAction | null; prompt: string | null };

const withRelations = (runs: Run[]) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ids = runs.map((run) => run.id);
    const refs = yield* store.runPromptRefs(ids);
    const usage = yield* store.runUsage(ids);
    const pulls = yield* store.runPullRequests(ids);
    return runs.map((run): RunWithPrompts => ({ ...run, promptRefs: refs.get(run.id) ?? [], usage: usage.get(run.id) ?? null, pullRequests: pulls.get(run.id) ?? [] }));
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
  return (yield* withRelations(yield* (yield* Store).listRuns(filter))).map(summarize);
});

export const getRun = Effect.fn("runs.get")(function* (id: string) {
  const store = yield* Store;
  const run = yield* store.getRun(id);
  if (!run) return yield* Effect.fail(new RunNotFoundError({ message: `No run ${id}.` }));
  const [withPrompts] = yield* withRelations([run]);
  const bodies = withPrompts!.promptRefs.length > 0 ? yield* store.promptBodies(withPrompts!.promptRefs) : null;
  const detail: RunDetail = {
    ...withPrompts!,
    ...subject(run.context),
    action: yield* store.getRunAction(id),
    prompt: bodies && run.context ? renderPrompt(joinPrompts(bodies), run.context, run.workflowRunId !== null) : null,
  };
  return detail;
});

/** A workflow run's input as indented JSON (the template as stored when it no longer parses), a thread's message as text. */
const renderPrompt = (template: string, context: Record<string, string>, workflow: boolean) => {
  if (!workflow) return renderTemplate(template, context);
  const input = renderJsonTemplate(template, context);
  return input.ok ? JSON.stringify(input.value, null, 2) : template;
};

/** A workflow run as the run's details show it: its state and steps, each agent step with a link to its thread. */
export type RunWorkflow = { run: T3WorkflowRun; steps: Array<T3WorkflowStep & { threadUrl: string | null }> };

/** The run's workflow run, read from T3 now. Null when T3 no longer has it. */
export const getRunWorkflow = Effect.fn("runs.workflow")(function* (id: string) {
  const store = yield* Store;
  const t3 = yield* T3;
  const run = yield* store.getRun(id);
  if (!run) return yield* Effect.fail(new RunNotFoundError({ message: `No run ${id}.` }));
  if (!run.workflowRunId) return yield* Effect.fail(new RunWithoutWorkflowError({ message: `Run ${id} started no workflow.` }));
  const read = yield* t3.workflowRun(run.workflowRunId);
  if (!read) return null;
  const steps = yield* Effect.forEach(read.steps, (step) =>
    Effect.map(step.threadId ? t3.threadUrl(step.threadId, step.environmentId) : Effect.succeed(null), (threadUrl) => ({ ...step, threadUrl })),
  );
  const workflow: RunWorkflow = { run: read.run, steps };
  return workflow;
});

/** Rates a run, replacing an earlier rating. `followUpOf` must be another existing run. */
export const rateRun = Effect.fn("runs.rate")(function* (id: string, rating: RunRating) {
  const store = yield* Store;
  if (rating.followUpOf === id) return yield* Effect.fail(new InvalidFollowUpError({ message: "A run cannot follow itself up." }));
  if (rating.followUpOf && !(yield* store.getRun(rating.followUpOf))) return yield* Effect.fail(new RunNotFoundError({ message: `No run ${rating.followUpOf}.` }));
  const run = yield* store.rateRun(id, rating);
  if (!run) return yield* Effect.fail(new RunNotFoundError({ message: `No run ${id}.` }));
  yield* log.info("run rated", { run: id, rating: rating.rating ?? undefined });
  const [detail] = yield* withRelations([run]);
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
