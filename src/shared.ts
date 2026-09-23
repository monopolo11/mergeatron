/**
 * Constants shared by the server and the frontend. Kept free of runtime
 * dependencies so the browser bundle stays small.
 */

/** launchd label of the macOS user agent written by `service.ts`. */
export const SERVICE_LABEL = "com.t3.review-orchestrator";

export const WORKSPACE_MODES = ["worktree", "local"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

/** T3 Code runtime modes, from packages/contracts/src/orchestration.ts. */
export const RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

/**
 * How a run was triggered: `github` is the webhook endpoint, `slack` the Socket
 * Mode connection, `manual` the connection test in the header.
 */
export const RUN_SOURCES = ["github", "slack", "manual"] as const;
export type RunSource = (typeof RUN_SOURCES)[number];

/**
 * Events offered by the rule editor's picker. GitHub keys are `<event>.<action>`
 * (or just `<event>` when the payload has no action); Slack keys are
 * `slack.<type>`. Matching is a plain string compare, so a rule saved with a
 * key outside this list (via the API) still works and shows under "Custom".
 */
export const SUGGESTED_EVENTS = [
  { key: "pull_request.review_requested", label: "PR: review requested" },
  { key: "pull_request.opened", label: "PR: opened" },
  { key: "pull_request.ready_for_review", label: "PR: ready for review" },
  { key: "pull_request.synchronize", label: "PR: new commits pushed" },
  { key: "pull_request.reopened", label: "PR: reopened" },
  { key: "pull_request.labeled", label: "PR: labeled" },
  { key: "pull_request_review.submitted", label: "PR review: submitted" },
  { key: "pull_request_review_comment.created", label: "PR review comment: created" },
  { key: "issue_comment.created", label: "Issue/PR comment: created" },
  { key: "issues.opened", label: "Issue: opened" },
  { key: "issues.assigned", label: "Issue: assigned" },
  { key: "issues.labeled", label: "Issue: labeled" },
  { key: "slack.app_mention", label: "Slack: bot mentioned" },
  { key: "slack.message", label: "Slack: PR link posted in channel" },
  { key: "slack.second_pass", label: "Slack: 'second pass' mention in a review thread" },
] as const;

/** Rules whose event starts with this prefix are fed by the Slack webhook, not GitHub. */
export const SLACK_EVENT_PREFIX = "slack.";

/** Variables available to prompt templates as `{{name}}`. See extractContext in github.ts and slack.ts. */
export const TEMPLATE_VARS = [
  "repo",
  "repo_url",
  "default_branch",
  "event",
  "action",
  "sender",
  "pr_number",
  "pr_title",
  "pr_url",
  "pr_body",
  "pr_author",
  "pr_head",
  "pr_base",
  "pr_head_sha",
  "requested_reviewer",
  "issue_number",
  "issue_title",
  "issue_url",
  "issue_body",
  "issue_author",
  "comment_body",
  "comment_author",
  "comment_url",
  "review_state",
  "review_body",
  "review_author",
  "label",
  "slack_channel",
  "slack_user",
  "slack_ts",
  "slack_text",
  "slack_thread_ts",
  "previous_result",
  "previous_thread_url",
] as const;
export type TemplateVar = (typeof TEMPLATE_VARS)[number];
