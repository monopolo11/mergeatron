import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runRules, startQueued } from "./handler.ts";
import { itemContext, itemEvent } from "./inbox.ts";
import { linear, pr, rule } from "./inbox.test.ts";
import { pauseProvider, QueueNotPausedError, rescheduleResume, resumeProvider, resumeTimersOnStartup } from "./queuePause.ts";
import { DEFAULT_SETTINGS } from "./rules.ts";
import { Store } from "./store.ts";
import type { T3Project } from "./t3.ts";
import { failureOf, fakeT3, runWith, settle, testLayer } from "./testing.ts";

const project: T3Project = { id: "p1", title: "widgets", workspaceRoot: "/w", deletedAt: null, defaultModelSelection: null, repositoryIdentity: null };

function setup() {
  const started: string[] = [];
  const t3 = fakeT3({
    projects: () => Effect.succeed([project]),
    startThread: (input) => Effect.sync(() => (started.push(`${input.modelSelection.instanceId}: ${input.title}`), { threadId: `t${started.length}`, threadUrl: `http://t3/t${started.length}` })),
  });
  return { layer: testLayer({ t3 }), started };
}

const other = { ...pr, key: "github:acme/widgets#43", identifier: "#43", url: "https://github.com/acme/widgets/pull/43", title: "Second PR" };
const { id: _id, createdAt: _c, updatedAt: _u, ...input } = rule;
/** Rules without a model start on the settings' model. */
const CLAUDE = DEFAULT_SETTINGS.model.instanceId;
const codex = { instanceId: "codex", model: "gpt-5.5" };
const limited = { id: "run0", threadUrl: "http://t3/t0" };
const LIMIT = "Claude API rate limit reached. Try again later.";
const HELD = `queued: ${CLAUDE} ran out of usage, waiting for it to resume`;
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
/** Resume timers are watchers, which `settle` does not wait for: give a due one a moment to fire. */
const timerFires = Effect.andThen(Effect.sleep("30 millis"), settle);

