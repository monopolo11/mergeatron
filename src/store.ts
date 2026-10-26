import { and, count, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { SelectedFields, SQLiteColumn } from "drizzle-orm/sqlite-core";
import { Context, Effect, Layer } from "effect";
import { changesRequestedStreak, reviewVerdict } from "./verdict.ts";
import { Database, type AppDatabase } from "./db/index.ts";
import { inboxItems, promptVersions, prompts, queuePauses, reviewRequests, ruleGenerations, rules, runActions, runPrompts, runPullRequests, runUsage, runs, settings, webhooks } from "./db/schema.ts";
import type { InboxItem, PolledItem } from "./inbox.ts";
import {
  DEFAULT_SETTINGS,
  type Prompt,
  type PromptRef,
  type PromptInput,
  type PromptVersion,
  type QueuePause,
  type ReviewRequest,
  type Rule,
  type RuleInput,
  type RuleUpdate,
  type Run,
  type RunAction,
  type RunPullRequest,
  type RunUsage,
  type Settings,
  type Webhook,
  type WebhookInput,
  type WebhookUpdate,
} from "./rules.ts";
import { DEFAULT_POLLING, DEFAULT_PROMPTS, HANDOFF_EVENT, type InboxSource, type PromptOwner, type PromptVersionOwner, type PromptVersionSource, type RunSource } from "./shared.ts";

/** How long items that left the inbox are kept, so a reopened PR or a closed issue still has its history. */
const INBOX_RETENTION_DAYS = 30;

/** URLs of every PR and issue a run was for, from any trigger: a dispatch, a rule, a webhook or Slack. */
const RUN_URLS = sql`(select json_extract(${runs.context}, '$.pr_url') from ${runs} union select json_extract(${runs.context}, '$.issue_url') from ${runs})`;
/**
 * Departed items the inbox lists under "left": those something ran on. The
 * others stay stored until retention ends, so one that comes back still starts
 * a new stay, but a source that churns (Sentry) does not flood the list.
 */
const LEFT = and(isNotNull(inboxItems.goneAt), inArray(inboxItems.url, RUN_URLS));

/** Run counts split by status, for one grouping key. */
export type RunCounts = { total: number; queued: number; started: number; done: number; skipped: number; failed: number };

/**
 * Run counts plus how many were rated, their mean rating (0 to 10) and the
 * mean time threads worked; then how many had their usage measured (see
 * `runUsage`), their summed and mean estimated cost in USD and mean tokens
 * by kind. Sums and means are null when no run had one.
 */
export type RunStats = RunCounts & {
  rated: number;
  avgRating: number | null;
  avgElapsedMs: number | null;
  measured: number;
  totalCostUsd: number | null;
  avgCostUsd: number | null;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  avgCacheCreationTokens: number | null;
  avgCacheReadTokens: number | null;
};

export type Analytics = {
  all: RunStats;
  /** Per local calendar day a run was created on (`YYYY-MM-DD`), oldest first; days without runs are left out. */
  byDay: (RunCounts & { day: string; totalCostUsd: number | null; avgRating: number | null })[];
  /** Connection tests carry no author and are left out of this list. Cost is summed over the runs with usage measured, null when none. */
  byAuthor: (RunCounts & { author: string; totalCostUsd: number | null })[];
  bySource: (RunCounts & { source: RunSource })[];
  /**
   * Per prompt version, to compare versions. A dispatch of stacked presets
   * counts under each. `name` is the preset's or rule's, null once deleted.
   */
  byPrompt: (RunStats & PromptRef & { name: string | null; live: boolean })[];
  /** Per model and reasoning level a thread started with (null: the model's default); runs that never started one have none. */
  byModel: (RunStats & { modelInstanceId: string; modelId: string; reasoning: string | null })[];
  /** Settled runs that opened a thread, how many of them have usage measured, and what those cost in all. */
  usage: { runs: number; measured: number; totalCostUsd: number | null };
};

/** A prompt, or one version of it, as a filter. */
export type PromptKey = { owner: PromptVersionOwner; id: string; version?: number };

/**
 * The runs a page looks at: created in `[from, to)` and, per facet, matching
 * any of the listed values. A missing or empty field does not narrow.
 * `livePrompts` adds every preset's and rule's live version to `prompts`;
 * `notStatuses` turns `statuses` into the ones to leave out.
 */
export type RunScope = {
  /** ISO timestamps. */
  from?: string;
  to?: string;
  ruleIds?: readonly string[];
  sources?: readonly RunSource[];
  /** Model ids, e.g. `claude-opus-5-5`, whatever the provider instance. */
  models?: readonly string[];
  /** Runs whose first message came from one of these prompts or prompt versions. */
  prompts?: readonly PromptKey[];
  livePrompts?: boolean;
  authors?: readonly string[];
  repos?: readonly string[];
  statuses?: readonly Run["status"][];
  notStatuses?: boolean;
};

/** Which runs `listRuns` returns, newest first. Every field narrows; none means the latest 100. */
export type RunFilter = RunScope & {
  status?: Run["status"];
  /** True for rated runs only, false for unrated ones. */
  rated?: boolean;
  /** `recent` (default): newest first. `cost`: measured runs only, most expensive first. */
  sort?: "recent" | "cost";
  limit?: number;
};

/** One value of a run facet and how many runs in scope have it; `label` names a rule. */
export type FacetValue<T extends string = string> = { value: T; count: number; label?: string };

/** The values each run facet takes within a time window, most common first: what the filter menus offer. */
export type RunFacets = {
  rules: FacetValue[];
  sources: FacetValue<RunSource>[];
  models: FacetValue[];
  authors: FacetValue[];
  repos: FacetValue[];
  statuses: FacetValue<Run["status"]>[];
  prompts: (PromptRef & { name: string | null; live: boolean; count: number })[];
  /** Runs whose message used a live prompt version. */
  liveRuns: number;
};

/**
 * Where a PR stands, in priority order: a review is running, reviews are
 * paused (see `pausedReview`), else the verdict of the latest review. PRs with
 * no finished review take the status of their latest run.
 */
export type PullRequestStatus = "reviewing" | "queued" | "paused" | "approved" | "changes_requested" | "commented" | "skipped" | "failed";

/** One PR the orchestrator has run on. Counts leave out handoffs. */
export type PullRequestSummary = {
  repo: string;
  number: string;
  title: string | null;
  url: string | null;
  author: string | null;
  status: PullRequestStatus;
  reviews: number;
  approved: number;
  changesRequested: number;
  skipped: number;
  failed: number;
  lastAt: string;
  /** Thread of the latest run that opened one: the running review, the handoff, or the last review. */
  threadUrl: string | null;
};

/** A version to append: its body, why, and where it was saved from. */
export type NewPromptVersion = Pick<PromptVersion, "body" | "note" | "source">;

type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

/** Filled in once a thread starts (see StartResult in handler.ts), when the run settles, when it is rated, or when its PRs are read. */
type RunOutcome = "modelInstanceId" | "modelId" | "reasoning" | "rating" | "feedback" | "followUpOf" | "ratedAt" | "startedAt" | "settledAt" | "elapsedMs" | "pullRequestsCheckedAt" | "usageUnmeasurableAt";

/** Statuses that end a run. */
export const SETTLED = new Set<Run["status"]>(["done", "skipped", "failed"]);

/** Timing for a run ending now; `elapsedMs` only when its thread opened. */
const settledTiming = (startedAt: string | null | undefined, now = new Date()): Pick<Run, "settledAt" | "elapsedMs"> => ({
  settledAt: now.toISOString(),
  elapsedMs: startedAt ? now.getTime() - Date.parse(startedAt) : null,
});

/**
 * What `recordRun` needs. `action` goes to `runActions` and its prompt
 * versions to `runPrompts`; `promptRefs` overrides them (handoffs, tests).
 */
export type RunInput = Omit<Run, "id" | "createdAt" | RunOutcome> &
  Partial<Pick<Run, Exclude<RunOutcome, "settledAt" | "elapsedMs">>> & { action?: RunAction | null; promptRefs?: PromptRef[] };

/** A change to a run. `settledAt` and `elapsedMs` are the store's to set; `promptRefs` replace the run's prompt versions. */
export type RunPatch = Partial<Omit<Run, "id" | "createdAt" | "settledAt" | "elapsedMs">> & { promptRefs?: PromptRef[] };

/** A rating: 0 to 10 or none, with the written review that goes with it and the earlier run this one follows up. */
export type RunRating = Pick<Run, "rating" | "feedback" | "followUpOf">;

/**
 * Typed access to rules, prompt presets and their versions, global settings,
 * the inbox and the run log. SQLite is synchronous, so every method is a small `Effect.sync`
 * over Drizzle; a failing statement is a defect, not an expected error.
 */
export function makeStore(db: AppDatabase) {
  const getSettings = (): Settings => {
    const row = db.select().from(settings).where(eq(settings.id, 1)).get();
    if (!row) return DEFAULT_SETTINGS;
    const { id, ...stored } = row;
    // A source added after the row was saved polls on its defaults.
    return { ...stored, polling: { ...DEFAULT_POLLING, ...stored.polling } };
  };
  /** The version of a preset or rule prompt runs use now; needs `prompts` and `rules` joined to `runPrompts` by owner. */
  const liveVersion = sql`coalesce(${prompts.liveVersion}, ${rules.livePromptVersion})`;
  /** Runs whose message used one of a set of prompt versions, as an id subquery. */
  const runsWithPrompt = (where: SQL | undefined) =>
    inArray(
      runs.id,
      db
        .select({ id: runPrompts.runId })
        .from(runPrompts)
        .leftJoin(prompts, and(eq(runPrompts.owner, "preset"), eq(prompts.id, runPrompts.ownerId)))
        .leftJoin(rules, and(eq(runPrompts.owner, "rule"), eq(rules.id, runPrompts.ownerId)))
        .where(where),
    );
  /** Over `runPrompts` with `prompts` and `rules` joined: any picked prompt or version, or any live version with `livePrompts`. Undefined when neither is set. */
  const promptCondition = ({ prompts: picked = [], livePrompts }: RunScope) =>
    picked.length === 0 && !livePrompts
      ? undefined
      : or(
          ...picked.map((prompt) =>
            and(eq(runPrompts.owner, prompt.owner), eq(runPrompts.ownerId, prompt.id), prompt.version === undefined ? undefined : eq(runPrompts.version, prompt.version)),
          ),
          livePrompts ? eq(runPrompts.version, liveVersion) : undefined,
        );
  const anyOf = <T extends string>(column: AnyColumn, values: readonly T[] | undefined) => (values?.length ? inArray(column, [...values]) : undefined);
  /** The SQL condition for a RunScope, over `runs`. */
  const scopeWhere = (scope: RunScope) => {
    const prompt = promptCondition(scope);
    return and(
      scope.from === undefined ? undefined : gte(runs.createdAt, scope.from),
      scope.to === undefined ? undefined : lt(runs.createdAt, scope.to),
      anyOf(runs.ruleId, scope.ruleIds),
      anyOf(runs.source, scope.sources),
      anyOf(runs.modelId, scope.models),
      anyOf(runs.author, scope.authors),
      anyOf(runs.repo, scope.repos),
      scope.statuses?.length ? (scope.notStatuses ? notInArray : inArray)(runs.status, [...scope.statuses]) : undefined,
      prompt && runsWithPrompt(prompt),
    );
  };
  /**
   * Prompt versions with runs matching `where`, joined to their names and
   * live flags so callers add the columns they need. A dispatch of stacked
   * presets counts under each.
   */
  const promptGroups = <Fields extends SelectedFields>(fields: Fields, where: SQL | undefined) => {
    // The preset's or rule's name, or a dispatch's (its version note); null once a preset or rule is deleted.
    const name = sql<string | null>`coalesce(${prompts.name}, ${rules.name}, case when ${runPrompts.owner} = 'dispatch' then ${promptVersions.note} end)`;
    // The version runs use now; a dispatch's single version is never live.
    const live = sql<boolean>`ifnull(${liveVersion} = ${runPrompts.version}, 0)`.mapWith(Boolean);
    return db
      .select({ owner: runPrompts.owner, id: runPrompts.ownerId, version: runPrompts.version, name, live, ...fields })
      .from(runPrompts)
      .innerJoin(runs, eq(runs.id, runPrompts.runId))
      .leftJoin(runUsage, eq(runUsage.runId, runs.id))
      .innerJoin(promptVersions, and(eq(promptVersions.owner, runPrompts.owner), eq(promptVersions.ownerId, runPrompts.ownerId), eq(promptVersions.version, runPrompts.version)))
      .leftJoin(prompts, and(eq(runPrompts.owner, "preset"), eq(prompts.id, runPrompts.ownerId)))
      .leftJoin(rules, and(eq(runPrompts.owner, "rule"), eq(rules.id, runPrompts.ownerId)))
      .where(where)
      .groupBy(runPrompts.owner, runPrompts.ownerId, runPrompts.version)
      .orderBy(runPrompts.owner, runPrompts.ownerId, desc(runPrompts.version));
  };
  const listPrompts = (): Prompt[] => db.select().from(prompts).orderBy(prompts.createdAt).all();
  const createPrompt = ({ body, ...input }: PromptInput, source: PromptVersionSource = "ui"): Prompt =>
    db.transaction((tx) => {
      const now = new Date().toISOString();
      const prompt = tx
        .insert(prompts)
        .values({ ...input, body, liveVersion: 1, id: crypto.randomUUID(), createdAt: now, updatedAt: now })
        .returning()
        .get();
      insertVersion(tx, "preset", prompt.id, 1, { body, note: null, source }, now);
      return prompt;
    });

  const ofOwner = (owner: PromptOwner, ownerId: string) => and(eq(promptVersions.owner, owner), eq(promptVersions.ownerId, ownerId));
  const insertVersion = (tx: Tx, owner: PromptOwner, ownerId: string, version: number, input: NewPromptVersion, now: string): PromptVersion =>
    tx.insert(promptVersions).values({ ...input, owner, ownerId, version, createdAt: now }).returning().get();
  const getVersion = (tx: Tx, owner: PromptOwner, ownerId: string, version: number): PromptVersion | null =>
    tx.select().from(promptVersions).where(and(ofOwner(owner, ownerId), eq(promptVersions.version, version))).get() ?? null;
  const latestVersion = (tx: Tx, owner: PromptOwner, ownerId: string): PromptVersion | null =>
    tx.select().from(promptVersions).where(ofOwner(owner, ownerId)).orderBy(desc(promptVersions.version)).get() ?? null;
  /** Copies a version's body onto its owner, the text runs use. False when the owner is gone. */
  const setLive = (tx: Tx, { owner, ownerId, version, body }: PromptVersion, now: string): boolean =>
    owner === "preset"
      ? tx.update(prompts).set({ body, liveVersion: version, updatedAt: now }).where(eq(prompts.id, ownerId)).returning({ id: prompts.id }).get() !== undefined
      : tx.update(rules).set({ prompt: body, livePromptVersion: version, updatedAt: now }).where(eq(rules.id, ownerId)).returning({ id: rules.id }).get() !== undefined;
  const ownerExists = (tx: Tx, owner: PromptOwner, ownerId: string): boolean =>
    owner === "preset"
      ? tx.select({ id: prompts.id }).from(prompts).where(eq(prompts.id, ownerId)).get() !== undefined
      : tx.select({ id: rules.id }).from(rules).where(eq(rules.id, ownerId)).get() !== undefined;

  /** Replaces a run's prompt versions, keeping their order. */
  const writeRunPrompts = (tx: Tx, runId: string, refs: PromptRef[]) => {
    tx.delete(runPrompts).where(eq(runPrompts.runId, runId)).run();
    if (refs.length === 0) return;
    tx.insert(runPrompts)
      .values(refs.map(({ owner, id, version }, position) => ({ runId, position, owner, ownerId: id, version })))
      .run();
  };

  return {
    listPrompts: () => Effect.sync(listPrompts),
    createPrompt: (input: PromptInput, source?: PromptVersionSource) => Effect.sync(() => createPrompt(input, source)),

    /** Renames a preset; its body changes through `createPromptVersion`. */
    renamePrompt: (id: string, name: string) =>
      Effect.sync(
        (): Prompt | null =>
          db
            .update(prompts)
            .set({ name, updatedAt: new Date().toISOString() })
            .where(eq(prompts.id, id))
            .returning()
            .get() ?? null,
      ),

    getPrompt: (id: string) => Effect.sync((): Prompt | null => db.select().from(prompts).where(eq(prompts.id, id)).get() ?? null),

    /**
     * Rules linked to the preset keep their own text and stop following it, as
     * do queued runs (the foreign key nulls their action's preset). Its
     * versions stay: runs reference them.
     */
    deletePrompt: (id: string) =>
      Effect.sync(() =>
        db.transaction((tx) => {
          tx.update(rules).set({ presetId: null }).where(eq(rules.presetId, id)).run();
          return tx.delete(prompts).where(eq(prompts.id, id)).returning().get() !== undefined;
        }),
      ),

    /** Every version of a preset or rule prompt, newest first. */
    listPromptVersions: (owner: PromptOwner, ownerId: string) =>
      Effect.sync((): PromptVersion[] => db.select().from(promptVersions).where(ofOwner(owner, ownerId)).orderBy(desc(promptVersions.version)).all()),

    /** Highest version number per owner, for listing prompts with how far their drafts run ahead. */
    latestPromptVersions: () =>
      Effect.sync(
        (): Map<string, number> =>
          new Map(
            db
              .select({ owner: promptVersions.owner, ownerId: promptVersions.ownerId, version: sql<number>`max(${promptVersions.version})` })
              .from(promptVersions)
              .groupBy(promptVersions.owner, promptVersions.ownerId)
              .all()
              .map((row) => [`${row.owner}:${row.ownerId}`, row.version]),
          ),
      ),

    /**
     * Appends the next version, promoting it when asked. A body equal to the
     * latest version's adds nothing and returns that version (promoted if
     * asked), so repeated saves do not pile up. Null when the owner is gone.
     */
    createPromptVersion: (owner: PromptOwner, ownerId: string, input: NewPromptVersion, promote = false) =>
      Effect.sync(() =>
        db.transaction((tx): PromptVersion | null => {
          if (!ownerExists(tx, owner, ownerId)) return null;
          const now = new Date().toISOString();
          const latest = latestVersion(tx, owner, ownerId);
          const version = latest?.body === input.body ? latest : insertVersion(tx, owner, ownerId, (latest?.version ?? 0) + 1, input, now);
          if (promote) setLive(tx, version, now);
          return version;
        }),
      ),

    /** Makes a version the live one. Null when the owner or the version is gone. */
    promotePromptVersion: (owner: PromptOwner, ownerId: string, version: number) =>
      Effect.sync(() =>
        db.transaction((tx): PromptVersion | null => {
          const found = getVersion(tx, owner, ownerId, version);
          return found && setLive(tx, found, new Date().toISOString()) ? found : null;
        }),
      ),

    /**
     * Replaces one source's inbox with a fresh poll: upserts every item seen,
     * keeping `firstSeenAt` across polls (an item that had gone and came back
     * starts a new stay), and marks the source's other active items gone.
     */
    syncInbox: (source: InboxSource, items: PolledItem[], now = new Date().toISOString()) =>
      Effect.sync(() =>
        db.transaction((tx) => {
          let appeared = 0;
          let returned = 0;
          for (const item of items) {
            const before = tx.select({ goneAt: inboxItems.goneAt }).from(inboxItems).where(eq(inboxItems.key, item.key)).get();
            if (!before) appeared += 1;
            else if (before.goneAt) returned += 1;
            tx.insert(inboxItems)
              .values({ ...item, firstSeenAt: now, lastSeenAt: now, goneAt: null })
              .onConflictDoUpdate({
                target: inboxItems.key,
                set: { ...item, lastSeenAt: now, goneAt: null, firstSeenAt: before?.goneAt ? now : undefined },
              })
              .run();
          }
          const stillHere = items.map((item) => item.key);
          const gone = tx
            .update(inboxItems)
            .set({ goneAt: now })
            .where(and(eq(inboxItems.source, source), isNull(inboxItems.goneAt), stillHere.length > 0 ? notInArray(inboxItems.key, stillHere) : undefined))
            .returning({ key: inboxItems.key })
            .all().length;
          return { appeared, returned, gone };
        }),
      ),

    /** Active items by latest activity; with `gone`, the departed ones something ran on follow (see LEFT), newest departure first. */
    listInbox: (options: { gone?: boolean } = {}) =>
      Effect.sync((): InboxItem[] => {
        const active = db.select().from(inboxItems).where(isNull(inboxItems.goneAt)).orderBy(desc(inboxItems.updatedAt)).all();
        if (!options.gone) return active;
        const gone = db.select().from(inboxItems).where(LEFT).orderBy(desc(inboxItems.goneAt)).all();
        return [...active, ...gone];
      }),

    getInboxItem: (key: string) => Effect.sync((): InboxItem | null => db.select().from(inboxItems).where(eq(inboxItems.key, key)).get() ?? null),

    countGoneInbox: () => Effect.sync(() => db.select({ n: count() }).from(inboxItems).where(LEFT).get()?.n ?? 0),

    /** Drops items gone for longer than the retention window. Returns how many. */
    pruneInbox: (now = Date.now()) =>
      Effect.sync(() => {
        const cutoff = new Date(now - INBOX_RETENTION_DAYS * 86_400_000).toISOString();
        return db.delete(inboxItems).where(lt(inboxItems.goneAt, cutoff)).returning({ key: inboxItems.key }).all().length;
      }),

    /** Seeds the preset library on first start so the composer has something to offer. */
    ensureDefaultPrompts: () =>
      Effect.sync(() => {
        if (listPrompts().length > 0) return;
        for (const prompt of DEFAULT_PROMPTS) createPrompt(prompt);
      }),

    listRules: () => Effect.sync((): Rule[] => db.select().from(rules).orderBy(rules.createdAt).all()),

    /** The prompt becomes version 1, live. */
    createRule: (input: RuleInput, source: PromptVersionSource = "ui") =>
      Effect.sync(() =>
        db.transaction((tx): Rule => {
          const now = new Date().toISOString();
          const rule = tx
            .insert(rules)
            .values({ ...input, livePromptVersion: 1, id: crypto.randomUUID(), createdAt: now, updatedAt: now })
            .returning()
            .get();
          insertVersion(tx, "rule", rule.id, 1, { body: input.prompt, note: null, source }, now);
          return rule;
        }),
      ),

    /** Everything but the prompt, which changes through `createPromptVersion`. */
    updateRule: (id: string, input: RuleUpdate) =>
      Effect.sync(
        (): Rule | null =>
          db
            .update(rules)
            .set({ ...input, updatedAt: new Date().toISOString() })
            .where(eq(rules.id, id))
            .returning()
            .get() ?? null,
      ),

    getRule: (id: string) => Effect.sync((): Rule | null => db.select().from(rules).where(eq(rules.id, id)).get() ?? null),

    /** Its prompt versions stay: runs reference them. */
    deleteRule: (id: string) => Effect.sync(() => db.delete(rules).where(eq(rules.id, id)).returning().get() !== undefined),

    listWebhooks: () => Effect.sync((): Webhook[] => db.select().from(webhooks).orderBy(webhooks.createdAt).all()),

    getWebhookBySlug: (slug: string) => Effect.sync((): Webhook | null => db.select().from(webhooks).where(eq(webhooks.slug, slug)).get() ?? null),

    /** Null when another webhook has the slug. */
    createWebhook: (input: WebhookInput & Pick<Webhook, "secret">) =>
      Effect.sync((): Webhook | null => {
        const now = new Date().toISOString();
        return (
          db
            .insert(webhooks)
            .values({ ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now })
            .onConflictDoNothing({ target: webhooks.slug })
            .returning()
            .get() ?? null
        );
      }),

    /** Name and schema, or a new secret: senders using the old one are rejected from then on. */
    updateWebhook: (id: string, input: WebhookUpdate | Pick<Webhook, "secret">) =>
      Effect.sync((): Webhook | null => db.update(webhooks).set({ ...input, updatedAt: new Date().toISOString() }).where(eq(webhooks.id, id)).returning().get() ?? null),

    /** Rules on its event stay, and fire again if a webhook with the same slug is created. */
    deleteWebhook: (id: string) => Effect.sync(() => db.delete(webhooks).where(eq(webhooks.id, id)).returning().get() !== undefined),

    /**
     * Saves hand-edited dispatch text as a one-off version (owner `dispatch`,
     * version 1), so the runs it starts reference their prompt like any other.
     */
    createDispatchPrompt: (body: string, note: string) =>
      Effect.sync((): PromptRef => {
        const id = crypto.randomUUID();
        db.insert(promptVersions).values({ owner: "dispatch", ownerId: id, version: 1, body, note, source: "ui", createdAt: new Date().toISOString() }).run();
        return { owner: "dispatch", id, version: 1 };
      }),

    /** Bodies of these versions, in order; null when one does not exist. */
    promptBodies: (refs: PromptRef[]) =>
      Effect.sync((): string[] | null => {
        const bodies: string[] = [];
        for (const ref of refs) {
          const row = db
            .select({ body: promptVersions.body })
            .from(promptVersions)
            .where(and(eq(promptVersions.owner, ref.owner), eq(promptVersions.ownerId, ref.id), eq(promptVersions.version, ref.version)))
            .get();
          if (!row) return null;
          bodies.push(row.body);
        }
        return bodies;
      }),

    getSettings: () => Effect.sync(getSettings),

    saveSettings: (next: Settings) =>
      Effect.sync(() => {
        db.insert(settings)
          .values({ id: 1, ...next })
          .onConflictDoUpdate({ target: settings.id, set: next })
          .run();
      }),

    /** Providers whose usage ran out, oldest pause first; empty while every provider runs. */
    listQueuePauses: () => Effect.sync((): QueuePause[] => db.select().from(queuePauses).orderBy(queuePauses.pausedAt).all()),

    getQueuePause: (instanceId: string) => Effect.sync((): QueuePause | null => db.select().from(queuePauses).where(eq(queuePauses.instanceId, instanceId)).get() ?? null),

    saveQueuePause: (pause: QueuePause) =>
      Effect.sync(() => {
        db.insert(queuePauses).values(pause).onConflictDoUpdate({ target: queuePauses.instanceId, set: pause }).run();
      }),

    clearQueuePause: (instanceId: string) =>
      Effect.sync(() => {
        db.delete(queuePauses).where(eq(queuePauses.instanceId, instanceId)).run();
      }),

    listRuns: ({ limit = 100, status, rated, sort, ...scope }: RunFilter = {}) =>
      Effect.sync((): Run[] => {
        const where = and(
          scopeWhere(scope),
          status === undefined ? undefined : eq(runs.status, status),
          rated === undefined ? undefined : rated ? isNotNull(runs.ratedAt) : isNull(runs.ratedAt),
        );
        if (sort === "cost")
          return db
            .select(getTableColumns(runs))
            .from(runs)
            .innerJoin(runUsage, eq(runUsage.runId, runs.id))
            .where(where)
            .orderBy(desc(runUsage.costUsd), desc(runs.createdAt))
            .limit(limit)
            .all();
        return db.select().from(runs).where(where).orderBy(desc(runs.createdAt), desc(sql`rowid`)).limit(limit).all();
      }),

    /** Rates a run, replacing an earlier rating. Null when there is no such run. */
    rateRun: (id: string, rating: RunRating) =>
      Effect.sync(
        (): Run | null =>
          db
            .update(runs)
            .set({ ...rating, ratedAt: new Date().toISOString() })
            .where(eq(runs.id, id))
            .returning()
            .get() ?? null,
      ),

    /** Deletes a run; its prompt versions, action and usage go with it (the foreign keys cascade). False when there is no such run. */
    deleteRun: (id: string) => Effect.sync(() => db.delete(runs).where(eq(runs.id, id)).returning({ id: runs.id }).get() !== undefined),

    /** True when this delivery was already handled for the rule (GitHub retries deliveries). */
    hasRun: (deliveryId: string, ruleId: string) =>
      Effect.sync(
        () =>
          db
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.deliveryId, deliveryId), eq(runs.ruleId, ruleId)))
            .get() !== undefined,
      ),

    /** An issue's generation per rule (see `itemDeliveryId`); rules it never re-entered are absent. */
    itemGenerations: (itemKey: string) =>
      Effect.sync(
        (): Map<string, number> =>
          new Map(
            db
              .select({ ruleId: ruleGenerations.ruleId, generation: ruleGenerations.generation })
              .from(ruleGenerations)
              .where(eq(ruleGenerations.itemKey, itemKey))
              .all()
              .map((row) => [row.ruleId, row.generation]),
          ),
      ),

    /** Starts an issue's next generation for a rule, so the rule fires again on its next match. Returns the new generation. */
    bumpGeneration: (ruleId: string, itemKey: string) =>
      Effect.sync(
        () =>
          db
            .insert(ruleGenerations)
            .values({ ruleId, itemKey, generation: 1 })
            .onConflictDoUpdate({ target: [ruleGenerations.ruleId, ruleGenerations.itemKey], set: { generation: sql`${ruleGenerations.generation} + 1` } })
            .returning({ generation: ruleGenerations.generation })
            .get().generation,
      ),

    recordRun: ({ action, promptRefs = action?.promptRefs ?? [], ...run }: RunInput) =>
      Effect.sync(
        (): Run =>
          db.transaction((tx) => {
            const row = tx
              .insert(runs)
              .values({
                ...run,
                ...(SETTLED.has(run.status) && settledTiming(run.startedAt)),
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
              })
              .returning()
              .get();
            writeRunPrompts(tx, row.id, promptRefs);
            if (action) {
              const { promptRefs: _, model, ...settings } = action;
              tx.insert(runActions)
                .values({
                  ...settings,
                  runId: row.id,
                  modelInstanceId: model?.instanceId ?? null,
                  modelId: model?.model ?? null,
                  modelOptions: model?.options ?? null,
                })
                .run();
            }
            return row;
          }),
      ),

    /** Updates a run; a status that ends it also stamps `settledAt` and `elapsedMs`. */
    updateRun: (id: string, { promptRefs, ...patch }: RunPatch) =>
      Effect.sync(() =>
        db.transaction((tx) => {
          const ends = patch.status !== undefined && SETTLED.has(patch.status);
          const startedAt = () => patch.startedAt ?? tx.select({ startedAt: runs.startedAt }).from(runs).where(eq(runs.id, id)).get()?.startedAt;
          tx.update(runs)
            .set(ends ? { ...patch, ...settledTiming(startedAt()) } : patch)
            .where(eq(runs.id, id))
            .run();
          if (promptRefs) writeRunPrompts(tx, id, promptRefs);
        }),
      ),

    /** Prompt versions of each run, in stack order; runs without any are left out. */
    runPromptRefs: (runIds: string[]) =>
      Effect.sync((): Map<string, PromptRef[]> => {
        const rows = runIds.length === 0 ? [] : db.select().from(runPrompts).where(inArray(runPrompts.runId, runIds)).orderBy(runPrompts.runId, runPrompts.position).all();
        const refs = Map.groupBy(rows, (row) => row.runId);
        return new Map([...refs].map(([runId, rows]) => [runId, rows.map(({ owner, ownerId, version }) => ({ owner, id: ownerId, version }))]));
      }),

    getRun: (id: string) => Effect.sync((): Run | null => db.select().from(runs).where(eq(runs.id, id)).get() ?? null),

    /** Stores what a run's thread spent (see usage.ts), replacing an earlier measurement. */
    saveRunUsage: (runId: string, usage: RunUsage) =>
      Effect.sync(() => {
        db.insert(runUsage).values({ runId, ...usage }).onConflictDoUpdate({ target: runUsage.runId, set: usage }).run();
      }),

    /** Usage of each run; runs not measured are left out. */
    runUsage: (runIds: string[]) =>
      Effect.sync((): Map<string, RunUsage> => {
        const rows = runIds.length === 0 ? [] : db.select().from(runUsage).where(inArray(runUsage.runId, runIds)).all();
        return new Map(rows.map(({ runId, ...usage }) => [runId, usage]));
      }),

    /** Stores the PRs linked to a run's thread (see runPullRequests.ts), replacing the earlier list, and when they were checked. */
    saveRunPullRequests: (runId: string, pulls: RunPullRequest[], checkedAt: string) =>
      Effect.sync(() =>
        db.transaction((tx) => {
          tx.delete(runPullRequests).where(eq(runPullRequests.runId, runId)).run();
          if (pulls.length > 0) tx.insert(runPullRequests).values(pulls.map((pull) => ({ runId, ...pull }))).run();
          tx.update(runs).set({ pullRequestsCheckedAt: checkedAt }).where(eq(runs.id, runId)).run();
        }),
      ),

    /** Runs that ended with a thread and whose PRs were never checked, oldest first: what `backfillPullRequests` reads. */
    runsWithUncheckedPullRequests: () =>
      Effect.sync(() =>
        db
          .select({ id: runs.id, threadId: runs.threadId })
          .from(runs)
          .where(and(isNotNull(runs.threadId), inArray(runs.status, ["done", "failed"]), isNull(runs.pullRequestsCheckedAt)))
          .orderBy(runs.createdAt)
          .all(),
      ),

    /** PRs linked to each run's thread, in the order they were linked; runs without any are left out. */
    runPullRequests: (runIds: string[]) =>
      Effect.sync((): Map<string, RunPullRequest[]> => {
        const rows = runIds.length === 0 ? [] : db.select().from(runPullRequests).where(inArray(runPullRequests.runId, runIds)).orderBy(runPullRequests.linkedAt).all();
        return new Map([...Map.groupBy(rows, (row) => row.runId)].map(([runId, rows]) => [runId, rows.map(({ runId: _, ...pull }) => pull)]));
      }),

    /** Runs that ended with a thread, at or after `since`, and have no usage yet and were not found unmeasurable, oldest first: what `backfillUsage` measures. */
    runsWithoutUsage: (since: string) =>
      Effect.sync(() =>
        db
          .select({ id: runs.id, threadId: runs.threadId })
          .from(runs)
          .leftJoin(runUsage, eq(runUsage.runId, runs.id))
          .where(and(isNotNull(runs.threadId), inArray(runs.status, ["done", "failed"]), gte(runs.settledAt, since), isNull(runUsage.runId), isNull(runs.usageUnmeasurableAt)))
          .orderBy(runs.settledAt)
          .all(),
      ),

    /** Stops `runsWithoutUsage` returning these runs: their thread has no session usage can be read from. */
    markUsageUnmeasurable: (runIds: string[]) =>
      Effect.sync(() => {
        if (runIds.length > 0) db.update(runs).set({ usageUnmeasurableAt: new Date().toISOString() }).where(inArray(runs.id, runIds)).run();
      }),

    /** What a rule-driven run was set to start with; null for handoffs and connection tests. */
    getRunAction: (runId: string) =>
      Effect.sync((): RunAction | null => {
        const row = db.select().from(runActions).where(eq(runActions.runId, runId)).get();
        if (!row) return null;
        const { runId: _, modelInstanceId, modelId, modelOptions, ...settings } = row;
        const promptRefs = db
          .select({ owner: runPrompts.owner, id: runPrompts.ownerId, version: runPrompts.version })
          .from(runPrompts)
          .where(eq(runPrompts.runId, runId))
          .orderBy(runPrompts.position)
          .all();
        const model = modelInstanceId && modelId ? { instanceId: modelInstanceId, model: modelId, ...(modelOptions && { options: modelOptions }) } : null;
        return { ...settings, model, promptRefs };
      }),

    /** Runs of a rule in one status; `started` against the rule's concurrency limit. */
    countRuns: (ruleId: string, status: Run["status"]) =>
      Effect.sync(() => db.select({ n: count() }).from(runs).where(and(eq(runs.ruleId, ruleId), eq(runs.status, status))).get()?.n ?? 0),

    /**
     * Next run of a rule waiting for capacity: queued the longest, skipping
     * runs held for a paused provider (`paused` instance ids). A run whose
     * provider is not known yet is not skipped.
     */
    oldestQueuedRun: (ruleId: string, paused: readonly string[] = []) =>
      Effect.sync(
        (): Run | null =>
          db
            .select()
            .from(runs)
            .where(
              and(
                eq(runs.ruleId, ruleId),
                eq(runs.status, "queued"),
                paused.length > 0 ? or(isNull(runs.modelInstanceId), notInArray(runs.modelInstanceId, [...paused])) : undefined,
              ),
            )
            .orderBy(runs.createdAt, sql`rowid`)
            .get() ?? null,
      ),

    /** Rules with queued runs, to resume after a restart. */
    queuedRuleIds: () =>
      Effect.sync(() => db.selectDistinct({ ruleId: runs.ruleId }).from(runs).where(eq(runs.status, "queued")).all().map((row) => row.ruleId)),

    /**
     * The run still reviewing (or waiting to review) this PR, if any. One review
     * per PR at a time, across all rules and triggers; a queued review counts, so
     * a PR does not pile up. Pass `["started"]` to see only running threads.
     */
    activeRunForPullRequest: (repo: string, prNumber: string, statuses: Run["status"][] = ["started", "queued"]) =>
      Effect.sync(
        (): Run | null =>
          db
            .select()
            .from(runs)
            .where(
              and(
                inArray(runs.status, statuses),
                sql`lower(${runs.repo}) = lower(${repo})`,
                sql`json_extract(${runs.context}, '$.pr_number') = ${prNumber}`,
              ),
            )
            .orderBy(desc(runs.createdAt))
            .get() ?? null,
      ),

    /** The run still working on (or queued for) this issue, from any source. One thread per issue at a time. */
    activeRunForIssue: (issueUrl: string, statuses: Run["status"][] = ["started", "queued"]) =>
      Effect.sync(
        (): Run | null =>
          db
            .select()
            .from(runs)
            .where(and(inArray(runs.status, statuses), sql`json_extract(${runs.context}, '$.issue_url') = ${issueUrl}`))
            .orderBy(desc(runs.createdAt))
            .get() ?? null,
      ),

    /**
     * Latest run per PR or issue URL, for the inbox: webhook, Slack and inbox
     * runs alike, so an item shows the review a webhook started too.
     */
    latestRunsByUrl: (urls: string[]) =>
      Effect.sync((): Map<string, Run> => {
        if (urls.length === 0) return new Map();
        const prUrl = sql<string>`json_extract(${runs.context}, '$.pr_url')`;
        const issueUrl = sql<string>`json_extract(${runs.context}, '$.issue_url')`;
        const rows = db
          .select()
          .from(runs)
          .where(or(inArray(prUrl, urls), inArray(issueUrl, urls)))
          .orderBy(desc(runs.createdAt), desc(sql`rowid`))
          .all();
        const latest = new Map<string, Run>();
        for (const run of rows) {
          for (const url of [run.context?.pr_url, run.context?.issue_url]) {
            if (url && !latest.has(url)) latest.set(url, run);
          }
        }
        return latest;
      }),

    /** Finished runs of this PR that have a reply (reviews and handoffs alike), newest first (rowid breaks same-millisecond ties). */
    finishedRunsForPullRequest: (repo: string, prNumber: string) =>
      Effect.sync((): Run[] =>
        db
          .select()
          .from(runs)
          .where(
            and(
              eq(runs.status, "done"),
              sql`${runs.result} is not null`,
              sql`lower(${runs.repo}) = lower(${repo})`,
              sql`json_extract(${runs.context}, '$.pr_number') = ${prNumber}`,
            ),
          )
          .orderBy(desc(runs.createdAt), desc(sql`rowid`))
          .all(),
      ),

    /** The run started by this Slack message (the review a thread hangs under), for "second pass" mentions in that thread. */
    runForSlackMessage: (channel: string, ts: string) =>
      Effect.sync(
        (): Run | null =>
          db
            .select()
            .from(runs)
            .where(
              and(
                sql`json_extract(${runs.context}, '$.slack_channel') = ${channel}`,
                sql`json_extract(${runs.context}, '$.slack_ts') = ${ts}`,
                sql`json_extract(${runs.context}, '$.pr_url') is not null`,
              ),
            )
            .orderBy(desc(runs.createdAt))
            .get() ?? null,
      ),

    /** The Slack thread an agent opened for this PR through the MCP tools, if any. */
    getReviewRequest: (repo: string, prNumber: string) =>
      Effect.sync(
        (): ReviewRequest | null =>
          db
            .select()
            .from(reviewRequests)
            .where(and(eq(reviewRequests.repo, repo.toLowerCase()), eq(reviewRequests.prNumber, prNumber)))
            .get() ?? null,
      ),

    createReviewRequest: (input: Omit<ReviewRequest, "id" | "round" | "createdAt" | "updatedAt">) =>
      Effect.sync((): ReviewRequest => {
        const now = new Date().toISOString();
        return db
          .insert(reviewRequests)
          .values({ ...input, repo: input.repo.toLowerCase(), id: crypto.randomUUID(), round: 1, createdAt: now, updatedAt: now })
          .returning()
          .get();
      }),

    /** Starts the next review round, tagging `mentions`, and returns the updated request. */
    nextReviewRound: (id: string, mentions: string) =>
      Effect.sync(
        (): ReviewRequest =>
          db
            .update(reviewRequests)
            .set({ round: sql`${reviewRequests.round} + 1`, mentions, updatedAt: new Date().toISOString() })
            .where(eq(reviewRequests.id, id))
            .returning()
            .get()!,
      ),

    /** Runs whose thread is still running as far as we know; re-watched after a restart. */
    listUnsettledRuns: () => Effect.sync((): Run[] => db.select().from(runs).where(eq(runs.status, "started")).all()),

    /**
     * Every PR with runs in scope, most recently active first. The status reads
     * all of a PR's runs, so a pause streak that began before the range still
     * counts; review counts are the runs in scope. Verdicts come from
     * `reviewVerdict`, so counts match the pause logic.
     */
    pullRequests: (scope: RunScope = {}) =>
      Effect.sync((): PullRequestSummary[] => {
        const isPr = sql`json_extract(${runs.context}, '$.pr_number') is not null`;
        const prKey = (run: Run) => `${run.repo.toLowerCase()}#${run.context?.pr_number}`;
        const inScope = new Set(db.select({ id: runs.id }).from(runs).where(and(isPr, scopeWhere(scope))).all().map((run) => run.id));
        const all = db.select().from(runs).where(isPr).orderBy(desc(runs.createdAt), desc(sql`rowid`)).all();
        const listed = new Set(all.filter((run) => inScope.has(run.id)).map(prKey));
        const byPr = Map.groupBy(all.filter((run) => listed.has(prKey(run))), prKey);
        const limit = getSettings().maxChangesRequestedRounds;

        return [...byPr.values()].map((prRuns) => {
          // Newest first, and groupBy never yields an empty group.
          const latest = prRuns[0]!;
          const reviews = prRuns.filter((run) => run.event !== HANDOFF_EVENT);
          const finished = prRuns.filter((run) => run.status === "done" && run.result !== null);
          const latestVerdict = reviews.find((run) => run.status === "done");
          const status: PullRequestStatus = reviews.some((run) => run.status === "started")
            ? "reviewing"
            : reviews.some((run) => run.status === "queued")
              ? "queued"
              : limit > 0 && changesRequestedStreak(finished).length >= limit
                ? "paused"
                : latestVerdict
                  ? reviewVerdict(latestVerdict.result)
                  : latest.status === "failed"
                    ? "failed"
                    : "skipped";
          const scoped = reviews.filter((run) => inScope.has(run.id));
          const verdicts = scoped.filter((run) => run.status === "done").map((run) => reviewVerdict(run.result));
          const ctx = prRuns.find((run) => run.context?.pr_title)?.context ?? latest.context;
          return {
            repo: latest.repo,
            number: latest.context?.pr_number ?? "",
            title: ctx?.pr_title ?? null,
            url: ctx?.pr_url ?? null,
            author: prRuns.find((run) => run.author)?.author ?? null,
            status,
            reviews: verdicts.length,
            approved: verdicts.filter((verdict) => verdict === "approved").length,
            changesRequested: verdicts.filter((verdict) => verdict === "changes_requested").length,
            skipped: scoped.filter((run) => run.status === "skipped").length,
            failed: scoped.filter((run) => run.status === "failed").length,
            lastAt: latest.createdAt,
            threadUrl: prRuns.find((run) => run.threadUrl)?.threadUrl ?? null,
          };
        });
      }),

    /**
     * Aggregates over the runs in scope: totals, per day, per PR/issue author,
     * per trigger source, per prompt version and per model with its reasoning level. Days are calendar
     * days at `utcOffsetMinutes` (the browser's offset; UTC by default). With
     * `livePrompts`, the prompt table keeps only live versions.
     */
    analytics: (scope: RunScope = {}, utcOffsetMinutes = 0) =>
      Effect.sync((): Analytics => {
        const where = scopeWhere(scope);
        const counts = {
          total: count(),
          queued: statusCount("queued"),
          started: statusCount("started"),
          done: statusCount("done"),
          skipped: statusCount("skipped"),
          failed: statusCount("failed"),
        };
        const totalCostUsd = sql<number | null>`round(sum(${runUsage.costUsd}), 4)`;
        const avgRating = sql<number | null>`round(avg(${runs.rating}), 2)`;
        const avgInt = (column: AnyColumn) => sql<number | null>`cast(round(avg(${column})) as integer)`;
        // Selected over runs left-joined to their usage (one row per run at most).
        const stats = {
          ...counts,
          rated: count(runs.rating),
          avgRating,
          avgElapsedMs: sql<number | null>`cast(round(avg(${runs.elapsedMs})) as integer)`,
          measured: count(runUsage.runId),
          totalCostUsd,
          avgCostUsd: sql<number | null>`round(avg(${runUsage.costUsd}), 4)`,
          avgInputTokens: avgInt(runUsage.inputTokens),
          avgOutputTokens: avgInt(runUsage.outputTokens),
          avgCacheCreationTokens: avgInt(runUsage.cacheCreationTokens),
          avgCacheReadTokens: avgInt(runUsage.cacheReadTokens),
        };
        const scoped = () => db.select(stats).from(runs).leftJoin(runUsage, eq(runUsage.runId, runs.id));

        const all = scoped().where(where).get()!;
        const day = sql<string>`date(${runs.createdAt}, ${`${utcOffsetMinutes} minutes`})`;
        const byDay = db
          .select({ day, ...counts, totalCostUsd, avgRating })
          .from(runs)
          .leftJoin(runUsage, eq(runUsage.runId, runs.id))
          .where(where)
          .groupBy(day)
          .orderBy(day)
          .all();
        const byAuthor = db
          .select({ author: sql<string>`${runs.author}`, ...counts, totalCostUsd })
          .from(runs)
          .leftJoin(runUsage, eq(runUsage.runId, runs.id))
          .where(and(where, isNotNull(runs.author)))
          .groupBy(runs.author)
          .orderBy(desc(counts.total), runs.author)
          .all();
        const bySource = db
          .select({ source: runs.source, ...counts })
          .from(runs)
          .where(where)
          .groupBy(runs.source)
          .orderBy(desc(counts.total), runs.source)
          .all();
        const byPrompt = promptGroups(stats, and(where, promptCondition(scope))).all();
        const byModel = db
          .select({ modelInstanceId: sql<string>`${runs.modelInstanceId}`, modelId: sql<string>`${runs.modelId}`, reasoning: runs.reasoning, ...stats })
          .from(runs)
          .leftJoin(runUsage, eq(runUsage.runId, runs.id))
          .where(and(where, isNotNull(runs.modelId)))
          .groupBy(runs.modelInstanceId, runs.modelId, runs.reasoning)
          .orderBy(desc(counts.total), runs.modelId, runs.reasoning)
          .all();
        const usage = db
          .select({ runs: count(), measured: count(runUsage.runId), totalCostUsd })
          .from(runs)
          .leftJoin(runUsage, eq(runUsage.runId, runs.id))
          .where(and(where, isNotNull(runs.threadId), inArray(runs.status, ["done", "failed"])))
          .get() ?? { runs: 0, measured: 0, totalCostUsd: null };
        return { all, byDay, byAuthor, bySource, byPrompt, byModel, usage };
      }),

    /** The values of each run facet within a window (`from` and `to` of the scope), for the filter menus. */
    runFacets: ({ from, to }: Pick<RunScope, "from" | "to"> = {}) =>
      Effect.sync((): RunFacets => {
        const where = scopeWhere({ from, to });
        const total = count();
        const group = (column: SQLiteColumn) =>
          db
            .select({ value: sql<string>`${column}`, count: total })
            .from(runs)
            .where(and(where, isNotNull(column), sql`${column} != ''`))
            .groupBy(column)
            .orderBy(desc(total), column)
            .all();
        return {
          rules: db
            .select({ value: runs.ruleId, label: sql<string>`max(${runs.ruleName})`, count: total })
            .from(runs)
            .where(where)
            .groupBy(runs.ruleId)
            .orderBy(desc(total))
            .all(),
          sources: group(runs.source) as FacetValue<RunSource>[],
          models: group(runs.modelId),
          authors: group(runs.author),
          repos: group(runs.repo),
          statuses: group(runs.status) as FacetValue<Run["status"]>[],
          prompts: promptGroups({ count: total }, where).all(),
          liveRuns: db.select({ count: total }).from(runs).where(scopeWhere({ from, to, livePrompts: true })).get()?.count ?? 0,
        };
      }),
  };
}

export type StoreShape = ReturnType<typeof makeStore>;

/** The store as a service, built on the `Database` layer. */
export class Store extends Context.Service<Store, StoreShape>()("Store", { make: Effect.map(Database, makeStore) }) {
  static readonly layer = Layer.effect(this, this.make);
  /** A fresh in-memory database per use, for tests. */
  static readonly layerMemory = Layer.effect(this, this.make).pipe(Layer.provide(Database.layer(":memory:")));
}

function statusCount(status: Run["status"]) {
  return sql<number>`count(case when ${runs.status} = ${status} then 1 end)`.mapWith(Number);
}
