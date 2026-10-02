import { Clock, Context, Duration, Effect, FiberMap, Layer, Metric, Option, Redacted, Semaphore } from "effect";
import { Background } from "./background.ts";
import { AppConfig } from "./config.ts";
import { GitHubInbox } from "./githubInbox.ts";
import { runRules, type HandlerServices } from "./handler.ts";
import { automationsFor, itemContext, itemDeliveryId, itemEvent, type InboxItem, type InboxLabel, type LabelsResponse, type PolledItem } from "./inbox.ts";
import type { InboxSourceClient } from "./inboxSource.ts";
import { LinearInbox } from "./linearInbox.ts";
import { logger } from "./log.ts";
import type { Run } from "./rules.ts";
import { INBOX_SOURCES, type InboxSource } from "./shared.ts";
import { Store } from "./store.ts";

const log = logger("poll");

/** How long a source's synced labels are kept before the next poll refreshes them. */
const LABEL_SYNC = Duration.hours(1);
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

const polls = Metric.counter("orchestrator_polls_total", { incremental: true, description: "Inbox polls, by source and result" });
const inboxSize = Metric.gauge("orchestrator_inbox_items", { description: "Items the last poll of a source returned" });

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

export type PollerShape = {
  /** First poll right away, then on each source's interval. */
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  /** Applies new intervals: the next poll of each source moves to `lastPolledAt + minutes`, or now if that has passed. */
  readonly reschedule: Effect.Effect<void>;
  readonly list: (options?: { gone?: boolean }) => Effect.Effect<InboxItem[]>;
  readonly find: (key: string) => Effect.Effect<InboxItem | null>;
  readonly labelCatalog: Effect.Effect<LabelsResponse>;
  readonly statuses: Effect.Effect<Record<InboxSource, PollStatus>>;
  /** A poll asked for from the UI; the interval restarts from it. */
  readonly pollNow: (source: InboxSource) => Effect.Effect<PollStatus>;
  /** Polls one source now and runs its automations. Errors are kept on the status, not failed: the UI shows them and the next tick retries. */
  readonly poll: (source: InboxSource) => Effect.Effect<PollStatus>;
  /** Starts every armed rule for these items; `armed: false` backfills a rule on everything that matches ("Run now" in the editor). Returns the runs recorded. */
  readonly runAutomations: (items: PolledItem[], options?: { armed: boolean; ruleId?: string }) => Effect.Effect<Run[]>;
  /** Refreshes a source's labels when they are an hour old or, for GitHub, when the repositories to cover changed. A failed sync keeps the previous labels and is retried after the next poll. */
  readonly syncLabels: (source: InboxSource) => Effect.Effect<void>;
};

/**
 * Polls each configured source on its own interval (Settings), writes the
 * items to the store (see `Store.syncInbox`) and after every poll starts the
 * rules armed for them (see `automationsFor`) and refreshes stale labels.
 * Each source has one loop fiber (sleep, poll, repeat) that `reschedule`
 * replaces, and one permit per source so a manual poll never overlaps the
 * scheduled one. Items survive restarts, so the inbox is full before the
 * first poll; the run log's delivery ids keep automations from firing twice.
 */
