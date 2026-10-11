import { Effect, Schema, SchemaGetter } from "effect";
import type { promptVersions, prompts, reviewRequests, rules, runPullRequests, runUsage, runs, settings } from "./db/schema.ts";
import { parseLabels } from "./labelQuery.ts";
import {
  DEFAULT_HANDOFF_PROMPT,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_POLLING,
  DEFAULT_REVIEW_REQUEST_MESSAGE,
  DEFAULT_SECOND_PASS_MESSAGE,
  EMPTY_FILTERS,
  EMPTY_SENTRY_FILTERS,
  INBOX_REASONS,
  PROMPT_VERSION_OWNERS,
  RUN_SOURCES,
  RUNTIME_MODES,
  WORKSPACE_MODES,
  inboxSource,
  type PollingSettings,
  type RuleFilters,
  type SentryFilters,
} from "./shared.ts";

export type Rule = typeof rules.$inferSelect;
export type Run = typeof runs.$inferSelect;
/** Tokens and estimated cost of a run's thread, without the run id. */
export type RunUsage = Omit<typeof runUsage.$inferSelect, "runId">;
/** A PR linked to a run's thread in T3, without the run id. */
export type RunPullRequest = Omit<typeof runPullRequests.$inferSelect, "runId">;
export type Settings = Omit<typeof settings.$inferSelect, "id">;
export type ReviewRequest = typeof reviewRequests.$inferSelect;
export type Prompt = typeof prompts.$inferSelect;
export type PromptVersion = typeof promptVersions.$inferSelect;
export type { ModelSelection, PromptRef, RunAction } from "./db/schema.ts";

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
  labels: Schema.Trim.check(Schema.makeFilter((text: string) => {
    const parsed = parseLabels(text);
    return parsed.ok ? undefined : parsed.error;
  })).pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  states: names,
  teams: names,
  rerunOnPush: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});

const ruleFields = {
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
  presetId: optionalName,
};

/** One inbox source per rule keeps its filters and label suggestions to one provider. */
const oneInboxSource = Schema.makeFilter((rule: { readonly events: readonly string[] }) =>
  new Set(rule.events.map(inboxSource).filter(Boolean)).size <= 1
    ? undefined
    : { path: ["events"], issue: "An inbox rule polls one source: pick inbox events of GitHub, Linear or Sentry, not several." },
);

const promptBody = Schema.String.check(Schema.isMinLength(1));

/** Payload accepted from the UI when creating a rule; `prompt` becomes version 1, live. */
export const RuleInput = Schema.Struct({ ...ruleFields, prompt: promptBody }).check(oneInboxSource);
export type RuleInput = typeof RuleInput.Type;

/** Payload for updating a rule: everything but its prompt, which changes through versions (PromptVersionInput). */
export const RuleUpdate = Schema.Struct(ruleFields).check(oneInboxSource);
export type RuleUpdate = typeof RuleUpdate.Type;

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
  slackUserId: cleanedOrNull((user) => user.replace(/^<?@?([^>|]+).*$/, "$1")),
  skipReaction: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  usageIncludesDelegatedTasks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  reviewRequestMessage: Schema.String.check(Schema.isMinLength(1)).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_REVIEW_REQUEST_MESSAGE))),
  secondPassMessage: Schema.String.check(Schema.isMinLength(1)).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_SECOND_PASS_MESSAGE))),
  polling: Schema.Struct({
    github: PollSourceSchema,
    linear: PollSourceSchema,
    sentry: PollSourceSchema.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_POLLING.sentry))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_POLLING))),
  sentryFilters: Schema.Struct({ projects: names, environments: names, tags: names }).pipe(Schema.withDecodingDefault(Effect.succeed(EMPTY_SENTRY_FILTERS))),
});
export type SettingsInput = typeof SettingsInput.Type;

export const TestThreadInput = Schema.Struct({ projectId: nonEmpty });

/** A new preset; `body` becomes version 1, live. */
export const PromptInput = Schema.Struct({ name: nonEmpty, body: promptBody });
export type PromptInput = typeof PromptInput.Type;

/** Renaming a preset; its body changes through versions. */
export const PromptRename = Schema.Struct({ name: nonEmpty });

