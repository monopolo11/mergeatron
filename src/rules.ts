import { Effect, Schema, SchemaGetter } from "effect";
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
  inboxSource,
  type PollingSettings,
  type RuleFilters,
} from "./shared.ts";

export type Rule = typeof rules.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Settings = Omit<typeof settings.$inferSelect, "id">;
export type ReviewRequest = typeof reviewRequests.$inferSelect;
export type Prompt = typeof prompts.$inferSelect;
export type { ModelSelection, RunAction } from "./db/schema.ts";

/**
 * Payloads accepted from the UI, as Effect schemas. Decoding trims names,
 * fills defaults for omitted fields and reports every problem with its path;
 * the decoded types line up with the database rows (checked below).
 */

/** A trimmed, non-empty string. */
const nonEmpty = Schema.Trim.check(Schema.isNonEmpty());
const names = Schema.Array(nonEmpty).pipe(Schema.mutable, Schema.withDecodingDefault(Effect.succeed([])));
/** Optional name: null, or a trimmed non-empty string. */
const optionalName = Schema.NullOr(nonEmpty).pipe(Schema.withDecodingDefault(Effect.succeed(null)));

/** Trimmed and cleaned by `clean`; an empty result (a cleared field in the UI) becomes null. */
const cleanedOrNull = (clean: (value: string) => string) =>
  Schema.NullOr(Schema.String).pipe(
    Schema.decodeTo(Schema.NullOr(Schema.String), {
      decode: SchemaGetter.transform((value) => (value === null ? null : clean(value.trim()) || null)),
      encode: SchemaGetter.passthrough(),
    }),
    Schema.withDecodingDefault(Effect.succeed(null)),
  );

const ModelSelectionSchema = Schema.Struct({ instanceId: nonEmpty, model: nonEmpty });

const RuleFiltersSchema = Schema.Struct({
  reasons: Schema.Array(Schema.Literals(INBOX_REASONS)).pipe(Schema.mutable, Schema.withDecodingDefault(Effect.succeed([]))),
  labels: names,
  allLabels: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  states: names,
  teams: names,
  rerunOnPush: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});

/** Payload accepted from the UI when creating or updating a rule. */
export const RuleInput = Schema.Struct({
  name: nonEmpty,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  events: Schema.Array(nonEmpty).pipe(Schema.mutable).check(Schema.isMinLength(1)),
  repos: names,
  reviewer: optionalName,
  channel: optionalName,
  allowBots: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  skipSelfReview: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  filters: RuleFiltersSchema.pipe(Schema.withDecodingDefault(Effect.succeed(EMPTY_FILTERS))),
  maxConcurrent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_MAX_CONCURRENT))),
  projectId: optionalName,
  workspace: Schema.Literals(WORKSPACE_MODES).pipe(Schema.withDecodingDefault(Effect.succeed("worktree"))),
  model: Schema.NullOr(ModelSelectionSchema).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  prompt: Schema.String.check(Schema.isMinLength(1)),
}).check(
  // One inbox source per rule keeps its filters and label suggestions to one provider.
  Schema.makeFilter((rule) =>
    new Set(rule.events.map(inboxSource).filter(Boolean)).size <= 1
      ? undefined
      : { path: ["events"], issue: "An inbox rule polls one source: pick GitHub or Linear inbox events, not both." },
  ),
);
export type RuleInput = typeof RuleInput.Type;

const PollSourceSchema = Schema.Struct({
  enabled: Schema.Boolean,
  minutes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(24 * 60)),
});

export const SettingsInput = Schema.Struct({
  model: ModelSelectionSchema,
  runtimeMode: Schema.Literals(RUNTIME_MODES),
  githubLogin: cleanedOrNull((login) => login.replace(/^@/, "")),
  maxChangesRequestedRounds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.withDecodingDefault(Effect.succeed(3))),
  handoffPrompt: Schema.String.check(Schema.isMinLength(1)).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_HANDOFF_PROMPT))),
  reviewChannel: cleanedOrNull((channel) => channel),
  reviewRequestMessage: Schema.String.check(Schema.isMinLength(1)).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_REVIEW_REQUEST_MESSAGE))),
  secondPassMessage: Schema.String.check(Schema.isMinLength(1)).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_SECOND_PASS_MESSAGE))),
  polling: Schema.Struct({ github: PollSourceSchema, linear: PollSourceSchema }).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_POLLING))),
});
export type SettingsInput = typeof SettingsInput.Type;

export const TestThreadInput = Schema.Struct({ projectId: nonEmpty });

export const PromptInput = Schema.Struct({
  name: nonEmpty,
  body: Schema.String.check(Schema.isMinLength(1)),
});
export type PromptInput = typeof PromptInput.Type;

/** A dispatch from the inbox view: one thread per item key, all with the same composed prompt. */
export const DispatchInput = Schema.Struct({
  keys: Schema.Array(Schema.String.check(Schema.isMinLength(1))).pipe(Schema.mutable).check(Schema.isMinLength(1)),
  /** Shown as the rule name in the run log, e.g. the preset names used. */
  name: nonEmpty.pipe(Schema.withDecodingDefault(Effect.succeed("dispatch"))),
  prompt: Schema.String.check(Schema.isMinLength(1)),
  projectId: optionalName,
  workspace: Schema.Literals(WORKSPACE_MODES).pipe(Schema.withDecodingDefault(Effect.succeed("worktree"))),
  model: Schema.NullOr(ModelSelectionSchema).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Threads started at once across dispatches from the inbox; the rest queue. 0 means all at once. */
  maxConcurrent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_MAX_CONCURRENT))),
});
export type DispatchInput = typeof DispatchInput.Type;

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

// The decoded payloads must be storable as rows: a schema that drifts from its table fails to compile here.
type Extends<T extends U, U> = T;
export type RowChecks = [
  Extends<RuleInput, Omit<Rule, "id" | "createdAt" | "updatedAt">>,
  Extends<SettingsInput, Settings>,
  Extends<PromptInput, Omit<Prompt, "id" | "createdAt" | "updatedAt">>,
  Extends<SettingsInput["polling"], PollingSettings>,
  Extends<RuleInput["filters"], RuleFilters>,
];
