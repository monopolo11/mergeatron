import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import {
  DEFAULT_HANDOFF_PROMPT,
  DEFAULT_REVIEW_REQUEST_MESSAGE,
  DEFAULT_SECOND_PASS_MESSAGE,
  RUNTIME_MODES,
  RUN_SOURCES,
  WORKSPACE_MODES,
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
  /** T3 project to open the thread in. Null means match by the repository's git remote. */
  projectId: text("project_id"),
  workspace: text({ enum: WORKSPACE_MODES }).notNull().default("worktree"),
  /** Null means use the project default, then the global default. */
  model: text({ mode: "json" }).$type<ModelSelection | null>(),
  prompt: text().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

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
  /** Messages the MCP review tools post; see REVIEW_MESSAGE_VARS. */
  reviewRequestMessage: text("review_request_message").notNull().default(DEFAULT_REVIEW_REQUEST_MESSAGE),
  secondPassMessage: text("second_pass_message").notNull().default(DEFAULT_SECOND_PASS_MESSAGE),
});

/**
 * One webhook delivery matched against one rule. `started` means the thread
 * is running; `done`/`failed` are set once its first turn settles.
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
    status: text({ enum: ["started", "done", "skipped", "failed"] }).notNull(),
    detail: text().notNull().default(""),
    threadId: text("thread_id"),
    threadUrl: text("thread_url"),
    /** Template variables extracted from the delivery, used to preview prompts in the UI. */
    context: text({ mode: "json" }).$type<Record<string, string>>(),
    /** Final assistant message of the thread's first turn, once it settles. */
    result: text(),
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
