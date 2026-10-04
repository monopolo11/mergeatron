import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import {
  DEFAULT_HANDOFF_PROMPT,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_POLLING,
  DEFAULT_REVIEW_REQUEST_MESSAGE,
  DEFAULT_SECOND_PASS_MESSAGE,
  EMPTY_FILTERS,
  EMPTY_SENTRY_FILTERS,
  INBOX_KINDS,
  INBOX_SOURCES,
  PROMPT_OWNERS,
  PROMPT_VERSION_SOURCES,
  RUNTIME_MODES,
  RUN_SOURCES,
  WORKSPACE_MODES,
  type InboxReason,
  type PollingSettings,
  type RuleFilters,
  type SentryFilters,
} from "../shared.ts";

export type ModelSelection = { instanceId: string; model: string };

export const rules = sqliteTable("rules", {
  id: text().primaryKey(),
  name: text().notNull(),
  enabled: integer({ mode: "boolean" }).notNull().default(true),
  /** Event keys this rule fires on, e.g. `pull_request.review_requested`, `slack.message`. */
  events: text({ mode: "json" }).$type<string[]>().notNull().default([]),
  /** `owner/name` filters. Empty means every repository. */
  repos: text({ mode: "json" }).$type<string[]>().notNull().default([]),
  /** Only fire when this login (or team slug) is the requested reviewer. */
  reviewer: text(),
  /** Slack rules only: fire for messages in this channel id. Null means any channel the bot is in. */
  channel: text(),
  /**
   * Slack rules only: also fire for posts by other bots and apps (another
   * orchestrator's MCP requests, GitHub notifications). Our own bot's posts
   * never fire rules.
   */
  allowBots: integer("allow_bots", { mode: "boolean" }).notNull().default(true),
  /** Skip PRs authored by the GitHub login in settings: reviewing your own PR is bad practice. */
  skipSelfReview: integer("skip_self_review", { mode: "boolean" }).notNull().default(true),
  /** Filters on the delivery's template variables, mainly for inbox rules; see RuleFilters. */
  filters: text({ mode: "json" }).$type<RuleFilters>().notNull().default(EMPTY_FILTERS),
  /** Threads of this rule running at once; further matches queue. 0 means no limit. */
  maxConcurrent: integer("max_concurrent").notNull().default(DEFAULT_MAX_CONCURRENT),
  /** T3 project to open the thread in. Null means match by the repository's git remote. */
  projectId: text("project_id"),
  workspace: text({ enum: WORKSPACE_MODES }).notNull().default("worktree"),
  /** Null means use the project default, then the global default. */
  model: text({ mode: "json" }).$type<ModelSelection | null>(),
  /**
   * The rule's own prompt text; used when `presetId` is null or its preset is
   * gone. A copy of the promoted version's body (see `promptVersions`),
   * written only by the store when a version is created live or promoted.
   */
  prompt: text().notNull(),
  /** Version of the rule's prompt that `prompt` holds. */
  livePromptVersion: integer("live_prompt_version").notNull().default(1),
  /** A dispatch preset whose body replaces `prompt` at start time, so editing the preset updates every rule using it. */
  presetId: text("preset_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * What a run starts with: the slice of its rule that `startThreadForRule`
 * reads. Frozen on queued runs, since the rule may change meanwhile and a
 * dispatch from the inbox has no stored rule at all.
 */
export type RunAction = Pick<typeof rules.$inferSelect, "name" | "skipSelfReview" | "projectId" | "workspace" | "model" | "prompt" | "presetId" | "maxConcurrent">;

/** Single-row table holding the global defaults. */
export const settings = sqliteTable("settings", {
  id: integer().primaryKey(),
  model: text({ mode: "json" }).$type<ModelSelection>().notNull(),
  runtimeMode: text("runtime_mode", { enum: RUNTIME_MODES }).notNull(),
  /** Your GitHub login, so rules can skip PRs you authored. Null disables the check. */
  githubLogin: text("github_login"),
  /**
   * Reviews of one PR that request changes in a row before automated review
   * pauses and a handoff thread is written. 0 never pauses.
   */
  maxChangesRequestedRounds: integer("max_changes_requested_rounds").notNull().default(3),
  /** First message of the handoff thread; see DEFAULT_HANDOFF_PROMPT for its variables. */
  handoffPrompt: text("handoff_prompt").notNull().default(DEFAULT_HANDOFF_PROMPT),
  /** Channel id (or `#name`) the MCP `request_review` tool posts to when the agent names none. */
  reviewChannel: text("review_channel"),
  /** Your Slack user id (`U…`), whom the MCP `notify_user` tool DMs. Null turns the tool off. */
  slackUserId: text("slack_user_id"),
  /** Messages the MCP review tools post; see REVIEW_MESSAGE_VARS. */
  reviewRequestMessage: text("review_request_message").notNull().default(DEFAULT_REVIEW_REQUEST_MESSAGE),
  secondPassMessage: text("second_pass_message").notNull().default(DEFAULT_SECOND_PASS_MESSAGE),
  /** Whether and how often each inbox source (GitHub, Linear, Sentry) is polled. Sources added later are filled in by `Store.getSettings`. */
  polling: text({ mode: "json" }).$type<PollingSettings>().notNull().default(DEFAULT_POLLING),
  /** Which Sentry issues reach the inbox: projects, environments, tags. */
  sentryFilters: text("sentry_filters", { mode: "json" }).$type<SentryFilters>().notNull().default(EMPTY_SENTRY_FILTERS),
});

/**
 * A PR or issue that involves you, as last polled from GitHub, Linear or Sentry. One
 * shape for every source so the inbox, the composer and rule filters treat
 * them alike. Rows outlive the poll: `goneAt` marks when an item stopped
 * coming back (closed, merged, unassigned, done), and `firstSeenAt` restarts
 * when it comes back. See src/inbox.ts for the derived types.
 */
export const inboxItems = sqliteTable("inbox_items", {
  /** `github:owner/name#123`, `linear:ENG-123` or `sentry:BACKEND-3F`. */
  key: text().primaryKey(),
  source: text({ enum: INBOX_SOURCES }).notNull(),
  kind: text({ enum: INBOX_KINDS }).notNull(),
  /** `owner/name` for GitHub; null for Linear and Sentry issues, which have no repository. */
  repo: text(),
  /** Short handle shown in lists: `#123`, `ENG-123` or Sentry's short id `BACKEND-3F`. */
  identifier: text().notNull(),
  title: text().notNull(),
  url: text().notNull(),
  body: text(),
  author: text(),
  /** GitHub: `open` or `draft`. Linear: the workflow state name, e.g. `Todo`. Sentry: the substatus (`new`, `escalating`, ...), else the status. */
  state: text().notNull(),
  /** Linear workflow state type: backlog, unstarted, started, ... Sentry status: `unresolved`. Null for GitHub. */
  stateType: text("state_type"),
  /** Labels; for Sentry, the issue level (`error`, `fatal`, ...). */
  labels: text({ mode: "json" }).$type<string[]>().notNull().default([]),
  reasons: text({ mode: "json" }).$type<InboxReason[]>().notNull().default([]),
  /** Linear team key, or Sentry project slug. */
  team: text(),
  /** Linear priority label (`Urgent`, `High`, ...), or Sentry priority (`high`, ...). */
  priority: text(),
  /** PR head branch, or Linear's suggested branch name. */
  branch: text(),
  /** PR head commit; a new one means new commits to review. */
  headSha: text("head_sha"),
  /** PR base branch. */
  base: text(),
  /** GitHub `reviewDecision`: REVIEW_REQUIRED, APPROVED, CHANGES_REQUESTED, or null. */
  reviewDecision: text("review_decision"),
  repoUrl: text("repo_url"),
  defaultBranch: text("default_branch"),
  /** The item's own timestamps, from the API; first and last seen for Sentry. */
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** When this stay in the inbox began; reset when a gone item comes back. */
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  /** Null while the source still returns the item; set by the first poll that did not. */
  goneAt: text("gone_at"),
});

/**
 * Prompt presets for dispatching inbox items by hand. The composer stacks
 * one or more into the thread's first message; rules keep their own prompt.
 */
export const prompts = sqliteTable("prompts", {
  id: text().primaryKey(),
  name: text().notNull(),
  /** A copy of the promoted version's body (see `promptVersions`); what dispatches and linked rules use. */
  body: text().notNull(),
  /** Version that `body` holds. */
  liveVersion: integer("live_version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Every saved revision of a preset's body or a rule's own prompt. Saving
 * never edits a version: it appends the next number, and promoting one copies
 * its body onto the owner, which is what runs use. Versions go with their owner.
 */
export const promptVersions = sqliteTable(
  "prompt_versions",
  {
    owner: text({ enum: PROMPT_OWNERS }).notNull(),
    /** Id of the preset or rule. */
    ownerId: text("owner_id").notNull(),
    /** 1, 2, 3... per owner. */
    version: integer().notNull(),
    body: text().notNull(),
    /** Why this version exists, e.g. what an agent changed. */
    note: text(),
    source: text({ enum: PROMPT_VERSION_SOURCES }).notNull().default("ui"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.owner, table.ownerId, table.version] })],
);

/**
 * One delivery matched against one rule. `queued` waits for the rule's
 * concurrency limit, `started` means the thread is running; `done`/`failed`
 * are set once its first turn settles.
 */
export const runs = sqliteTable(
  "runs",
  {
    id: text().primaryKey(),
    ruleId: text("rule_id").notNull(),
    ruleName: text("rule_name").notNull(),
    deliveryId: text("delivery_id").notNull(),
    event: text().notNull(),
    repo: text().notNull(),
    /** Which trigger produced the run; see RUN_SOURCES. */
    source: text({ enum: RUN_SOURCES }).notNull().default("github"),
    /** PR or issue author the review is for. Null for connection tests. */
    author: text(),
    status: text({ enum: ["queued", "started", "done", "skipped", "failed"] }).notNull(),
    detail: text().notNull().default(""),
    threadId: text("thread_id"),
    threadUrl: text("thread_url"),
    /** Template variables extracted from the delivery, used to preview prompts in the UI. */
    context: text({ mode: "json" }).$type<Record<string, string>>(),
    /** Final assistant message of the thread's first turn, once it settles. */
    result: text(),
    /** Set while queued: what to start with once the rule has capacity. */
    action: text({ mode: "json" }).$type<RunAction>(),
    createdAt: text("created_at").notNull(),
  },
  // GitHub retries deliveries; one thread per delivery per rule.
  (table) => [unique().on(table.deliveryId, table.ruleId)],
);

/**
 * A PR an agent sent for review through the MCP tools: the Slack thread its
 * request lives in and how many review rounds it has asked for. One per PR;
 * second passes reply in the same thread.
 */
export const reviewRequests = sqliteTable(
  "review_requests",
  {
    id: text().primaryKey(),
    /** `owner/name`, lowercased so lookups by PR URL match regardless of case. */
    repo: text().notNull(),
    prNumber: text("pr_number").notNull(),
    prUrl: text("pr_url").notNull(),
    /** Channel id Slack resolved the post to, even when the agent passed `#name`. */
    channel: text().notNull(),
    /** `ts` of the request message; everything after it is a reply in its thread. */
    threadTs: text("thread_ts").notNull(),
    permalink: text(),
    /** 1 for the first request, +1 per second pass. */
    round: integer().notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [unique().on(table.repo, table.prNumber)],
);
