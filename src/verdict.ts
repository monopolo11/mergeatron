import type { Run } from "./rules.ts";
import { HANDOFF_EVENT } from "./shared.ts";

/**
 * How a finished review is read. Free of server dependencies: the store
 * derives PR statuses from it and the frontend shows the verdict type.
 */

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
 * The latest reviews of a PR that asked for changes in a row, newest first, from
 * its finished runs. An approval ends the streak, a reply with no verdict is
 * ignored, and handoffs are not reviews.
 */
export function changesRequestedStreak<T extends Pick<Run, "event" | "result">>(finished: T[]): T[] {
  const streak: T[] = [];
  for (const run of finished) {
    if (run.event === HANDOFF_EVENT) continue;
    const verdict = reviewVerdict(run.result);
    if (verdict === "approved") break;
    if (verdict === "changes_requested") streak.push(run);
  }
  return streak;
}
