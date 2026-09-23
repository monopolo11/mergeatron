import { logger } from "./log.ts";
import type { Run } from "./rules.ts";
import { SlackApiError, slackOrigin, type SlackClient, type SlackOrigin } from "./slack.ts";
import type { Store } from "./store.ts";
import { T3HttpError, type T3Client, type T3ThreadTurn } from "./t3.ts";

const log = logger("completion");

export type CompletionDeps = {
  store: Store;
  t3: T3Client;
  slack: SlackClient | null;
};

const POLL_MS = 5_000;
/** A review that has run this long is not going to report back; fail it and stop polling. */
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
 * A 404 means the thread was deleted in T3, and a thread still busy after
 * `GIVE_UP_MS` is abandoned: either way the run fails and polling stops,
 * which also releases the PR for a new review.
 */
export function watchCompletion(deps: CompletionDeps, run: Pick<Run, "id" | "threadId" | "createdAt">): void {
  if (!run.threadId) return;
  const threadId = run.threadId;
  const startedAt = new Date(run.createdAt).getTime();

  const pollAgain = (elapsed: number) => {
    if (elapsed < GIVE_UP_MS) return void setTimeout(() => void poll(), POLL_MS);
    const hours = GIVE_UP_MS / 3_600_000;
    log.warn("gave up watching", { run: run.id, thread: threadId, hours });
    settle(deps, run.id, { status: "failed", detail: `no result after ${hours}h`, result: null });
  };
  const poll = async (): Promise<void> => {
    const elapsed = Date.now() - startedAt;
    let thread: T3ThreadTurn;
    try {
      thread = await deps.t3.thread(threadId);
    } catch (error) {
      if (error instanceof T3HttpError && error.status === 404) {
        return settle(deps, run.id, { status: "failed", detail: "thread no longer exists in T3", result: null });
      }
      log.warn("snapshot failed", { run: run.id, thread: threadId, error });
      return pollAgain(elapsed);
    }
    const outcome = threadOutcome(thread);
    if (!outcome) {
      if (!thread.latestTurn && elapsed > TURN_APPEARS_MS) {
        return settle(deps, run.id, { status: "failed", detail: "thread never started a turn", result: null });
      }
      return pollAgain(elapsed);
    }
    settle(deps, run.id, outcome);
  };
  log.info("watching thread", { run: run.id, thread: threadId });
  setTimeout(() => void poll(), POLL_MS);
}

/** Re-attaches watchers to runs left `started` by a previous process. */
export function resumeWatchers(deps: CompletionDeps): void {
  const unsettled = deps.store.listUnsettledRuns().filter((run) => run.threadId);
  for (const run of unsettled) watchCompletion(deps, run);
  if (unsettled.length > 0) log.info("resumed watchers for unsettled runs", { count: unsettled.length });
}

/** Records the outcome and, for Slack runs, posts the verdict then flips 👀 to the verdict's reaction. */
function settle(deps: CompletionDeps, runId: string, outcome: TurnOutcome): void {
  const verdict = outcome.status === "done" ? reviewVerdict(outcome.result) : undefined;
  log.info(`run ${outcome.status}`, { run: runId, detail: outcome.detail, verdict });
  deps.store.updateRun(runId, outcome);
  const run = deps.store.getRun(runId);
  const origin = slackOrigin(run?.context ?? null);
  if (!run || !origin || !deps.slack) return;
  const slack = deps.slack;
  const body = outcome.status === "done" ? (outcome.result ?? "_(no reply)_") : `Review failed: ${outcome.detail}`;
  void slack
    .reply(origin, body)
    .then(() => slack.unreact(origin, "eyes"))
    .then(() => reactVerdict(slack, origin, outcome))
    .catch((error: unknown) => log.warn("slack reply failed", { run: runId, error }));
}

export type Verdict = "approved" | "changes_requested" | "commented";

const CHANGES_REQUESTED = /\bchanges[_ ]requested\b|\brequest(?:ed|ing)?[_ ]changes\b/i;
const APPROVED = /\bapproved?\b/i;

/**
 * Reads the review's verdict out of the agent's final message, which names the
 * GitHub review state it published ("**APPROVE** on `33d5528`",
 * "**CHANGES_REQUESTED**, 7 inline comments", "Verdict: approve"). A change
 * request that says "approve once fixed" is still a change request, so that
 * check wins. Anything else, including a reply that never reviewed, is
 * `commented`.
 */
export function reviewVerdict(result: string | null): Verdict {
  if (!result) return "commented";
  if (CHANGES_REQUESTED.test(result)) return "changes_requested";
  if (APPROVED.test(result)) return "approved";
  return "commented";
}

/**
 * Reaction per outcome on the triggering message: ❌ failed, 🔁 changes
 * requested, 💬 no verdict, and the workspace's `chayanne-approved` for an
 * approval, or ✅ where that emoji does not exist.
 */
const VERDICT_REACTION: Record<Verdict, string> = {
  approved: "chayanne-approved",
  changes_requested: "repeat",
  commented: "speech_balloon",
};
const APPROVED_FALLBACK = "white_check_mark";

export async function reactVerdict(slack: Pick<SlackClient, "react">, origin: SlackOrigin, outcome: TurnOutcome): Promise<void> {
  if (outcome.status === "failed") return slack.react(origin, "x");
  const verdict = reviewVerdict(outcome.result);
  try {
    await slack.react(origin, VERDICT_REACTION[verdict]);
  } catch (error) {
    if (verdict !== "approved" || !(error instanceof SlackApiError) || error.code !== "invalid_name") throw error;
    await slack.react(origin, APPROVED_FALLBACK);
  }
}
