import type { Verdict } from "../../src/completion.ts";
import type { Run, RunPullRequest } from "../../src/rules.ts";
import type { PullRequestStatus } from "../../src/store.ts";

/**
 * The five colours the UI uses for state. Everything that reports a state
 * (runs, PRs, connections, polling) maps to one of these, so the same colour
 * means the same thing on every page.
 */
export type Tone = "ok" | "warn" | "err" | "active" | "idle";

export const TONE_TEXT = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-destructive",
  active: "text-active",
  idle: "text-muted-foreground",
} as const satisfies Record<Tone, string>;

export const TONE_BG = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-destructive",
  active: "bg-active",
  idle: "bg-muted-foreground",
} as const satisfies Record<Tone, string>;

export type StatusLabel = { label: string; tone: Tone };

/** Label and tone for a run. Once a review settled, its verdict replaces "done". */
export function runStatus({ status, verdict }: { status: Run["status"]; verdict?: Verdict | null }): StatusLabel {
  switch (status) {
    case "queued":
      return { label: "queued", tone: "idle" };
    case "started":
      return { label: "running", tone: "active" };
    case "done":
      if (verdict === "approved") return { label: "approved", tone: "ok" };
      if (verdict === "changes_requested") return { label: "changes requested", tone: "warn" };
      return { label: "done", tone: "ok" };
    case "skipped":
      return { label: "skipped", tone: "warn" };
    case "failed":
      return { label: "failed", tone: "err" };
  }
}

/** Label and tone for a PR's GitHub state as T3 last synced it; an open draft reads as a draft. Null before the first sync. */
export function prState({ state, isDraft }: Pick<RunPullRequest, "state" | "isDraft">): StatusLabel | null {
  switch (state) {
    case null:
      return null;
    case "open":
      return isDraft ? { label: "draft", tone: "idle" } : { label: "open", tone: "active" };
    case "merged":
      return { label: "merged", tone: "ok" };
    case "closed":
      return { label: "closed", tone: "err" };
  }
}

/** Tone of a 0 to 10 run score: 8 and up is good, under 5 is bad. */
export const scoreTone = (rating: number): Tone => (rating >= 8 ? "ok" : rating >= 5 ? "warn" : "err");

/** Label and tone for a PR's aggregate review status. */
export const PR_STATUS = {
  reviewing: { label: "reviewing", tone: "active" },
  queued: { label: "queued", tone: "idle" },
  paused: { label: "paused", tone: "err" },
  changes_requested: { label: "changes requested", tone: "warn" },
  approved: { label: "approved", tone: "ok" },
  commented: { label: "no verdict", tone: "idle" },
  skipped: { label: "skipped", tone: "warn" },
  failed: { label: "failed", tone: "err" },
} as const satisfies Record<PullRequestStatus, StatusLabel>;
