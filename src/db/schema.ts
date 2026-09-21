import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { RUNTIME_MODES, WORKSPACE_MODES } from "../shared.ts";

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
