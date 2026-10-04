import { and, count, desc, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { changesRequestedStreak, reviewVerdict } from "./verdict.ts";
import { Database, type AppDatabase } from "./db/index.ts";
import { inboxItems, prompts, reviewRequests, rules, runs, settings } from "./db/schema.ts";
import type { InboxItem, PolledItem } from "./inbox.ts";
import { DEFAULT_SETTINGS, type Prompt, type PromptInput, type ReviewRequest, type Rule, type RuleInput, type Run, type RunAction, type Settings } from "./rules.ts";
import { DEFAULT_POLLING, DEFAULT_PROMPTS, HANDOFF_EVENT, type InboxSource, type RunSource } from "./shared.ts";

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

export type Analytics = {
  all: RunCounts;
  /** Connection tests carry no author and are left out of this list. */
  byAuthor: (RunCounts & { author: string })[];
  bySource: (RunCounts & { source: RunSource })[];
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

/** What `recordRun` needs; `action` is only set on queued runs, see RunAction. */
export type RunInput = Omit<Run, "id" | "createdAt" | "action"> & { action?: RunAction | null };

/**
 * Typed access to rules, prompt presets, global settings, the inbox and the
 * run log. SQLite is synchronous, so every method is a small `Effect.sync`
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
  const createPrompt = (input: PromptInput): Prompt => {
    const now = new Date().toISOString();
    return db
      .insert(prompts)
      .values({ ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now })
      .returning()
      .get();
  };

  return {
    listPrompts: () => Effect.sync(listPrompts),
    createPrompt: (input: PromptInput) => Effect.sync(() => createPrompt(input)),

    updatePrompt: (id: string, input: PromptInput) =>
      Effect.sync(
        () =>
          db
            .update(prompts)
            .set({ ...input, updatedAt: new Date().toISOString() })
            .where(eq(prompts.id, id))
            .returning()
            .get() ?? null,
      ),

    getPrompt: (id: string) => Effect.sync((): Prompt | null => db.select().from(prompts).where(eq(prompts.id, id)).get() ?? null),

    /** Rules linked to the preset keep their own text and stop following it. */
    deletePrompt: (id: string) =>
      Effect.sync(() =>
        db.transaction((tx) => {
          tx.update(rules).set({ presetId: null }).where(eq(rules.presetId, id)).run();
          return tx.delete(prompts).where(eq(prompts.id, id)).returning().get() !== undefined;
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

    createRule: (input: RuleInput) =>
      Effect.sync((): Rule => {
        const now = new Date().toISOString();
        return db
          .insert(rules)
          .values({ ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now })
          .returning()
          .get();
      }),

    updateRule: (id: string, input: RuleInput) =>
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

    deleteRule: (id: string) => Effect.sync(() => db.delete(rules).where(eq(rules.id, id)).returning().get() !== undefined),

    getSettings: () => Effect.sync(getSettings),

    saveSettings: (next: Settings) =>
      Effect.sync(() => {
        db.insert(settings)
          .values({ id: 1, ...next })
          .onConflictDoUpdate({ target: settings.id, set: next })
          .run();
      }),

    listRuns: (limit = 100) => Effect.sync((): Run[] => db.select().from(runs).orderBy(desc(runs.createdAt)).limit(limit).all()),

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

    recordRun: (run: RunInput) =>
      Effect.sync(
        (): Run =>
          db
            .insert(runs)
            .values({ action: null, ...run, id: crypto.randomUUID(), createdAt: new Date().toISOString() })
            .returning()
            .get(),
      ),

    updateRun: (id: string, patch: Partial<Omit<Run, "id" | "createdAt">>) =>
      Effect.sync(() => {
        db.update(runs).set(patch).where(eq(runs.id, id)).run();
      }),

    getRun: (id: string) => Effect.sync((): Run | null => db.select().from(runs).where(eq(runs.id, id)).get() ?? null),

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

    /** Aggregates over every run: totals, per PR/issue author, and per trigger source. */
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
        return { all, byAuthor, bySource };
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
