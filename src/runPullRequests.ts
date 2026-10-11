import { Cause, Effect } from "effect";
import { Background } from "./background.ts";
import { errorMessage } from "./errors.ts";
import { logger } from "./log.ts";
import type { Run, RunPullRequest } from "./rules.ts";
import { RunNotFoundError } from "./runHistory.ts";
import { Store } from "./store.ts";
import { threadTree, type T3Thread } from "./t3.ts";

const log = logger("pulls");

/**
 * A run's related PRs: those linked in T3 to its thread and to the tasks it
 * delegated (see threadTree). The orchestrator links the PR a review starts
 * on; agents link the PRs they open or work on with T3's `link_pull_request`.
 * Stored on the run (see `runPullRequests`) so they outlive the thread.
 */

/** Every PR linked across the threads, once per repository and number (the first link wins), in link order. */
const linkedPullRequests = (threads: T3Thread[]): RunPullRequest[] => {
  const pulls = new Map<string, RunPullRequest>();
  for (const { repository, number, url, linkedAt, snapshot } of threads.flatMap((thread) => thread.thread.pullRequests ?? [])) {
    const key = `${repository}#${number}`;
    if (pulls.has(key)) continue;
    pulls.set(key, { repository, number, url, linkedAt, title: snapshot?.title ?? null, state: snapshot?.state ?? null, isDraft: snapshot?.isDraft ?? false });
  }
  return [...pulls.values()].sort((a, b) => a.linkedAt.localeCompare(b.linkedAt));
};

/**
 * Reads the PRs linked to a run's thread from T3 and stores them, replacing
 * the earlier list. Returns null and keeps what was stored when the run has
 * no thread or T3 no longer has it. Either answer marks the run checked
 * (`pullRequestsCheckedAt`); a failure leaves it for the next startup.
 */
export const recordPullRequests = Effect.fn("pulls.record")(function* (run: Pick<Run, "id" | "threadId">) {
  if (!run.threadId) return null;
  const store = yield* Store;
  const threads = yield* threadTree(run.threadId, true).pipe(Effect.catchIf((error) => error.status === 404, () => Effect.succeed(null)));
  const checkedAt = new Date().toISOString();
  if (!threads) {
    yield* store.updateRun(run.id, { pullRequestsCheckedAt: checkedAt });
    return null;
  }
  const pulls = linkedPullRequests(threads);
  yield* store.saveRunPullRequests(run.id, pulls, checkedAt);
  return pulls;
});

/**
 * A run's related PRs as T3 has them now, stored on the way: the UI reads
 * this when a run opens, so PRs linked after the run settled show up and
 * their states stay current. Falls back to the stored list when the run has
 * no thread, T3 deleted it, or T3 cannot be reached.
 */
export const syncPullRequests = Effect.fn("pulls.sync")(function* (id: string) {
  const store = yield* Store;
  const run = yield* store.getRun(id);
  if (!run) return yield* Effect.fail(new RunNotFoundError({ message: `No run ${id}.` }));
  const fresh = yield* recordPullRequests(run).pipe(Effect.catch((error) => Effect.as(log.warn("pull requests not refreshed", { run: id, error: error.message }), null)));
  return fresh ?? (yield* store.runPullRequests([id])).get(id) ?? [];
});

/**
 * Reads the PRs of settled runs never checked, one run at a time: runs from
 * before PRs were recorded, so the first start after updating fills them in,
 * and runs whose read failed when they settled. A run that fails is counted,
 * left unchecked for the next startup, and the rest go on.
 */
export const backfillPullRequests = Effect.fn("pulls.backfill")(function* () {
  const runs = yield* (yield* Store).runsWithUncheckedPullRequests();
  // `exit` rather than `result`: a locked database is a defect, and one run's should not stop the others.
  const outcomes = yield* Effect.forEach(runs, (run) => Effect.exit(recordPullRequests(run)));
  const summary = {
    runs: runs.length,
    /** Runs T3 linked at least one PR to. */
    withPullRequests: outcomes.filter((outcome) => outcome._tag === "Success" && (outcome.value?.length ?? 0) > 0).length,
    /** Runs whose thread T3 no longer has. */
    gone: outcomes.filter((outcome) => outcome._tag === "Success" && outcome.value === null).length,
    failed: outcomes.filter((outcome) => outcome._tag === "Failure").length,
  };
  if (runs.length > 0) yield* log.info("pull requests backfilled", summary);
  return summary;
});

/** Starts the backfill in the background, so startup does not wait on T3. */
export const startPullRequestBackfill = Effect.fn("pulls.startBackfill")(function* () {
  const job = backfillPullRequests().pipe(Effect.catchCause((cause) => log.warn("pull request backfill failed", { error: errorMessage(Cause.squash(cause)) })));
  yield* (yield* Background).fork(job);
});