/** A new version of a preset or rule prompt. Unpromoted versions are drafts: runs keep using the live one. */
export const PromptVersionInput = Schema.Struct({
  body: promptBody,
  note: optionalName,
  promote: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type PromptVersionInput = typeof PromptVersionInput.Type;

/** A dispatch from the inbox view: one thread per item key, all with the same composed prompt. */
export const DispatchInput = Schema.Struct({
  keys: Schema.Array(Schema.String.check(Schema.isMinLength(1))).pipe(Schema.mutable).check(Schema.isMinLength(1)),
  /** Shown as the rule name in the run log, e.g. the preset names used. */
  name: nonEmpty.pipe(Schema.withDecodingDefault(Effect.succeed("dispatch"))),
  prompt: Schema.String.check(Schema.isMinLength(1)),
  /** Preset versions `prompt` was stacked from. Recorded on the runs while `prompt` is their bodies unedited; otherwise `prompt` is saved as its own version. */
  presets: Schema.Array(Schema.Struct({ id: nonEmpty, version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }))
    .pipe(Schema.mutable, Schema.withDecodingDefault(Effect.succeed([]))),
  projectId: optionalName,
  workspace: Schema.Literals(WORKSPACE_MODES).pipe(Schema.withDecodingDefault(Effect.succeed("worktree"))),
  model: Schema.NullOr(ModelSelectionSchema).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Threads started at once across dispatches from the inbox; the rest queue. 0 means all at once. */
  maxConcurrent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_MAX_CONCURRENT))),
});
export type DispatchInput = typeof DispatchInput.Type;

const intFromString = Schema.FiniteFromString.check(Schema.isInt());

/**
 * Search params of the runs page's list (`GET /api/runs/history`): the
 * RunFilter fields, with the prompt split into owner, id and optional version.
 */
export const RunQuery = Schema.Struct({
  ruleId: Schema.optional(nonEmpty),
  source: Schema.optional(Schema.Literals(RUN_SOURCES)),
  model: Schema.optional(nonEmpty),
  promptOwner: Schema.optional(Schema.Literals(PROMPT_VERSION_OWNERS)),
  promptId: Schema.optional(nonEmpty),
  promptVersion: Schema.optional(intFromString.check(Schema.isGreaterThanOrEqualTo(1))),
  since: Schema.optional(nonEmpty),
  limit: Schema.optional(intFromString.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});

/** A rating from the runs page: a 0 to 10 score, written feedback, or both, and the earlier run this one follows up. Rating again replaces it. */
export const RunRatingInput = Schema.Struct({
  rating: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  feedback: cleanedOrNull((text) => text),
  followUpOf: optionalName,
}).check(Schema.makeFilter((input) => (input.rating !== null || input.feedback !== null ? undefined : "Give a score, feedback or both.")));
export type RunRatingInput = typeof RunRatingInput.Type;

export const DEFAULT_SETTINGS: Settings = {
  model: { instanceId: "claudeAgent", model: "claude-fable-5-1" },
  runtimeMode: "full-access",
  githubLogin: null,
  maxChangesRequestedRounds: 3,
  handoffPrompt: DEFAULT_HANDOFF_PROMPT,
  reviewChannel: null,
  slackUserId: null,
  skipReaction: false,
  usageIncludesDelegatedTasks: true,
  reviewRequestMessage: DEFAULT_REVIEW_REQUEST_MESSAGE,
  secondPassMessage: DEFAULT_SECOND_PASS_MESSAGE,
  polling: DEFAULT_POLLING,
  sentryFilters: EMPTY_SENTRY_FILTERS,
};

// The decoded payloads must be storable as rows: a schema that drifts from its table fails to compile here.
type Extends<T extends U, U> = T;
export type RowChecks = [
  Extends<RuleInput, Omit<Rule, "id" | "livePromptVersion" | "createdAt" | "updatedAt">>,
  Extends<SettingsInput, Settings>,
  Extends<PromptInput, Omit<Prompt, "id" | "liveVersion" | "createdAt" | "updatedAt">>,
  Extends<Omit<PromptVersionInput, "promote">, Pick<PromptVersion, "body" | "note">>,
  Extends<SettingsInput["polling"], PollingSettings>,
  Extends<RuleInput["filters"], RuleFilters>,
  Extends<SettingsInput["sentryFilters"], SentryFilters>,
  Extends<RunRatingInput, Pick<Run, "rating" | "feedback" | "followUpOf">>,
];
