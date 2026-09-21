import { and, count, desc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "./db/index.ts";
import { rules, runs, settings } from "./db/schema.ts";
import { DEFAULT_SETTINGS, type Rule, type RuleInput, type Run, type Settings } from "./rules.ts";
import type { RunSource } from "./shared.ts";

/** Run counts split by status, for one grouping key. */
export type RunCounts = { total: number; started: number; done: number; skipped: number; failed: number };

export type Analytics = {
  all: RunCounts;
  /** Connection tests carry no author and are left out of this list. */
  byAuthor: (RunCounts & { author: string })[];
  bySource: (RunCounts & { source: RunSource })[];
};

/** Typed access to rules, global settings, and the run log. */
export class Store {
  constructor(private db: AppDatabase) {}

  listRules(): Rule[] {
    return this.db.select().from(rules).orderBy(rules.createdAt).all();
  }

  createRule(input: RuleInput): Rule {
    const now = new Date().toISOString();
    return this.db
      .insert(rules)
      .values({ ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now })
      .returning()
      .get();
  }

  updateRule(id: string, input: RuleInput): Rule | null {
    return (
      this.db
        .update(rules)
        .set({ ...input, updatedAt: new Date().toISOString() })
        .where(eq(rules.id, id))
        .returning()
        .get() ?? null
    );
  }

  deleteRule(id: string): boolean {
    return this.db.delete(rules).where(eq(rules.id, id)).returning().get() !== undefined;
  }

  getSettings(): Settings {
    const row = this.db.select().from(settings).where(eq(settings.id, 1)).get();
    return row ? { model: row.model, runtimeMode: row.runtimeMode } : DEFAULT_SETTINGS;
  }

  saveSettings(next: Settings): void {
    this.db
      .insert(settings)
      .values({ id: 1, ...next })
      .onConflictDoUpdate({ target: settings.id, set: next })
      .run();
  }

  listRuns(limit = 100): Run[] {
    return this.db.select().from(runs).orderBy(desc(runs.createdAt)).limit(limit).all();
  }

  /** True when this delivery was already handled for the rule (GitHub retries deliveries). */
  hasRun(deliveryId: string, ruleId: string): boolean {
    return (
      this.db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.deliveryId, deliveryId), eq(runs.ruleId, ruleId)))
        .get() !== undefined
    );
  }

  recordRun(run: Omit<Run, "id" | "createdAt">): Run {
    return this.db
      .insert(runs)
      .values({ ...run, id: crypto.randomUUID(), createdAt: new Date().toISOString() })
      .returning()
      .get();
  }

  updateRun(id: string, patch: Partial<Omit<Run, "id" | "createdAt">>): void {
    this.db.update(runs).set(patch).where(eq(runs.id, id)).run();
  }

  getRun(id: string): Run | null {
    return this.db.select().from(runs).where(eq(runs.id, id)).get() ?? null;
  }

  /** The run still reviewing this PR, if any. One review per PR at a time, across all rules and triggers. */
  activeRunForPullRequest(repo: string, prNumber: string): Run | null {
    return (
      this.db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.status, "started"),
            sql`lower(${runs.repo}) = lower(${repo})`,
            sql`json_extract(${runs.context}, '$.pr_number') = ${prNumber}`,
          ),
        )
        .orderBy(desc(runs.createdAt))
        .get() ?? null
    );
  }

  /** Most recent finished review of this PR with a reply, for `{{previous_result}}`. */
  latestReviewForPullRequest(repo: string, prNumber: string): Run | null {
    return (
      this.db
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
        .orderBy(desc(runs.createdAt))
        .get() ?? null
    );
  }

  /** The run started by this Slack message (the review a thread hangs under), for "second pass" mentions in that thread. */
  runForSlackMessage(channel: string, ts: string): Run | null {
    return (
      this.db
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
        .get() ?? null
    );
  }

  /** Runs whose thread is still running as far as we know; re-watched after a restart. */
  listUnsettledRuns(): Run[] {
    return this.db.select().from(runs).where(eq(runs.status, "started")).all();
  }

  /** Aggregates over every run: totals, per PR/issue author, and per trigger source. */
  analytics(): Analytics {
    const counts = {
      total: count(),
      started: statusCount("started"),
      done: statusCount("done"),
      skipped: statusCount("skipped"),
      failed: statusCount("failed"),
    };
    const all = this.db.select(counts).from(runs).get() ?? { total: 0, started: 0, done: 0, skipped: 0, failed: 0 };
    const byAuthor = this.db
      .select({ author: sql<string>`${runs.author}`, ...counts })
      .from(runs)
      .where(sql`${runs.author} is not null`)
      .groupBy(runs.author)
      .orderBy(desc(counts.total), runs.author)
      .all();
    const bySource = this.db
      .select({ source: runs.source, ...counts })
      .from(runs)
      .groupBy(runs.source)
      .orderBy(desc(counts.total), runs.source)
      .all();
    return { all, byAuthor, bySource };
  }
}

function statusCount(status: Run["status"]) {
  return sql<number>`count(case when ${runs.status} = ${status} then 1 end)`.mapWith(Number);
}
