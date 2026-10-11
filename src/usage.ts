import { Cause, Context, Data, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { Background } from "./background.ts";
import { errorMessage } from "./errors.ts";
import { execOk } from "./exec.ts";
import { logger } from "./log.ts";
import type { Run, RunUsage } from "./rules.ts";
import { Store } from "./store.ts";
import { T3, type T3HttpError } from "./t3.ts";

const log = logger("usage");

/**
 * What runs spend, for comparing prompt versions and models: once a run
 * settles, the Claude Code sessions T3 ran its thread in are read by
 * [ccusage](https://github.com/ccusage/ccusage) from the local session logs
 * (`~/.claude/projects`), subagents included, and the tokens and estimated
 * cost are stored on the run (see `runUsage`). Tasks the thread delegated
 * through T3 run in threads of their own and count too, unless
 * `usageIncludesDelegatedTasks` is off in settings.
 */

/** The ccusage major whose JSON `CcusageSession` reads. `bun x` fetches it on first use and caches it. */
const CCUSAGE = "ccusage@20";
/** Claude Code deletes session logs after 30 days by default (`cleanupPeriodDays`), so older runs have nothing left to read. */
const LOG_RETENTION_DAYS = 30;

/** ccusage could not run, timed out, or printed something other than its session JSON. */
export class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

/**
 * `ccusage session --id <id> --json`: one entry per assistant message and the
 * session's estimated cost (entries carry no cost of their own); `null` when
 * no log has that session id.
 */
const CcusageSession = Schema.NullOr(
  Schema.Struct({
    totalCost: Schema.Number,
    entries: Schema.Array(
      Schema.Struct({
        model: Schema.String,
        inputTokens: Schema.Number,
        outputTokens: Schema.Number,
        cacheCreationTokens: Schema.Number,
        cacheReadTokens: Schema.Number,
      }),
    ),
  }),
);
const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(CcusageSession));

/** Tokens and estimated cost of one session. */
export type SessionUsage = Omit<RunUsage, "sessionIds" | "collectedAt">;

export type UsageShape = {
  /** Usage of one agent session, read from its local logs; null when ccusage finds no session with that id. */
  readonly session: (sessionId: string) => Effect.Effect<SessionUsage | null, UsageError>;
};

/** Sums the JSON of `ccusage session --id` into one usage; null when ccusage found no such session. */
export const parseSession = Effect.fn("usage.parse")(function* (stdout: string) {
  const session = yield* decodeSession(stdout);
  if (!session || session.entries.length === 0) return null;
  const sum = (key: "inputTokens" | "outputTokens" | "cacheCreationTokens" | "cacheReadTokens") => session.entries.reduce((total, entry) => total + entry[key], 0);
  const usage: SessionUsage = {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheCreationTokens: sum("cacheCreationTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    totalTokens: sum("inputTokens") + sum("outputTokens") + sum("cacheCreationTokens") + sum("cacheReadTokens"),
    costUsd: session.totalCost,
    models: [...new Set(session.entries.map((entry) => entry.model))],
  };
  return usage;
});

const readSession = (sessionId: string) =>
  execOk(process.execPath, ["x", CCUSAGE, "session", "--id", sessionId, "--json"]).pipe(
    Effect.timeout("2 minutes"),
    Effect.flatMap((output) => parseSession(output.stdout)),
    Effect.mapError((error) => new UsageError({ message: `ccusage failed for session ${sessionId}: ${error.message}` })),
    Effect.withSpan("usage.session", { attributes: { session: sessionId } }),
  );

/** Reads session usage with ccusage through `bun x`, so nothing needs installing; tests provide a fake. */
export class Usage extends Context.Service<Usage, UsageShape>()("Usage") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return { session: (sessionId) => readSession(sessionId).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)) };
    }),
  );
}

const addUsage = (a: SessionUsage, b: SessionUsage): SessionUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  totalTokens: a.totalTokens + b.totalTokens,
  costUsd: a.costUsd + b.costUsd,
  models: [...new Set([...a.models, ...b.models])],
});

/**
 * Provider session ids of a thread and, with `delegated`, of the T3 tasks it
 * delegated (`app_owned` subagents, each in a child thread with its own
 * sessions), at any depth. The agent's own subagents (`provider_native`) are
 * not followed: their logs sit under the parent's session, which ccusage
 * already counts. A delegated thread deleted in T3 is skipped; any other
 * failure fails the whole measurement (see recordUsage).
 */
