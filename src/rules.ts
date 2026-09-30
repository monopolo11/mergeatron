import { z } from "zod";
import type { reviewRequests, rules, runs, settings } from "./db/schema.ts";
import {
  DEFAULT_HANDOFF_PROMPT,
  DEFAULT_REVIEW_REQUEST_MESSAGE,
  DEFAULT_SECOND_PASS_MESSAGE,
  RUNTIME_MODES,
  WORKSPACE_MODES,
} from "./shared.ts";

export type Rule = typeof rules.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Settings = Omit<typeof settings.$inferSelect, "id">;
export type ReviewRequest = typeof reviewRequests.$inferSelect;
export type { ModelSelection } from "./db/schema.ts";

const ModelSelectionSchema = z.object({
  instanceId: z.string().trim().min(1),
  model: z.string().trim().min(1),
});

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
  projectId: z.string().trim().min(1).nullable().default(null),
  workspace: z.enum(WORKSPACE_MODES).default("worktree"),
  model: ModelSelectionSchema.nullable().default(null),
  prompt: z.string().min(1),
}) satisfies z.ZodType<Omit<Rule, "id" | "createdAt" | "updatedAt">, unknown>;
export type RuleInput = z.infer<typeof RuleInput>;

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
}) satisfies z.ZodType<Settings, unknown>;

export const TestThreadInput = z.object({ projectId: z.string().trim().min(1) });

export const DEFAULT_SETTINGS: Settings = {
  model: { instanceId: "claudeAgent", model: "claude-fable-5-1" },
  runtimeMode: "full-access",
  githubLogin: null,
  maxChangesRequestedRounds: 3,
  handoffPrompt: DEFAULT_HANDOFF_PROMPT,
  reviewChannel: null,
  reviewRequestMessage: DEFAULT_REVIEW_REQUEST_MESSAGE,
  secondPassMessage: DEFAULT_SECOND_PASS_MESSAGE,
};
