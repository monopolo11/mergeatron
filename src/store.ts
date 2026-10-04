import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { changesRequestedStreak, reviewVerdict } from "./verdict.ts";
import { Database, type AppDatabase } from "./db/index.ts";
import { inboxItems, promptVersions, prompts, reviewRequests, rules, runActions, runPrompts, runs, settings } from "./db/schema.ts";
import type { InboxItem, PolledItem } from "./inbox.ts";
import {
  DEFAULT_SETTINGS,
  type Prompt,
  type PromptRef,
  type PromptInput,
  type PromptVersion,
  type ReviewRequest,
  type Rule,
  type RuleInput,
  type RuleUpdate,
  type Run,
  type RunAction,
  type Settings,
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
 * mean time threads worked; null when no run had one.
 */
export type RunStats = RunCounts & { rated: number; avgRating: number | null; avgElapsedMs: number | null };

export type Analytics = {
  all: RunCounts;
  /** Connection tests carry no author and are left out of this list. */
  byAuthor: (RunCounts & { author: string })[];
  bySource: (RunCounts & { source: RunSource })[];
  /**
   * Per prompt version, to compare versions. A dispatch of stacked presets
   * counts under each. `name` is the preset's or rule's, null once deleted.
   */
  byPrompt: (RunStats & PromptRef & { name: string | null })[];
  /** Per model a thread started with; runs that never started one have none. */
  byModel: (RunStats & { modelInstanceId: string; modelId: string })[];
};

/** Which runs `listRuns` returns, newest first. Every field narrows; none means the latest 100. */
export type RunFilter = {
  ruleId?: string;
  status?: Run["status"];
  source?: RunSource;
  /** Runs whose first message came from this preset or rule prompt, or from one version of it. */
  prompt?: { owner: PromptVersionOwner; id: string; version?: number };
  /** Model id, e.g. `claude-opus-5-5`, whatever the provider instance. */
  model?: string;
  /** True for rated runs only, false for unrated ones. */
  rated?: boolean;
  /** ISO timestamp: runs created at or after it. */
  since?: string;
  limit?: number;
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

/** Filled in once a thread starts (see StartResult in handler.ts), when the run settles, or when it is rated. */
type RunOutcome = "modelInstanceId" | "modelId" | "rating" | "feedback" | "ratedAt" | "startedAt" | "settledAt" | "elapsedMs";

/** Statuses that end a run. */
const SETTLED = new Set<Run["status"]>(["done", "skipped", "failed"]);

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

/** A rating: 0 to 10 or none, with the written review that goes with it. */
export type RunRating = Pick<Run, "rating" | "feedback">;

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

    listRuns: ({ limit = 100, ...filter }: RunFilter = {}) =>
      Effect.sync((): Run[] => {
        const { prompt } = filter;
        const where = and(
          filter.ruleId === undefined ? undefined : eq(runs.ruleId, filter.ruleId),
          filter.status === undefined ? undefined : eq(runs.status, filter.status),
          filter.source === undefined ? undefined : eq(runs.source, filter.source),
          filter.model === undefined ? undefined : eq(runs.modelId, filter.model),
          filter.rated === undefined ? undefined : filter.rated ? isNotNull(runs.ratedAt) : isNull(runs.ratedAt),
          filter.since === undefined ? undefined : gte(runs.createdAt, filter.since),
          prompt &&
            inArray(
              runs.id,
              db
                .select({ id: runPrompts.runId })
                .from(runPrompts)
                .where(
                  and(
                    eq(runPrompts.owner, prompt.owner),
                    eq(runPrompts.ownerId, prompt.id),
                    prompt.version === undefined ? undefined : eq(runPrompts.version, prompt.version),
                  ),
                ),
            ),
        );
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
                .values({ ...settings, runId: row.id, modelInstanceId: model?.instanceId ?? null, modelId: model?.model ?? null })
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

    /** What a rule-driven run was set to start with; null for handoffs and connection tests. */
    getRunAction: (runId: string) =>
      Effect.sync((): RunAction | null => {
        const row = db.select().from(runActions).where(eq(runActions.runId, runId)).get();
        if (!row) return null;
        const { runId: _, modelInstanceId, modelId, ...settings } = row;
        const promptRefs = db
          .select({ owner: runPrompts.owner, id: runPrompts.ownerId, version: runPrompts.version })
          .from(runPrompts)
          .where(eq(runPrompts.runId, runId))
          .orderBy(runPrompts.position)
          .all();
        return { ...settings, model: modelInstanceId && modelId ? { instanceId: modelInstanceId, model: modelId } : null, promptRefs };
      }),

    /** Runs of a rule in one status; `started` against the rule's concurrency limit. */
    countRuns: (ruleId: string, status: Run["status"]) =>
      Effect.sync(() => db.select({ n: count() }).from(runs).where(and(eq(runs.ruleId, ruleId), eq(runs.status, status))).get()?.n ?? 0),

    /** Next run of a rule waiting for capacity: queued the longest. */
    oldestQueuedRun: (ruleId: string) =>
      Effect.sync(
        (): Run | null =>
          db
            .select()
            .from(runs)
            .where(and(eq(runs.ruleId, ruleId), eq(runs.status, "queued")))
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

    /** Starts the next review round and returns the updated request. */
    nextReviewRound: (id: string) =>
      Effect.sync(
        (): ReviewRequest =>
          db
            .update(reviewRequests)
            .set({ round: sql`${reviewRequests.round} + 1`, updatedAt: new Date().toISOString() })
            .where(eq(reviewRequests.id, id))
            .returning()
            .get()!,
      ),

    /** Runs whose thread is still running as far as we know; re-watched after a restart. */
    listUnsettledRuns: () => Effect.sync((): Run[] => db.select().from(runs).where(eq(runs.status, "started")).all()),

    /** Every PR with runs, most recently active first. Verdicts come from `reviewVerdict`, so counts match the pause logic. */
    pullRequests: () =>
      Effect.sync((): PullRequestSummary[] => {
        const all = db
          .select()
          .from(runs)
          .where(sql`json_extract(${runs.context}, '$.pr_number') is not null`)
          .orderBy(desc(runs.createdAt), desc(sql`rowid`))
          .all();
        const byPr = Map.groupBy(all, (run) => `${run.repo.toLowerCase()}#${run.context?.pr_number}`);
        const limit = getSettings().maxChangesRequestedRounds;

        return [...byPr.values()].map((prRuns) => {
          // Newest first, and groupBy never yields an empty group.
          const latest = prRuns[0]!;
          const reviews = prRuns.filter((run) => run.event !== HANDOFF_EVENT);
          const done = reviews.filter((run) => run.status === "done");
          const verdicts = done.map((run) => reviewVerdict(run.result));
          const finished = prRuns.filter((run) => run.status === "done" && run.result !== null);
          const status: PullRequestStatus = reviews.some((run) => run.status === "started")
            ? "reviewing"
            : reviews.some((run) => run.status === "queued")
              ? "queued"
              : limit > 0 && changesRequestedStreak(finished).length >= limit
                ? "paused"
                : (verdicts[0] ?? (latest.status === "failed" ? "failed" : "skipped"));
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
            skipped: reviews.filter((run) => run.status === "skipped").length,
            failed: reviews.filter((run) => run.status === "failed").length,
            lastAt: latest.createdAt,
            threadUrl: prRuns.find((run) => run.threadUrl)?.threadUrl ?? null,
          };
        });
      }),

    /** Aggregates over every run: totals, per PR/issue author, per trigger source, per prompt version and per model. */
    analytics: () =>
      Effect.sync((): Analytics => {
        const counts = {
          total: count(),
          queued: statusCount("queued"),
          started: statusCount("started"),
          done: statusCount("done"),
          skipped: statusCount("skipped"),
          failed: statusCount("failed"),
        };
        const all = db.select(counts).from(runs).get() ?? { total: 0, queued: 0, started: 0, done: 0, skipped: 0, failed: 0 };
        const byAuthor = db
          .select({ author: sql<string>`${runs.author}`, ...counts })
          .from(runs)
          .where(sql`${runs.author} is not null`)
          .groupBy(runs.author)
          .orderBy(desc(counts.total), runs.author)
          .all();
        const bySource = db
          .select({ source: runs.source, ...counts })
          .from(runs)
          .groupBy(runs.source)
          .orderBy(desc(counts.total), runs.source)
          .all();

        const rated = {
          ...counts,
          rated: count(runs.rating),
          avgRating: sql<number | null>`round(avg(${runs.rating}), 2)`,
          avgElapsedMs: sql<number | null>`cast(round(avg(${runs.elapsedMs})) as integer)`,
        };
        // The preset's or rule's name, or a dispatch's (its version note); null once a preset or rule is deleted.
        const name = sql<string | null>`coalesce(${prompts.name}, ${rules.name}, case when ${runPrompts.owner} = 'dispatch' then ${promptVersions.note} end)`;
        const byPrompt = db
          .select({ owner: runPrompts.owner, id: runPrompts.ownerId, version: runPrompts.version, name, ...rated })
          .from(runPrompts)
          .innerJoin(runs, eq(runs.id, runPrompts.runId))
          .innerJoin(
            promptVersions,
            and(eq(promptVersions.owner, runPrompts.owner), eq(promptVersions.ownerId, runPrompts.ownerId), eq(promptVersions.version, runPrompts.version)),
          )
          .leftJoin(prompts, and(eq(runPrompts.owner, "preset"), eq(prompts.id, runPrompts.ownerId)))
          .leftJoin(rules, and(eq(runPrompts.owner, "rule"), eq(rules.id, runPrompts.ownerId)))
          .groupBy(runPrompts.owner, runPrompts.ownerId, runPrompts.version)
          .orderBy(runPrompts.owner, runPrompts.ownerId, desc(runPrompts.version))
          .all();

        const byModel = db
          .select({ modelInstanceId: sql<string>`${runs.modelInstanceId}`, modelId: sql<string>`${runs.modelId}`, ...rated })
          .from(runs)
          .where(isNotNull(runs.modelId))
          .groupBy(runs.modelInstanceId, runs.modelId)
          .orderBy(desc(counts.total))
          .all();
        return { all, byAuthor, bySource, byPrompt, byModel };
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