export const makePoller = (sources: Record<InboxSource, InboxSourceClient | null>) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const background = yield* Background;
    const handlerServices = yield* Effect.context<HandlerServices>();
    const loops = yield* FiberMap.make<InboxSource, unknown, never>();
    const polling = Object.fromEntries(INBOX_SOURCES.map((source) => [source, Semaphore.makeUnsafe(1)])) as Record<InboxSource, Semaphore.Semaphore>;
    const syncing = Object.fromEntries(INBOX_SOURCES.map((source) => [source, Semaphore.makeUnsafe(1)])) as Record<InboxSource, Semaphore.Semaphore>;
    const status = new Map<InboxSource, PollStatus>();
    /** Last synced labels per source, with the repos they cover; in memory, since the first poll after a start refills them. */
    const labels = new Map<InboxSource, { labels: InboxLabel[]; repos: string; syncedAt: number }>();

    const stored = yield* store.listInbox();
    const settings = yield* store.getSettings();
    for (const source of INBOX_SOURCES) {
      const { enabled, minutes } = settings.polling[source];
      const items = stored.filter((item) => item.source === source).length;
      status.set(source, { configured: sources[source] !== null, enabled, minutes, polling: false, login: null, lastPolledAt: null, lastError: null, nextAt: null, items });
    }
    const state = (source: InboxSource) => status.get(source)!;
    const now = Clock.currentTimeMillis;

    const list: PollerShape["list"] = (options = {}) => store.listInbox(options);

    /** Repositories GitHub labels are synced for: those of retained inbox items and of rule filters, lowercased. */
    const labelRepos = Effect.gen(function* () {
      const items = yield* list({ gone: true });
      const rules = yield* store.listRules();
      const repos = [...items.flatMap((item) => item.repo ?? []), ...rules.flatMap((rule) => rule.repos)];
      return [...new Set(repos.map((repo) => repo.toLowerCase()).filter((repo) => REPO_NAME.test(repo)))].toSorted();
    });

    const syncLabels: PollerShape["syncLabels"] = (source) =>
      Effect.gen(function* () {
        const client = sources[source];
        const repos = source === "github" ? yield* labelRepos : [];
        const synced = labels.get(source);
        const fresh = synced && synced.repos === repos.join(",") && (yield* now) - synced.syncedAt < Duration.toMillis(LABEL_SYNC);
        if (!client || fresh) return;
        const sync = client.labels(repos).pipe(
          Effect.flatMap((fetched) =>
            Effect.gen(function* () {
              labels.set(source, { labels: fetched, repos: repos.join(","), syncedAt: yield* now });
              yield* log.info("labels synced", { source, labels: fetched.length, repos: repos.length || undefined });
            }),
          ),
          Effect.catch((error) => log.warn("label sync failed", { source, error: error.message })),
        );
        // Skipped while a sync of the same source is still running.
        yield* Semaphore.withPermitsIfAvailable(syncing[source], 1)(sync);
      }).pipe(Effect.withSpan("poller.syncLabels", { attributes: { source } }));

    const runAutomations: PollerShape["runAutomations"] = (items, options = { armed: true }) =>
      Effect.gen(function* () {
        const rules = (yield* store.listRules()).filter((rule) => !options.ruleId || rule.id === options.ruleId);
        const runs: Run[] = [];
        for (const item of items) {
          // The matcher is pure; look up which of its candidate deliveries already ran first.
          const handled = new Set<string>();
          for (const rule of rules) {
            const deliveryId = itemDeliveryId(item, rule);
            if (yield* store.hasRun(deliveryId, rule.id)) handled.add(`${deliveryId}\n${rule.id}`);
          }
          for (const { rule, deliveryId } of automationsFor(item, rules, (id, ruleId) => handled.has(`${id}\n${ruleId}`), options)) {
            yield* log.info("automation armed", { rule: rule.name, item: item.key, delivery: deliveryId });
            const started = yield* runRules({ deliveryId, event: itemEvent(item), ctx: itemContext(item) }, [rule]).pipe(Effect.provide(handlerServices));
            runs.push(...started);
          }
        }
        return runs;
      }).pipe(Effect.withSpan("poller.runAutomations", { attributes: { items: items.length } }));

    const poll: PollerShape["poll"] = (source) =>
      Effect.gen(function* () {
        const current = state(source);
        const client = sources[source];
        if (!client) return { ...current };
        const attempt = Effect.gen(function* () {
          current.polling = true;
          const fetched = yield* Effect.result(client.fetch());
          const polledAt = new Date(yield* now).toISOString();
          if (fetched._tag === "Failure") {
            current.lastError = fetched.failure.message;
            current.lastPolledAt = polledAt;
            yield* Metric.update(Metric.withAttributes(polls, { source, result: "failed" }), 1);
            yield* log.warn("poll failed", { source, error: current.lastError });
            return;
          }
          const { login, items } = fetched.success;
          const synced = yield* store.syncInbox(source, items);
          yield* store.pruneInbox();
          Object.assign(current, { login, items: items.length, lastError: null, lastPolledAt: polledAt });
          yield* Metric.update(Metric.withAttributes(polls, { source, result: "ok" }), 1);
          yield* Metric.update(Metric.withAttributes(inboxSize, { source }), items.length);
          const started = yield* runAutomations(items);
          yield* background.fork(syncLabels(source));
          yield* log.info("polled", {
            source,
            items: items.length,
            appeared: synced.appeared || undefined,
            returned: synced.returned || undefined,
            gone: synced.gone || undefined,
            started: started.length || undefined,
          });
        }).pipe(
          Effect.ensuring(Effect.sync(() => (current.polling = false))),
          Effect.withSpan("poller.poll", { attributes: { source } }),
        );
        // A poll already in flight for this source answers with the current status.
        yield* Semaphore.withPermitsIfAvailable(polling[source], 1)(attempt);
        return { ...current };
      });

    /** The loop of one source: sleep, poll, repeat on the interval from Settings. */
    const loop = (source: InboxSource, firstDelayMs: number) =>
      Effect.gen(function* () {
        let delayMs = firstDelayMs;
        for (;;) {
          state(source).nextAt = new Date((yield* now) + delayMs).toISOString();
          yield* Effect.sleep(Duration.millis(delayMs));
          // A reschedule mid-poll lets the poll finish; only the sleep is cut short.
          yield* Effect.uninterruptible(poll(source));
          delayMs = state(source).minutes * 60_000;
        }
      });

    /** Replaces the source's loop with one that first polls after `delayMs`; disabled or unconfigured sources get none. */
    const schedule = (source: InboxSource, delayMs: number) =>
      Effect.gen(function* () {
        const current = state(source);
        if (!current.configured || !current.enabled) {
          current.nextAt = null;
          yield* FiberMap.remove(loops, source);
          return;
        }
        yield* FiberMap.run(loops, source, loop(source, delayMs));
      });

    const shape: PollerShape = {
      start: Effect.forEach(INBOX_SOURCES, (source) => schedule(source, 0), { discard: true }),
      stop: Effect.gen(function* () {
        yield* FiberMap.clear(loops);
        for (const source of INBOX_SOURCES) state(source).nextAt = null;
      }),
      reschedule: Effect.gen(function* () {
        const settings = yield* store.getSettings();
        const at = yield* now;
        for (const source of INBOX_SOURCES) {
          const current = state(source);
          const { enabled, minutes } = settings.polling[source];
          Object.assign(current, { enabled, minutes });
          const due = current.lastPolledAt ? Date.parse(current.lastPolledAt) + minutes * 60_000 : at;
          yield* schedule(source, Math.max(0, due - at));
        }
      }),
      list,
      find: (key) => store.getInboxItem(key),
      labelCatalog: Effect.sync(() => Object.fromEntries(INBOX_SOURCES.map((source) => [source, labels.get(source)?.labels ?? []])) as LabelsResponse),
      statuses: Effect.sync(() => Object.fromEntries(INBOX_SOURCES.map((source) => [source, { ...state(source) }])) as Record<InboxSource, PollStatus>),
      pollNow: (source) =>
        Effect.gen(function* () {
          const result = yield* poll(source);
          yield* schedule(source, result.minutes * 60_000);
          return result;
        }),
      poll,
      runAutomations,
      syncLabels,
    };
    return shape;
  });

export class Poller extends Context.Service<Poller, PollerShape>()("Poller") {
  /** A poller over the given sources; tests pass fakes. */
  static readonly layerWith = (sources: Record<InboxSource, InboxSourceClient | null>) => Layer.effect(this, makePoller(sources));

  /** GitHub through `gh`, and Linear when `LINEAR_API_KEY` is set. */
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const github = yield* GitHubInbox.live;
      const linear = Option.isSome(config.linearApiKey) ? yield* LinearInbox.live(Redacted.value(config.linearApiKey.value)) : null;
      return yield* makePoller({ github, linear });
    }),
  );
}
