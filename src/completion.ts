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
/**
 * After the last background task reports, T3 takes a few seconds to start the
 * turn that reads its result. Wait this long with no new activity before
 * calling a completed turn the end of the thread.
 */
export const QUIET_MS = 60_000;

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

/** Task activities whose status closes the task; `task.completed` always does. */
const TASK_TERMINAL_STATUS = new Set(["completed", "failed", "stopped"]);

/**
 * Ids of background tasks (subagents, background shells) that have started or
 * reported progress but not finished. Activities are keyed by `taskId`, not by
 * turn, because a task started in one turn is read by the next.
 */
export function openTasks(thread: T3ThreadTurn): Set<string> {
  const open = new Set<string>();
  const byTime = thread.activities.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const activity of byTime) {
    if (!activity.kind.startsWith("task.")) continue;
    const payload = activity.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const { taskId, status } = payload as { taskId?: unknown; status?: unknown };
    if (typeof taskId !== "string") continue;
    const terminal = activity.kind === "task.completed" || (typeof status === "string" && TASK_TERMINAL_STATUS.has(status));
    if (terminal) open.delete(taskId);
    else open.add(taskId);
  }
  return open;
}

/**
 * What the run log records once the thread is done, or null while the agent is
 * still working. A completed turn is not the end when background tasks are
 * still running or the thread was active within `QUIET_MS`: T3 will start a
 * new turn to read their results. Errors, interruptions and a stopped session
 * settle at once since nothing more can happen.
 */
export function threadOutcome(thread: T3ThreadTurn, now = Date.now()): TurnOutcome | null {
  const outcome = turnOutcome(thread);
  if (!outcome) return null;
  if (thread.latestTurn?.state !== "completed" || thread.session?.status === "stopped") return outcome;
  if (openTasks(thread).size > 0) return null;
  const lastActivity = Math.max(
    Date.parse(thread.latestTurn.completedAt ?? "") || 0,
    ...thread.activities.map((activity) => Date.parse(activity.createdAt) || 0),
  );
  return now - lastActivity >= QUIET_MS ? outcome : null;
}

/**
 * Polls T3 until the thread is done, records the outcome on the run and, for
 * Slack-triggered runs, replies in the Slack thread. Fire and forget.
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
    const outcome = threadOutcome(thread);
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

/** Records the outcome and, for Slack runs, posts the verdict then flips 👀 to ✅ / ❌. */
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
