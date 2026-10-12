/**
 * Constants shared by the server and the frontend. Kept free of runtime
 * dependencies so the browser bundle stays small.
 */

/** launchd label of the macOS user agent written by `service.ts`. */
export const SERVICE_LABEL = "com.mergeatron.service";

/** Label before the rename to mergeatron; `bun service.ts migrate` replaces an agent installed under it. */
export const LEGACY_SERVICE_LABEL = "com.t3.review-orchestrator";

export const WORKSPACE_MODES = ["worktree", "local"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

/** T3 Code runtime modes, from packages/contracts/src/providerPolicy.ts. */
export const RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

/**
 * How a run was triggered: `github` is the webhook endpoint, `slack` the Socket
 * Mode connection, `poll` an inbox automation (see poller.ts), `manual` a
 * dispatch from the inbox view or the connection test in the header.
 */
export const RUN_SOURCES = ["github", "slack", "poll", "manual"] as const;
export type RunSource = (typeof RUN_SOURCES)[number];

/**
 * Where a run is: `queued` waits for its rule's concurrency limit, `started`
 * has a thread running, `done`/`failed` once its first turn settles.
 */
export const RUN_STATUSES = ["queued", "started", "done", "skipped", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** What owns an editable versioned prompt: a dispatch preset, or a rule's own prompt. */
export const PROMPT_OWNERS = ["preset", "rule"] as const;
export type PromptOwner = (typeof PROMPT_OWNERS)[number];

/**
 * What a stored prompt version can belong to: the editable owners, plus
 * `dispatch` for text edited by hand in the inbox's dispatch dialog, saved as
 * a one-off version (its own id, version 1) so every run's prompt is a version.
 */
export const PROMPT_VERSION_OWNERS = [...PROMPT_OWNERS, "dispatch"] as const;
export type PromptVersionOwner = (typeof PROMPT_VERSION_OWNERS)[number];

/** Where a prompt version was saved from: the UI, or an agent through the MCP tools. */
export const PROMPT_VERSION_SOURCES = ["ui", "mcp"] as const;
export type PromptVersionSource = (typeof PROMPT_VERSION_SOURCES)[number];

/** APIs the inbox polls for PRs and issues that involve you. */
export const INBOX_SOURCES = ["github", "linear", "sentry"] as const;
export type InboxSource = (typeof INBOX_SOURCES)[number];

/** What a source needs before it polls, shown where it is off. */
export const INBOX_SOURCE_SETUP: Record<InboxSource, string> = {
  github: "Install and log in to the gh CLI",
  linear: "Set LINEAR_API_KEY in .env",
  sentry: "Set SENTRY_AUTH_TOKEN and SENTRY_ORG in .env",
};

export const INBOX_KINDS = ["pull_request", "issue"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/**
 * Why an item is in your inbox. One item can have several. `watching` is a
 * Sentry issue that passes the Sentry filters in Settings; every Sentry issue
 * has it, those assigned to you have `assigned` too.
 */
export const INBOX_REASONS = ["review_requested", "assigned", "mentioned", "authored", "watching"] as const;
export type InboxReason = (typeof INBOX_REASONS)[number];
export const INBOX_REASON_LABELS: Record<InboxReason, string> = {
  review_requested: "review requested",
  assigned: "assigned to me",
  mentioned: "mentioned",
  authored: "authored by me",
  watching: "watching",
};

/** Rule keys for polled inbox items are `inbox.<source>.<kind>`. */
export const INBOX_EVENT_PREFIX = "inbox.";
export function inboxEvent(source: InboxSource, kind: InboxKind): string {
  return `${INBOX_EVENT_PREFIX}${source}.${kind}`;
}

/** The source of an `inbox.<source>.<kind>` key; null for webhook and Slack events. A rule polls one source at most. */
export function inboxSource(event: string): InboxSource | null {
  return INBOX_SOURCES.find((source) => event.startsWith(`${INBOX_EVENT_PREFIX}${source}.`)) ?? null;
}

/**
 * Filters a rule applies on top of its event, matched against the delivery's
 * template variables (`reasons`, `labels`, `state`/`state_type`, `team`), so
 * they work for webhook deliveries that carry those variables too. An empty
 * list or expression matches anything.
 */
export type RuleFilters = {
  reasons: InboxReason[];
  /** Label expression such as `(bug or p0) and !wontfix`; see `labelQuery.ts`. Empty matches anything. */
  labels: string;
  /** GitHub: `open` or `draft`. Linear: state name (`Todo`) or type (`unstarted`). Sentry: substatus (`escalating`) or status (`unresolved`). */
  states: string[];
  /** Linear team keys, or Sentry project slugs. */
  teams: string[];
  /** Inbox PR rules: run again when the PR head moves, like `pull_request.synchronize`. */
  rerunOnPush: boolean;
};
export const EMPTY_FILTERS: RuleFilters = { reasons: [], labels: "", states: [], teams: [], rerunOnPush: true };

/**
 * Threads one rule may have running at once. Matches past the limit are
 * recorded as `queued` and start as earlier ones settle; 0 means no limit.
 */
export const DEFAULT_MAX_CONCURRENT = 3;

/** How often each inbox source is polled (Settings). */
export type PollingSettings = Record<InboxSource, { enabled: boolean; minutes: number }>;
export const DEFAULT_POLLING: PollingSettings = {
  github: { enabled: true, minutes: 3 },
  linear: { enabled: true, minutes: 3 },
  sentry: { enabled: true, minutes: 3 },
};

/**
 * Which Sentry issues reach the inbox (Settings → Sentry); an empty list does
 * not filter. `projects` are project slugs, usually one per service.
 * `environments` match any of the listed. `tags` are search terms such as
 * `service:checkout`, see `sentryQuery`.
 */
export type SentryFilters = { projects: string[]; environments: string[]; tags: string[] };
export const EMPTY_SENTRY_FILTERS: SentryFilters = { projects: [], environments: [], tags: [] };

/**
 * The issue search for the tag filters, as Sentry's own search would read
 * it: unresolved issues, `key:value` terms of one key joined into
 * `key:[a,b]` so they match any value, different keys all required. Terms
 * without a key (free text) or already in list or quoted syntax pass as typed.
 */
export function sentryQuery(tags: string[]): string {
  const byKey = new Map<string, string[]>();
  const asTyped: string[] = [];
  for (const term of new Set(tags.map((tag) => tag.trim()).filter(Boolean))) {
    const colon = term.indexOf(":");
    const value = term.slice(colon + 1);
    if (colon <= 0 || !value || /^["[]/.test(value)) asTyped.push(term);
    else byKey.set(term.slice(0, colon), [...(byKey.get(term.slice(0, colon)) ?? []), value]);
  }
  const grouped = [...byKey].map(([key, values]) => (values.length === 1 ? `${key}:${searchValue(values[0]!)}` : `${key}:[${values.map(searchValue).join(",")}]`));
  return ["is:unresolved", ...grouped, ...asTyped].join(" ");
}

/** A search value, quoted when it holds characters the search syntax would split on. */
function searchValue(value: string): string {
  return /[\s,"()[\]]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

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
  { key: "slack.second_pass", label: "Slack: 'second/third/next/another pass' mention in a review thread" },
  { key: "inbox.github.pull_request", label: "Inbox: GitHub PR" },
  { key: "inbox.github.issue", label: "Inbox: GitHub issue" },
  { key: "inbox.linear.issue", label: "Inbox: Linear issue" },
  { key: "inbox.sentry.issue", label: "Inbox: Sentry issue" },
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

/** Variables available to prompt templates as `{{name}}`. See extractContext in github.ts, slack.ts and itemContext in inbox.ts. */
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
  "labels",
  "state",
  "state_type",
  "reasons",
  "team",
  "priority",
  "issue_identifier",
  "branch",
  "review_decision",
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

/**
 * Prompt presets the inbox composer offers, seeded when the table is empty.
 * Presets are composable: several can be stacked into one dispatch.
 */
export const DEFAULT_PROMPTS: { name: string; body: string }[] = [
  {
    name: "Review PR",
    body: `Review pull request {{pr_url}} ("{{pr_title}}" by {{pr_author}}, {{pr_head}} -> {{pr_base}}).

You are checked out on the PR head. Read the diff against {{pr_base}}, then look for correctness bugs, missing tests and unclear code. Keep findings concrete, one line each with file:line. Post nothing to GitHub; report here.`,
  },
  {
    name: "Implement issue",
    body: `Implement {{issue_url}} ("{{issue_title}}").

{{issue_body}}

Work on a branch from {{default_branch}}. Read the relevant code first, keep the change small and focused, add or update tests, and finish with a short summary of what changed and anything left open. Do not open a pull request unless asked.`,
  },
  {
    name: "Address review feedback",
    body: `Pull request {{pr_url}} ("{{pr_title}}") has review feedback ({{review_decision}}).

You are checked out on the PR head. Read every unresolved review comment with the gh CLI, fix what is right, push back in one line where a comment is wrong, and push the fixes to {{pr_head}}. Summarise what you changed per comment.`,
  },
];