const threadSessions = (threadId: string, delegated: boolean) =>
  Effect.gen(function* () {
    const t3 = yield* T3;
    const visited = new Set<string>();
    const sessions = new Set<string>();
    const visit = (id: string): Effect.Effect<void, T3HttpError> =>
      Effect.gen(function* () {
        if (visited.has(id)) return;
        visited.add(id);
        const thread = yield* t3.thread(id);
        for (const provider of thread.providerThreads) if (provider.nativeThreadRef) sessions.add(provider.nativeThreadRef.nativeId);
        if (!delegated) return;
        const children = thread.subagents.flatMap((task) => (task.origin === "app_owned" && task.childThreadId ? [task.childThreadId] : []));
        yield* Effect.forEach(children, (child) => visit(child).pipe(Effect.catchIf((error) => error.status === 404, () => Effect.void)), { discard: true });
      });
    yield* visit(threadId);
    return [...sessions];
  });

/**
 * Measures a run's thread and stores it, replacing an earlier measurement:
 * every provider session T3 ran the thread (and its delegated tasks) in,
 * summed. Returns null and stores nothing when T3 names no session or
 * ccusage finds none (another provider, or logs already deleted).
 *
 * All or nothing: when T3 or ccusage fails for any thread or session, nothing
 * is stored. A partial total would never be measured again (the backfill only
 * picks runs without usage) and would drag down the averages prompt versions
 * are compared on; an unmeasured run shows as `measured` below `total` and is
 * tried again by the next backfill.
 */
export const recordUsage = Effect.fn("usage.record")(function* (run: Pick<Run, "id" | "threadId">) {
  if (!run.threadId) return null;
  const store = yield* Store;
  const usage = yield* Usage;
  const ids = yield* threadSessions(run.threadId, (yield* store.getSettings()).usageIncludesDelegatedTasks);
  const found = (yield* Effect.forEach(ids, (id) => Effect.map(usage.session(id), (session) => (session ? [{ id, session }] : [])))).flat();
  if (found.length === 0) return null;
  const measured: RunUsage = {
    ...found.map(({ session }) => session).reduce(addUsage),
    sessionIds: found.map(({ id }) => id),
    collectedAt: new Date().toISOString(),
  };
  yield* store.saveRunUsage(run.id, measured);
  yield* log.info("usage recorded", { run: run.id, costUsd: measured.costUsd.toFixed(4), tokens: measured.totalTokens, sessions: found.length });
  return measured;
});

/** Settled runs that have no usage yet and whose logs may still exist (see LOG_RETENTION_DAYS), oldest first. */
const unmeasuredRuns = Effect.flatMap(Store, (store) => store.runsWithoutUsage(new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString()));

/**
 * Measures settled runs that have no usage yet, one at a time: runs from
 * before usage was recorded, and runs whose measuring failed.
 */
const backfillUsage = Effect.fn("usage.backfill")(function* () {
  const pending = yield* unmeasuredRuns;
  // Threads deleted in T3 and pruned logs are expected here: count them instead of logging each.
  const outcomes = yield* Effect.forEach(pending, (run) => Effect.result(recordUsage(run)));
  yield* log.info("usage backfilled", {
    runs: pending.length,
    recorded: outcomes.filter((outcome) => outcome._tag === "Success" && outcome.success !== null).length,
    failed: outcomes.filter((outcome) => outcome._tag === "Failure").length,
  });
});

const BACKFILL = "usage-backfill";

/** Runs a backfill would measure, and whether one is measuring them now. */
export type BackfillStatus = { pending: number; running: boolean };

export const backfillStatus = Effect.fn("usage.backfillStatus")(function* () {
  const status: BackfillStatus = { pending: (yield* unmeasuredRuns).length, running: yield* (yield* Background).isWatching(BACKFILL) };
  return status;
});

/**
 * Starts the backfill in the background, unless one is running already, and
 * returns its status. Startup, the API and the MCP tool share it.
 */
export const startBackfill = Effect.fn("usage.startBackfill")(function* () {
  const pending = (yield* unmeasuredRuns).length;
  if (pending > 0) {
    const job = backfillUsage().pipe(Effect.catchCause((cause) => log.warn("usage backfill failed", { error: errorMessage(Cause.squash(cause)) })));
    yield* (yield* Background).watch(BACKFILL, job);
  }
  const status: BackfillStatus = { pending, running: pending > 0 };
  return status;
});
