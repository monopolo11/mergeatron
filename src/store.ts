import { and, count, desc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "./db/index.ts";
import { rules, runs, settings } from "./db/schema.ts";
import { DEFAULT_SETTINGS, type Rule, type RuleInput, type Run, type Settings } from "./rules.ts";
import type { RunSource } from "./shared.ts";

/** Run counts split by status, for one grouping key. */
export type RunCounts = { total: number; started: number; skipped: number; failed: number };

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

  updateRun(id: string, patch: Pick<Run, "status" | "detail" | "threadId" | "threadUrl">): void {
    this.db.update(runs).set(patch).where(eq(runs.id, id)).run();
  }

  /** Aggregates over every run: totals, per PR/issue author, and per trigger source. */
  analytics(): Analytics {
    const counts = {
      total: count(),
      started: statusCount("started"),
      skipped: statusCount("skipped"),
      failed: statusCount("failed"),
    };
    const all = this.db.select(counts).from(runs).get() ?? { total: 0, started: 0, skipped: 0, failed: 0 };
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
      .orderBy(desc(counts.total))
      .all();
    return { all, byAuthor, bySource };
  }
}

function statusCount(status: Run["status"]) {
  return sql<number>`count(case when ${runs.status} = ${status} then 1 end)`.mapWith(Number);
}
