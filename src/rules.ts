import { z } from "zod";
import type { prompts, reviewRequests, rules, runs, settings } from "./db/schema.ts";
import {
  DEFAULT_HANDOFF_PROMPT,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_POLLING,
  DEFAULT_REVIEW_REQUEST_MESSAGE,
  DEFAULT_SECOND_PASS_MESSAGE,
  EMPTY_FILTERS,
  INBOX_REASONS,
  RUNTIME_MODES,
  WORKSPACE_MODES,
  type PollingSettings,
  type RuleFilters,
} from "./shared.ts";

export type Rule = typeof rules.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Settings = Omit<typeof settings.$inferSelect, "id">;
export type ReviewRequest = typeof reviewRequests.$inferSelect;
export type Prompt = typeof prompts.$inferSelect;
export type { ModelSelection, RunAction } from "./db/schema.ts";

const ModelSelectionSchema = z.object({
  instanceId: z.string().trim().min(1),
  model: z.string().trim().min(1),
});

const names = z.array(z.string().trim().min(1)).default([]);

const RuleFiltersSchema = z.object({
  reasons: z.array(z.enum(INBOX_REASONS)).default([]),
  labels: names,
  allLabels: z.boolean().default(false),
  states: names,
  teams: names,
  rerunOnPush: z.boolean().default(true),
}) satisfies z.ZodType<RuleFilters, unknown>;

/** Payload accepted from the UI when creating or updating a rule. */
export const RuleInput = z.object({
  name: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  events: z.array(z.string().trim().min(1)).min(1),
  repos: z.array(z.string().trim().min(1)).default([]),
  reviewer: z.string().trim().min(1).nullable().default(null),
  channel: z.string().trim().min(1).nullable().default(null),
  allowBots: z.boolean().default(true),
  skipSelfReview: z.boolean().default(true),
  filters: RuleFiltersSchema.default(EMPTY_FILTERS),
  maxConcurrent: z.number().int().min(0).default(DEFAULT_MAX_CONCURRENT),
  projectId: z.string().trim().min(1).nullable().default(null),
  workspace: z.enum(WORKSPACE_MODES).default("worktree"),
  model: ModelSelectionSchema.nullable().default(null),
  prompt: z.string().min(1),
}) satisfies z.ZodType<Omit<Rule, "id" | "createdAt" | "updatedAt">, unknown>;
export type RuleInput = z.infer<typeof RuleInput>;

const PollSourceSchema = z.object({
  enabled: z.boolean(),
  minutes: z.number().int().min(1).max(24 * 60),
});

export const SettingsInput = z.object({
  model: ModelSelectionSchema,
  runtimeMode: z.enum(RUNTIME_MODES),
  githubLogin: z
    .string()
    .trim()
    .transform((login) => login.replace(/^@/, "") || null)
    .nullable()
    .default(null),
  maxChangesRequestedRounds: z.number().int().min(0).default(3),
  handoffPrompt: z.string().min(1).default(DEFAULT_HANDOFF_PROMPT),
  reviewChannel: z
    .string()
    .trim()
    .transform((channel) => channel || null)
    .nullable()
    .default(null),
  reviewRequestMessage: z.string().min(1).default(DEFAULT_REVIEW_REQUEST_MESSAGE),
  secondPassMessage: z.string().min(1).default(DEFAULT_SECOND_PASS_MESSAGE),
  polling: z
    .object({
      github: PollSourceSchema,
      linear: PollSourceSchema,
    })
    .default(DEFAULT_POLLING) satisfies z.ZodType<PollingSettings, unknown>,
}) satisfies z.ZodType<Settings, unknown>;

export const TestThreadInput = z.object({ projectId: z.string().trim().min(1) });

export const PromptInput = z.object({
  name: z.string().trim().min(1),
  body: z.string().min(1),
}) satisfies z.ZodType<Omit<Prompt, "id" | "createdAt" | "updatedAt">, unknown>;
export type PromptInput = z.infer<typeof PromptInput>;

/** A dispatch from the inbox view: one thread per item key, all with the same composed prompt. */
export const DispatchInput = z.object({
  keys: z.array(z.string().min(1)).min(1),
  /** Shown as the rule name in the run log, e.g. the preset names used. */
  name: z.string().trim().min(1).default("dispatch"),
  prompt: z.string().min(1),
  projectId: z.string().trim().min(1).nullable().default(null),
  workspace: z.enum(WORKSPACE_MODES).default("worktree"),
  model: ModelSelectionSchema.nullable().default(null),
  /** Threads started at once across dispatches from the inbox; the rest queue. 0 means all at once. */
  maxConcurrent: z.number().int().min(0).default(DEFAULT_MAX_CONCURRENT),
});
export type DispatchInput = z.infer<typeof DispatchInput>;

export const DEFAULT_SETTINGS: Settings = {
  model: { instanceId: "claudeAgent", model: "claude-fable-5-1" },
  runtimeMode: "full-access",
  githubLogin: null,
  maxChangesRequestedRounds: 3,
  handoffPrompt: DEFAULT_HANDOFF_PROMPT,
  reviewChannel: null,
  reviewRequestMessage: DEFAULT_REVIEW_REQUEST_MESSAGE,
  secondPassMessage: DEFAULT_SECOND_PASS_MESSAGE,
  polling: DEFAULT_POLLING,
};
