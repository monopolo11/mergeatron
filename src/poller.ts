import type { HandlerDeps } from "./handler.ts";
import { runRules } from "./handler.ts";
import { automationsFor, itemContext, itemEvent, type InboxItem, type InboxLabel, type LabelsResponse, type PolledItem } from "./inbox.ts";
import { logger } from "./log.ts";
import type { Run } from "./rules.ts";
import { INBOX_SOURCES, type InboxSource } from "./shared.ts";

const log = logger("poll");

/** What a source needs to provide; see GitHubInbox and LinearInbox. */
export type InboxSourceClient = {
  fetch(): Promise<{ login: string | null; items: PolledItem[] }>;
  /** Labels its items can carry. GitHub labels live on repositories, so it gets the `owner/name`s to cover. */
  labels(repos: string[]): Promise<InboxLabel[]>;
};

/** How long a source's synced labels are kept before the next poll refreshes them. */
const LABEL_SYNC_MS = 60 * 60_000;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

export type PollStatus = {
  /** The source has what it needs: `gh` for GitHub, `LINEAR_API_KEY` for Linear. */
  configured: boolean;
  enabled: boolean;
  minutes: number;
  polling: boolean;
  /** Who the API says you are, once a poll succeeded. */
  login: string | null;
  lastPolledAt: string | null;
  lastError: string | null;
  nextAt: string | null;
  items: number;
};

/**
 * Polls each configured source on its own interval (Settings), writes the
 * items to the store (see `Store.syncInbox`) and after every poll starts the
 * rules armed for them (see `automationsFor`) and refreshes stale labels
 * (see `syncLabels`). Items survive restarts, so the
 * inbox is full before the first poll; the run log's delivery ids keep
 * automations from firing twice.
 */
export class Poller {
  private readonly timers = new Map<InboxSource, Timer>();
  private readonly status = new Map<InboxSource, PollStatus>();
  /** Last synced labels per source, with the repos they cover; in memory, since the first poll after a start refills them. */
  private readonly labels = new Map<InboxSource, { labels: InboxLabel[]; repos: string; syncedAt: number }>();
  private readonly syncingLabels = new Set<InboxSource>();
  private stopped = false;

  constructor(
    private readonly deps: HandlerDeps,
    private readonly sources: Record<InboxSource, InboxSourceClient | null>,
  ) {
    const stored = deps.store.listInbox();
    for (const source of INBOX_SOURCES) {
      const { enabled, minutes } = deps.store.getSettings().polling[source];
      const items = stored.filter((item) => item.source === source).length;
      this.status.set(source, { configured: sources[source] !== null, enabled, minutes, polling: false, login: null, lastPolledAt: null, lastError: null, nextAt: null, items });
    }
  }

