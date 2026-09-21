import type { Run } from "./rules.ts";
import { slackOrigin, type SlackClient } from "./slack.ts";
import type { Store } from "./store.ts";
import { T3HttpError, type T3Client, type T3ThreadTurn } from "./t3.ts";

export type CompletionDeps = {
  store: Store;
  t3: T3Client;
  slack: SlackClient | null;
};

const POLL_MS = 5_000;
/** A review that has run this long is not going to report back; stop polling. */
const GIVE_UP_MS = 3 * 60 * 60_000;
/** Time allowed for the turn to appear after the thread was created. */
const TURN_APPEARS_MS = 2 * 60_000;

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

/**
 * Polls T3 until the thread's turn settles, records the outcome on the run
 * and, for Slack-triggered runs, replies in the Slack thread. Fire and forget.
 * A 404 means the thread was deleted in T3: the run fails and polling stops,
 * which also releases the PR for a new review.
 */
export function watchCompletion(deps: CompletionDeps, run: Pick<Run, "id" | "threadId" | "createdAt">): void {
  if (!run.threadId) return;
  const threadId = run.threadId;
  const startedAt = new Date(run.createdAt).getTime();

  const poll = async (): Promise<void> => {
    const elapsed = Date.now() - startedAt;
    let thread: T3ThreadTurn;
    try {
      thread = await deps.t3.thread(threadId);
    } catch (error) {
      if (error instanceof T3HttpError && error.status === 404) {
        return settle(deps, run.id, { status: "failed", detail: "thread no longer exists in T3", result: null });
      }
      console.warn(`[completion] snapshot failed for ${threadId}:`, error instanceof Error ? error.message : error);
      if (elapsed < GIVE_UP_MS) setTimeout(() => void poll(), POLL_MS);
      return;
    }
    const outcome = turnOutcome(thread);
    if (!outcome) {
      if (!thread.latestTurn && elapsed > TURN_APPEARS_MS) {
        return settle(deps, run.id, { status: "failed", detail: "thread never started a turn", result: null });
      }
      if (elapsed < GIVE_UP_MS) setTimeout(() => void poll(), POLL_MS);
      return;
    }
    settle(deps, run.id, outcome);
  };
  setTimeout(() => void poll(), POLL_MS);
}

/** Re-attaches watchers to runs left `started` by a previous process. */
export function resumeWatchers(deps: CompletionDeps): void {
  const unsettled = deps.store.listUnsettledRuns().filter((run) => run.threadId);
  for (const run of unsettled) watchCompletion(deps, run);
  if (unsettled.length > 0) console.log(`[completion] watching ${unsettled.length} unsettled run(s)`);
}

function settle(deps: CompletionDeps, runId: string, outcome: TurnOutcome): void {
  deps.store.updateRun(runId, outcome);
  const run = deps.store.getRun(runId);
  const origin = slackOrigin(run?.context ?? null);
  if (!run || !origin || !deps.slack) return;
  const slack = deps.slack;
  const body = outcome.status === "done" ? (outcome.result ?? "_(no reply)_") : `Review failed: ${outcome.detail}`;
  void slack
    .reply(origin, body)
    .then(() => slack.unreact(origin, "eyes"))
    .then(() => slack.react(origin, outcome.status === "done" ? "white_check_mark" : "x"))
    .catch((error: unknown) => console.warn(`[slack] reply failed for run ${runId}:`, error instanceof Error ? error.message : error));
}