describe("provider pause", () => {
  test("a run on a paused provider waits as queued while other providers keep starting, and starts when its provider resumes", async () => {
    const { layer, started } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const onClaude = yield* store.createRule({ ...input, projectId: "p1" });
        const onCodex = yield* store.createRule({ ...input, name: "codex review", projectId: "p1", model: codex });
        yield* pauseProvider(CLAUDE, limited, LIMIT, inAnHour());
        expect(yield* store.listQueuePauses()).toMatchObject([{ instanceId: CLAUDE, reason: LIMIT, runId: "run0", threadUrl: "http://t3/t0" }]);

        const [held] = yield* runRules({ deliveryId: "d1", event: itemEvent(pr), ctx: itemContext(pr) }, [onClaude]);
        const [running] = yield* runRules({ deliveryId: "d2", event: itemEvent(other), ctx: itemContext(other) }, [onCodex]);
        yield* settle;
        expect(yield* store.getRun(held!.id)).toMatchObject({ status: "queued", detail: HELD, modelInstanceId: CLAUDE, threadId: null });
        expect(yield* store.getRun(running!.id)).toMatchObject({ status: "started", modelInstanceId: "codex" });
        expect(started).toEqual(["codex: codex review: Second PR"]);

        // A settle elsewhere advancing the rule's queue passes over it.
        yield* startQueued(onClaude.id);
        yield* settle;
        expect((yield* store.getRun(held!.id))!.status).toBe("queued");

        yield* resumeProvider(CLAUDE);
        yield* settle;
        expect(yield* store.listQueuePauses()).toEqual([]);
        expect(yield* store.getRun(held!.id)).toMatchObject({ status: "started", modelInstanceId: CLAUDE });
        expect(started).toEqual(["codex: codex review: Second PR", `${CLAUDE}: review: Add widgets`]);
      }),
    );
  });

  test("a held run frees its rule's slot, and resuming starts held runs within the rule's limit", async () => {
    const { layer, started } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const one = yield* store.createRule({ ...input, maxConcurrent: 1, projectId: "p1" });
        yield* pauseProvider(CLAUDE, limited, LIMIT, null);
        const [first] = yield* runRules({ deliveryId: "d1", event: itemEvent(pr), ctx: itemContext(pr) }, [one]);
        yield* settle;
        expect(yield* store.countRuns(one.id, "started")).toBe(0);
        // The slot is free, so the next match tries to start too, and is held the same way.
        const [second] = yield* runRules({ deliveryId: "d2", event: itemEvent(linear), ctx: itemContext(linear) }, [one]);
        yield* settle;
        expect((yield* store.getRun(second!.id))!.detail).toBe(HELD);

        yield* resumeProvider(CLAUDE);
        yield* settle;
        expect(started).toEqual([`${CLAUDE}: review: Add widgets`]);
        expect((yield* store.getRun(first!.id))!.status).toBe("started");
        expect((yield* store.getRun(second!.id))!.status).toBe("queued");
      }),
    );
  });

  test("the next queued run skips runs held for a paused provider, but not runs whose provider is not known yet", async () => {
    const { layer } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const queued = (deliveryId: string, modelInstanceId: string | null) =>
          Effect.flatMap(
            store.recordRun({ ruleId: "r", ruleName: "r", deliveryId, event: "e", repo: "", source: "manual", author: null, status: "queued", detail: "", threadId: null, threadUrl: null, context: null, result: null }),
            (run) => Effect.as(store.updateRun(run.id, { modelInstanceId }), run),
          );
        const onClaude = yield* queued("d1", CLAUDE);
        const unknown = yield* queued("d2", null);
        expect((yield* store.oldestQueuedRun("r"))!.id).toBe(onClaude.id);
        expect((yield* store.oldestQueuedRun("r", [CLAUDE]))!.id).toBe(unknown.id);
        yield* store.updateRun(unknown.id, { status: "done" });
        expect(yield* store.oldestQueuedRun("r", [CLAUDE])).toBeNull();
      }),
    );
  });

  test("threads that run out together keep the first pause and resume at the later reset; providers pause apart", async () => {
    const { layer } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const soon = new Date(Date.now() + 60_000).toISOString();
        const later = inAnHour();
        const first = yield* pauseProvider(CLAUDE, limited, LIMIT, soon);
        yield* pauseProvider(CLAUDE, { id: "run1", threadUrl: "http://t3/t1" }, "another limit", later);
        yield* pauseProvider(CLAUDE, { id: "run2", threadUrl: null }, "no reset", null);
        expect(yield* store.getQueuePause(CLAUDE)).toEqual({ ...first, resumeAt: later });

        yield* pauseProvider("codex", { id: "run3", threadUrl: null }, "You've hit your usage limit.", null);
        yield* resumeProvider(CLAUDE);
        expect(yield* store.listQueuePauses()).toMatchObject([{ instanceId: "codex", resumeAt: null }]);
        yield* resumeProvider("codex");
      }),
    );
  });

  test("a provider resumes on its own at the reset time, and a rescheduled time replaces it", async () => {
    const { layer, started } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const onClaude = yield* store.createRule({ ...input, projectId: "p1" });
        yield* pauseProvider(CLAUDE, limited, LIMIT, inAnHour());
        yield* runRules({ deliveryId: "d1", event: itemEvent(pr), ctx: itemContext(pr) }, [onClaude]);
        yield* timerFires;
        expect(started).toEqual([]);

        // Picking a time already past resumes right away.
        const pause = yield* rescheduleResume(CLAUDE, new Date(Date.now() - 1_000).toISOString());
        expect(pause.reason).toBe(LIMIT);
        yield* timerFires;
        expect(yield* store.listQueuePauses()).toEqual([]);
        expect(started).toEqual([`${CLAUDE}: review: Add widgets`]);
      }),
    );
  });

  test("a reset time already past when the thread fails resumes at once", async () => {
    const { layer } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        yield* pauseProvider(CLAUDE, limited, LIMIT, new Date(Date.now() - 60_000).toISOString());
        yield* timerFires;
        expect(yield* (yield* Store).listQueuePauses()).toEqual([]);
      }),
    );
  });

  test("pauses left by the previous process re-arm their timers at startup", async () => {
    const { layer } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        const store = yield* Store;
        const pause = { pausedAt: new Date().toISOString(), reason: LIMIT, runId: null, threadUrl: null };
        yield* store.saveQueuePause({ ...pause, instanceId: CLAUDE, resumeAt: new Date(Date.now() - 1_000).toISOString() });
        yield* store.saveQueuePause({ ...pause, instanceId: "codex", resumeAt: null });
        yield* resumeTimersOnStartup();
        yield* timerFires;
        expect(yield* store.listQueuePauses()).toMatchObject([{ instanceId: "codex" }]);
      }),
    );
  });

  test("rescheduling a provider that is not paused fails; resuming one is a no-op", async () => {
    const { layer } = setup();
    await runWith(
      layer,
      Effect.gen(function* () {
        expect(yield* failureOf(rescheduleResume(CLAUDE, inAnHour()))).toBeInstanceOf(QueueNotPausedError);
        yield* resumeProvider(CLAUDE);
        expect(yield* (yield* Store).listQueuePauses()).toEqual([]);
      }),
    );
  });
});