  /** First poll right away, then on each source's interval. */
  start(): void {
    this.stopped = false;
    for (const source of INBOX_SOURCES) this.schedule(source, 0);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Applies new intervals: the next poll of each source moves to `lastPolledAt + minutes`, or now if that has passed. */
  reschedule(): void {
    for (const source of INBOX_SOURCES) {
      const status = this.state(source);
      const { enabled, minutes } = this.deps.store.getSettings().polling[source];
      Object.assign(status, { enabled, minutes });
      const due = status.lastPolledAt ? Date.parse(status.lastPolledAt) + minutes * 60_000 : Date.now();
      this.schedule(source, Math.max(0, due - Date.now()));
    }
  }

  list(options: { gone?: boolean } = {}): InboxItem[] {
    return this.deps.store.listInbox(options);
  }

  find(key: string): InboxItem | null {
    return this.deps.store.getInboxItem(key);
  }

  labelCatalog(): LabelsResponse {
    return Object.fromEntries(INBOX_SOURCES.map((source) => [source, this.labels.get(source)?.labels ?? []])) as LabelsResponse;
  }

  statuses(): Record<InboxSource, PollStatus> {
    return Object.fromEntries(INBOX_SOURCES.map((source) => [source, this.state(source)])) as Record<InboxSource, PollStatus>;
  }

  /** A poll asked for from the UI; the interval restarts from it. */
  async pollNow(source: InboxSource): Promise<PollStatus> {
    const status = await this.poll(source);
    this.schedule(source, status.minutes * 60_000);
    return status;
  }

  /**
   * Polls one source now and runs its automations. Errors are kept on the
   * status, not thrown: the UI shows them and the next tick retries.
   */
  async poll(source: InboxSource): Promise<PollStatus> {
    const status = this.state(source);
    const client = this.sources[source];
    if (!client || status.polling) return status;
    status.polling = true;
    try {
      const { login, items } = await client.fetch();
      const synced = this.deps.store.syncInbox(source, items);
      this.deps.store.pruneInbox();
      Object.assign(status, { login, items: items.length, lastError: null, lastPolledAt: new Date().toISOString() });
      const started = this.runAutomations(items);
      void this.syncLabels(source);
      log.info("polled", {
        source,
        items: items.length,
        appeared: synced.appeared || undefined,
        returned: synced.returned || undefined,
        gone: synced.gone || undefined,
        started: started.length || undefined,
      });
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
      status.lastPolledAt = new Date().toISOString();
      log.warn("poll failed", { source, error: status.lastError });
    } finally {
      status.polling = false;
    }
    return status;
  }

  /**
   * Starts every armed rule for these items; `armed: false` backfills a rule
   * on everything that matches ("Run now" in the editor). Returns the runs recorded.
   */
  runAutomations(items: PolledItem[], options: { armed: boolean; ruleId?: string } = { armed: true }): Run[] {
    const rules = this.deps.store.listRules().filter((rule) => !options.ruleId || rule.id === options.ruleId);
    const hasRun = (deliveryId: string, ruleId: string) => this.deps.store.hasRun(deliveryId, ruleId);
    return items.flatMap((item) =>
      automationsFor(item, rules, hasRun, options).flatMap(({ rule, deliveryId }) => {
        log.info("automation armed", { rule: rule.name, item: item.key, delivery: deliveryId });
        return runRules(this.deps, { deliveryId, event: itemEvent(item), ctx: itemContext(item) }, [rule]);
      }),
    );
  }

  /**
   * Refreshes a source's labels when they are an hour old or, for GitHub,
   * when the repositories to cover changed. A failed sync keeps the previous
   * labels and is retried after the next poll.
   */
  async syncLabels(source: InboxSource): Promise<void> {
    const client = this.sources[source];
    const repos = source === "github" ? this.labelRepos() : [];
    const synced = this.labels.get(source);
    const fresh = synced && synced.repos === repos.join(",") && Date.now() - synced.syncedAt < LABEL_SYNC_MS;
    if (!client || fresh || this.syncingLabels.has(source)) return;
    this.syncingLabels.add(source);
    try {
      const labels = await client.labels(repos);
      this.labels.set(source, { labels, repos: repos.join(","), syncedAt: Date.now() });
      log.info("labels synced", { source, labels: labels.length, repos: repos.length || undefined });
    } catch (error) {
      log.warn("label sync failed", { source, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.syncingLabels.delete(source);
    }
  }

  /** Repositories GitHub labels are synced for: those of retained inbox items and of rule filters, lowercased. */
  private labelRepos(): string[] {
    const repos = [...this.list({ gone: true }).flatMap((item) => item.repo ?? []), ...this.deps.store.listRules().flatMap((rule) => rule.repos)];
    return [...new Set(repos.map((repo) => repo.toLowerCase()).filter((repo) => REPO_NAME.test(repo)))].toSorted();
  }

  private schedule(source: InboxSource, delayMs: number): void {
    const status = this.state(source);
    clearTimeout(this.timers.get(source));
    this.timers.delete(source);
    if (this.stopped || !status.configured || !status.enabled) {
      status.nextAt = null;
      return;
    }
    status.nextAt = new Date(Date.now() + delayMs).toISOString();
    this.timers.set(
      source,
      setTimeout(() => {
        this.timers.delete(source);
        void this.poll(source).then(() => {
          // A reschedule during the poll already set the next timer.
          if (!this.timers.has(source)) this.schedule(source, this.state(source).minutes * 60_000);
        });
      }, delayMs),
    );
  }

  private state(source: InboxSource): PollStatus {
    return this.status.get(source)!;
  }
}
