import { foreignKey, index, integer, primaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
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
  PROMPT_VERSION_OWNERS,
  PROMPT_VERSION_SOURCES,
  RUNTIME_MODES,
  RUN_SOURCES,
  RUN_STATUSES,
  WORKSPACE_MODES,
  type InboxReason,
  type PollingSettings,
  type PromptVersionOwner,
  type RuleFilters,
  type SentryFilters,
} from "../shared.ts";

/**
 * A model option in T3's own shape, e.g. `{ id: "effort", value: "high" }`.
 * The reasoning level is the model's first select option (`effort` for
 * Claude, `reasoningEffort` for Codex), as in T3's own picker.
 */
export type ModelOption = { id: string; value: string | boolean };

/** Provider instance, model and options, passed to T3 as its `modelSelection`. No options means the model's defaults. */
export type ModelSelection = { instanceId: string; model: string; options?: ModelOption[] };

/** One prompt version, as a run records what its first message came from. */
export type PromptRef = { owner: PromptVersionOwner; id: string; version: number };

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
 * reads, and the prompt versions its message is made of (in order). Stored
 * per run in `runActions` and `runPrompts`, since the rule may change while
 * the run waits and a dispatch from the inbox has no stored rule at all.
 */
export type RunAction = Pick<typeof rules.$inferSelect, "name" | "skipSelfReview" | "projectId" | "workspace" | "model" | "presetId" | "maxConcurrent"> & {
  promptRefs: PromptRef[];
};

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
  /** Who the MCP review tools tag when the agent names no one: Slack user ids, group ids, or here/channel. */
  reviewMentions: text("review_mentions", { mode: "json" }).$type<string[]>().notNull().default([]),
  /** Your Slack user id (`U…`), whom the MCP `notify_user` tool DMs. Null turns the tool off. */
  slackUserId: text("slack_user_id"),
  /** React with `:skip:` instead of ⏩ when a Slack message is seen but not reviewed. */
  skipReaction: integer("skip_reaction", { mode: "boolean" }).notNull().default(false),
  /** A run's usage also counts the T3 tasks its thread delegated, which run in threads of their own (see usage.ts). */
  usageIncludesDelegatedTasks: integer("usage_includes_delegated_tasks", { mode: "boolean" }).notNull().default(true),
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
 * Every saved revision of a preset's body or a rule's own prompt, and the
 * hand-edited text of dispatches. Saving never edits a version: it appends
 * the next number, and promoting one copies its body onto the owner, which is
 * what runs use. Versions outlive their owner: runs reference them.
 */
export const promptVersions = sqliteTable(
  "prompt_versions",
  {
    owner: text({ enum: PROMPT_VERSION_OWNERS }).notNull(),
    /** Id of the preset, rule or dispatch. */
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
 * are set once its first turn settles. `createdAt` is when the delivery
 * arrived, `startedAt` when the thread opened, `settledAt` when the run ended.
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
    status: text({ enum: RUN_STATUSES }).notNull(),
    detail: text().notNull().default(""),
    threadId: text("thread_id"),
    threadUrl: text("thread_url"),
    /** Template variables extracted from the delivery, used to preview prompts in the UI. */
    context: text({ mode: "json" }).$type<Record<string, string>>(),
    /** Final assistant message of the thread's first turn, once it settles. */
    result: text(),
    /** Provider instance of the model the thread started with, after the project and global defaults, e.g. `claudeAgent`. */
    modelInstanceId: text("model_instance_id"),
    /** Model the thread started with, e.g. `claude-opus-5-5`. Null until a thread starts. */
    modelId: text("model_id"),
    /** Reasoning level the thread started with, e.g. `high`; null when the model's default or no thread. */
    reasoning: text(),
    /** How good the run was, 0 to 10, from a person or an agent. Null until rated or when only feedback was given. */
    rating: integer(),
    /** Written review of the run that goes with the rating. */
    feedback: text(),
    ratedAt: text("rated_at"),
    /** The earlier run this one follows up: it addresses (fixes) that run's implementation. Set with the rating; cleared if that run is deleted. */
    followUpOf: text("follow_up_of"),
    /**
     * When T3 last answered for the PRs linked to its thread (see
     * runPullRequests.ts), with them or with the thread gone. Null until then:
     * startup reads settled runs that are still null.
     */
    pullRequestsCheckedAt: text("pull_requests_checked_at"),
    /**
     * When a backfill found nothing to measure for this run (T3 names no
     * session, or ccusage has no log for it): the backfill stops trying it.
     * Null until then, and for measured runs.
     */
    usageUnmeasurableAt: text("usage_unmeasurable_at"),
    /** When the T3 thread opened; later than `createdAt` by any queue wait. Null if no thread ever opened. */
    startedAt: text("started_at"),
    /** When the run reached done, skipped or failed. */
    settledAt: text("settled_at"),
    /** `settledAt` minus `startedAt`: how long the thread worked. Null without both. */
    elapsedMs: integer("elapsed_ms"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    // GitHub retries deliveries; one thread per delivery per rule.
    unique().on(table.deliveryId, table.ruleId),
    // Concurrency counts and the queue, per rule.
    index("runs_rule_status_idx").on(table.ruleId, table.status),
    // Time-range scans, newest first.
    index("runs_created_at_idx").on(table.createdAt),
    index("runs_model_idx").on(table.modelId, table.modelInstanceId),
    foreignKey({ columns: [table.followUpOf], foreignColumns: [table.id] }).onDelete("set null"),
  ],
);

/**
 * How many times an issue re-entered a rule's filters after the rule ran for
 * it. The issue's delivery id for the rule carries the generation (see
 * `itemDeliveryId`), so each re-entry fires the rule again. No row means
 * generation 0, the bare item key.
 */
export const ruleGenerations = sqliteTable(
  "rule_generations",
  {
    ruleId: text("rule_id")
      .notNull()
      .references(() => rules.id, { onDelete: "cascade" }),
    /** Inbox item key, e.g. `linear:ENG-123`. Not a foreign key: it outlives pruned items, whose runs it must keep apart. */
    itemKey: text("item_key").notNull(),
    generation: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.ruleId, table.itemKey] })],
);

