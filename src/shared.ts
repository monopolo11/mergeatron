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

/**
 * Event of the run that writes the handoff document once a PR's reviews keep
 * requesting changes. Not a review: its reply never feeds `{{previous_result}}`
 * or the change-request streak.
 */
export const HANDOFF_EVENT = "review.handoff";

/**
 * Default first message of the handoff thread (Settings). Besides the PR
 * variables it gets `{{rounds}}` (change requests in a row) and
 * `{{review_history}}` (the streak's review reports, oldest first).
 */
export const DEFAULT_HANDOFF_PROMPT = `Pull request {{pr_url}} ("{{pr_title}}" by {{pr_author}}) has had {{rounds}} automated reviews in a row end in "changes requested", so automated review is paused and a human needs to take over.

You are checked out on the PR head. Below are the {{rounds}} review reports, oldest first. Read them, look at the current diff against {{pr_base}} and the PR's commit history, and write a handoff document that explains why this PR is not converging: which findings recur across rounds, which were fixed and came back, where the scope moved between rounds, and what is still open. End with a short recommendation (split the PR, rescope it, pair with the author, or merge with a named follow-up). Do not review the code again and post nothing to GitHub; reply with the document only.

{{review_history}}`;

/** Extra template variables the handoff prompt gets on top of TEMPLATE_VARS. */
export const HANDOFF_TEMPLATE_VARS = ["rounds", "review_history"] as const;

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
  "slack_bot_id",
  "previous_result",
  "previous_thread_url",
  "review_round",
] as const;
export type TemplateVar = (typeof TEMPLATE_VARS)[number];

/**
 * Slack messages the MCP tools post for agents (Settings). Rendered with
 * REVIEW_MESSAGE_VARS; Markdown is converted to mrkdwn and raw Slack syntax
 * such as `<@U123>` or `<!subteam^S123>` passes through, so fixed tags can
 * live in the template. Blank lines left by empty variables are dropped.
 */
export const DEFAULT_REVIEW_REQUEST_MESSAGE = `Review requested {{mentions}}
[{{repo}}#{{pr_number}}]({{pr_url}}) {{pr_title}}
{{note}}`;
export const DEFAULT_SECOND_PASS_MESSAGE = `Round {{round}}: second pass requested {{mentions}}
{{note}}`;

/** Variables of the review request messages. `mentions` and `note` come from the agent's tool call. */
export const REVIEW_MESSAGE_VARS = ["repo", "pr_number", "pr_url", "pr_title", "pr_author", "round", "mentions", "note"] as const;