/**
 * Prompt versions a run's first message is made of, in order: the linked
 * preset or the rule's own prompt, the stacked presets of a dispatch, or the
 * dispatch's hand-edited text. Rendering their bodies, joined by a blank
 * line, with the run's `context` gives the message. Set when the run is
 * recorded and replaced with what was used when its thread starts (a linked
 * preset's live version then). None for handoffs and connection tests.
 */
export const runPrompts = sqliteTable(
  "run_prompts",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** 0, 1, 2... in message order. */
    position: integer().notNull(),
    owner: text({ enum: PROMPT_VERSION_OWNERS }).notNull(),
    ownerId: text("owner_id").notNull(),
    version: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.position] }),
    foreignKey({ columns: [table.owner, table.ownerId, table.version], foreignColumns: [promptVersions.owner, promptVersions.ownerId, promptVersions.version] }),
    index("run_prompts_version_idx").on(table.owner, table.ownerId, table.version),
  ],
);

/**
 * What each rule-driven run was set to start with (see RunAction), one row
 * per run: the rule's settings at the time, frozen so a queued run starts as
 * matched. Its prompt is the run's `runPrompts`. None for handoffs and
 * connection tests.
 */
export const runActions = sqliteTable(
  "run_actions",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** Rule name, or the stacked preset names of a dispatch. */
    name: text().notNull(),
    skipSelfReview: integer("skip_self_review", { mode: "boolean" }).notNull(),
    /** T3 project asked for; null matches by the repository's git remote. */
    projectId: text("project_id"),
    workspace: text({ enum: WORKSPACE_MODES }).notNull(),
    /** Model asked for; null falls back to the project, then the global default. The model used is on the run. */
    modelInstanceId: text("model_instance_id"),
    modelId: text("model_id"),
    /** Options of the model asked for, such as its reasoning level; null means its defaults. */
    modelOptions: text("model_options", { mode: "json" }).$type<ModelOption[]>(),
    /** Preset whose live version replaces the run's prompt at start; null once the preset is deleted. */
    presetId: text("preset_id").references(() => prompts.id, { onDelete: "set null" }),
    maxConcurrent: integer("max_concurrent").notNull(),
  },
  (table) => [
    index("run_actions_project_idx").on(table.projectId),
    index("run_actions_preset_idx").on(table.presetId),
    index("run_actions_model_idx").on(table.modelId, table.modelInstanceId),
  ],
);

/**
 * What a run's thread spent, as ccusage reads it from the agent's local
 * session logs (see usage.ts): tokens by kind and the estimated cost, summed
 * over the thread's provider sessions, subagents included. Measured when the
 * run settles; no row means it was not measured (no thread, no logs found).
 */
export const runUsage = sqliteTable(
  "run_usage",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "cascade" }),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheCreationTokens: integer("cache_creation_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    /** The four kinds above added up. */
    totalTokens: integer("total_tokens").notNull(),
    /** Estimated from list prices by ccusage, not what was billed. */
    costUsd: real("cost_usd").notNull(),
    /** Every model that answered, main agent and subagents, e.g. `claude-opus-5-5`. */
    models: text({ mode: "json" }).$type<string[]>().notNull(),
    /** Provider session ids measured (Claude Code session ids). */
    sessionIds: text("session_ids", { mode: "json" }).$type<string[]>().notNull(),
    collectedAt: text("collected_at").notNull(),
  },
  // Most expensive runs first (list_runs sort "cost").
  (table) => [index("run_usage_cost_idx").on(table.costUsd)],
);

/**
 * PRs linked in T3 to a run's thread or to the tasks it delegated (see
 * runPullRequests.ts): the PR a review was started on, and those the agent
 * opened or worked on. Read when the run settles, at startup for settled
 * runs never read (see `runs.pullRequestsCheckedAt`), and whenever the run is
 * opened in the UI; title and state are T3's last GitHub sync, null until the
 * first.
 */
export const runPullRequests = sqliteTable(
  "run_pull_requests",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** `owner/name`. */
    repository: text().notNull(),
    number: integer().notNull(),
    url: text().notNull(),
    title: text(),
    state: text({ enum: ["open", "closed", "merged"] }),
    isDraft: integer("is_draft", { mode: "boolean" }).notNull().default(false),
    /** When it was linked to the thread. */
    linkedAt: text("linked_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.repository, table.number] })],
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
    /** Slack tags of the latest round, reused when a second pass names no one. */
    mentions: text().notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [unique().on(table.repo, table.prNumber)],
);
