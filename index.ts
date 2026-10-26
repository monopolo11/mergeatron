import { BunChildProcessSpawner, BunHttpServer, BunRuntime, BunServices, BunSocket } from "@effect/platform-bun";
import { Cause, Config, Effect, Layer, Metric, Option, Redacted, SubscriptionRef } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse, type HttpServerError } from "effect/http";
import { Otlp, OtlpSerialization, PrometheusMetrics } from "effect/observability";
import index from "./frontend/index.html";
import { Background, RunEvents } from "./src/background.ts";
import { resumeWatchers, reviewVerdict, watchCompletion } from "./src/completion.ts";
import { AppConfig } from "./src/config.ts";
import { Database } from "./src/db/index.ts";
import { copyLegacyDatabase } from "./src/db/legacy.ts";
import { errorMessage } from "./src/errors.ts";
import { eventKey, extractContext, verifySignature } from "./src/github.ts";
import { dispatchPrompt, handleDelivery, runRules, startQueued, type HandlerServices } from "./src/handler.ts";
import { itemContext, itemEvent, type InboxResponse } from "./src/inbox.ts";
import { logger, loggerLayer } from "./src/log.ts";
import { makeMcpHandler, type McpServices } from "./src/mcp.ts";
import { Poller } from "./src/poller.ts";
import { PullRequests } from "./src/pulls.ts";
import { rescheduleResume, resumeProvider, resumeTimersOnStartup } from "./src/queuePause.ts";
import { createVersion, listPresets, promoteVersion, readPrompt } from "./src/promptVersions.ts";
import { DispatchInput, PromptInput, PromptRename, PromptVersionInput, QueueResumeInput, RuleInput, RuleUpdate, AnalyticsQuery, RunQuery, RunRatingInput, RunScopeQuery, runScope, SettingsInput, TestThreadInput, WebhookInput, WebhookUpdate, type Rule } from "./src/rules.ts";
import { deleteRun, getRun, listRuns, rateRun } from "./src/runHistory.ts";
import { startPullRequestBackfill, syncPullRequests } from "./src/runPullRequests.ts";
import { handleSlackEvent } from "./src/secondPass.ts";
import { Sentry } from "./src/sentryInbox.ts";
import { EMPTY_FILTERS, INBOX_SOURCES, WEBHOOK_SECRET_HEADER } from "./src/shared.ts";
import { runSlackSocket, SlackClient, SlackSocket } from "./src/slack.ts";
import { Store } from "./src/store.ts";
import { supervisorLayer } from "./src/supervisor.ts";
import { T3 } from "./src/t3.ts";
import { Updater } from "./src/update.ts";
import { backfillStatus, startBackfill, Usage } from "./src/usage.ts";
import { generateSecret, receiveWebhook } from "./src/webhooks.ts";

const log = logger("server");
const webhookLog = logger("webhook");

/*
 * The service is one Effect layer graph, launched with BunRuntime.runMain:
 *
 *   platform (HTTP client, WebSocket constructor, child processes) + AppConfig
 *     └─ services: Database → Store, T3, SlackClient, PullRequests, Background, RunEvents, Updater, Usage
 *          └─ Sentry
 *               └─ Poller, SlackSocket
 *                    └─ HTTP API, MCP API, supervisor, startup, telemetry
 *
 * Shutting down (SIGINT/SIGTERM) closes the scope in reverse: servers stop,
 * background fibers (watchers, polls, the Slack socket) are interrupted, the
 * database closes.
 */

/** Everything a route may need; captured once so handlers run with no requirements of their own. */
type ApiServices = HandlerServices | AppConfig | Poller | Sentry | Updater | SlackSocket | PullRequests;

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

/** HTTP status for the typed errors routes let through; anything else is a 500 with its message. */
const STATUS: Record<string, number> = { SchemaError: 400, HttpServerError: 400, PromptNotFoundError: 404, RunNotFoundError: 404, InvalidFollowUpError: 400, RunActiveError: 409, WebhookNotFoundError: 404, WebhookSecretError: 401, InvalidPayloadError: 400, T3HttpError: 502, T3RpcError: 502, InboxSourceError: 502, UpdateError: 409, QueueNotPausedError: 409 };

const api = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<ApiServices>();
    const config = yield* AppConfig;
    const store = yield* Store;
    const t3 = yield* T3;
    const poller = yield* Poller;
    const sentry = yield* Sentry;
    const updater = yield* Updater;
    const slackSocket = yield* SlackSocket;
    const background = yield* Background;
    const webhookSecret = Option.map(config.webhookSecret, Redacted.value);
    const mcpUrl = Option.isSome(config.slack) ? `http://127.0.0.1:${config.mcpPort}/mcp` : null;

    /** Runs a route with the services and turns typed failures into JSON error responses. */
    const route = <E extends { readonly _tag: string; readonly message: string }>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, ApiServices | HttpServerRequest.HttpServerRequest | HttpServerRequest.ParsedSearchParams | HttpRouter.RouteContext>) =>
      effect.pipe(
        Effect.catch((error) => Effect.succeed(json({ error: error.message }, STATUS[error._tag] ?? 500))),
        Effect.provide(services),
      );
    const body = HttpServerRequest.schemaBodyJson;
    const param = (name: string) => Effect.map(HttpRouter.params, (params) => params[name] ?? "");

    yield* router.add(
      "GET",
      "/api/status",
      route(
        Effect.gen(function* () {
          const environment = yield* t3.environment.pipe(Effect.orElseSucceed(() => null));
          return json({
            t3: { origin: t3.origin, environment },
            webhookSecretConfigured: Option.isSome(webhookSecret),
            slack: yield* slackSocket.status,
            mcp: mcpUrl,
            sentry: Option.getOrNull(Option.map(sentry, (client) => client.instance)),
          });
        }),
      ),
    );

    yield* router.add("GET", "/api/t3/projects", route(Effect.map(t3.projects(), json)));
    yield* router.add("GET", "/api/t3/providers", route(Effect.map(t3.providers(), json)));

    /** Starts a tiny thread in a project to prove the token, RPC and provider work end to end. */
    yield* router.add(
      "POST",
      "/api/t3/test-thread",
      route(
        Effect.gen(function* () {
          const input = yield* body(TestThreadInput);
          const project = (yield* t3.projects()).find((p) => p.id === input.projectId);
          if (!project) return json({ error: "project not found in T3" }, 404);
          const settings = yield* store.getSettings();
          const run = yield* store.recordRun({
            ruleId: "manual",
            ruleName: "connection test",
            deliveryId: crypto.randomUUID(),
            event: "manual.test",
            repo: project.title,
            source: "manual",
            author: null,
            status: "started",
            detail: "starting thread",
            threadId: null,
            threadUrl: null,
            context: null,
            result: null,
            action: null,
          });
          const prompt = "Connection test from the GitHub webhook orchestrator. Reply with the single word ok and do nothing else.";
          const model = project.defaultModelSelection ?? settings.model;
          const started = yield* Effect.result(
            t3.startThread({
              project,
              title: "Orchestrator connection test",
              prompt,
              modelSelection: model,
              runtimeMode: settings.runtimeMode,
              baseBranch: null,
              worktree: false,
              pullRequest: null,
            }),
          );
          if (started._tag === "Failure") {
            yield* store.updateRun(run.id, { status: "failed", detail: started.failure.message, threadId: null, threadUrl: null });
            return json({ error: started.failure.message }, 502);
          }
          const startedAt = new Date().toISOString();
          yield* store.updateRun(run.id, { status: "started", detail: `checkout ${project.workspaceRoot}`, ...started.success, modelInstanceId: model.instanceId, modelId: model.model, startedAt });
          yield* watchCompletion({ ...run, threadId: started.success.threadId, startedAt });
          return json(started.success, 201);
        }),
      ),
    );

    /** Compares the running code with upstream; POST fast-forwards, installs and restarts. */
    yield* router.add("GET", "/api/update", route(Effect.map(updater.check, json)));
    yield* router.add(
      "POST",
      "/api/update",
      route(
        Effect.gen(function* () {
          const result = yield* updater.apply;
          yield* log.info("update applied, restarting", { from: result.from, to: result.to, restart: result.restart });
          // Let the response leave before the process goes away.
          yield* background.fork(Effect.delay(updater.restart(result.restart), "500 millis"));
          return json(result);
        }),
      ),
    );

    yield* router.add("GET", "/api/settings", route(Effect.map(store.getSettings(), json)));
    yield* router.add(
      "PUT",
      "/api/settings",
      route(
        Effect.gen(function* () {
          const settings = yield* body(SettingsInput);
          const filtersChanged = !Bun.deepEquals((yield* store.getSettings()).sentryFilters, settings.sentryFilters);
          yield* store.saveSettings(settings);
          yield* poller.reschedule;
          // New Sentry filters change what belongs in the inbox: poll now rather than at the next tick.
          if (filtersChanged) yield* background.fork(poller.pollNow("sentry"));
          return json(settings);
        }),
      ),
    );

    /**
     * Persisted inbox items with the latest run on each, plus per-source polling status. `?gone=1` appends departed items that had a run.
     * Only PR runs get a review verdict: an issue run's reply is a work summary, and quoting a "changes requested" review there is not one.
     */
    yield* router.add(
      "GET",
      "/api/inbox",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const items = yield* poller.list({ gone: new URL(request.url, "http://localhost").searchParams.get("gone") === "1" });
          const latest = yield* store.latestRunsByUrl(items.map((item) => item.url));
          const response: InboxResponse = {
            polling: yield* poller.statuses,
            gone: yield* store.countGoneInbox(),
            items: items.map((item) => {
              const run = latest.get(item.url);
              const verdict = run?.status === "done" && item.kind === "pull_request" ? reviewVerdict(run.result) : null;
              return {
                ...item,
                lastRun: run
                  ? { id: run.id, status: run.status, ruleName: run.ruleName, detail: run.detail, threadUrl: run.threadUrl, createdAt: run.createdAt, verdict }
                  : null,
              };
            }),
          };
          return json(response);
        }),
      ),
    );

    /** Sentry projects, environments and tags, for the filter suggestions in Settings. */
    yield* router.add(
      "GET",
      "/api/sentry/options",
      route(
        Option.match(sentry, {
          onNone: () => Effect.succeed(json({ error: "Sentry is off: set SENTRY_AUTH_TOKEN and SENTRY_ORG in .env" }, 404)),
          onSome: (client) => Effect.map(client.options, json),
        }),
      ),
    );

    /** Labels synced from each source, for the rule editor's suggestions. */
    yield* router.add("GET", "/api/labels", route(Effect.map(poller.labelCatalog, json)));

    yield* router.add(
      "POST",
      "/api/inbox/poll",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { source } = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as { source?: string };
          const known = INBOX_SOURCES.find((s) => s === source);
          if (!known) return json({ error: `source must be one of ${INBOX_SOURCES.join(", ")}` }, 400);
          return json(yield* poller.pollNow(known));
        }),
      ),
    );

    /** One thread per item with the composed prompt. Dispatches by hand review even paused PRs. */
    yield* router.add(
      "POST",
      "/api/inbox/dispatch",
      route(
        Effect.gen(function* () {
          const { keys, name, presets, ...action } = yield* body(DispatchInput);
          const items = yield* Effect.forEach(keys, (key) => poller.find(key));
          const missing = keys.filter((_, i) => !items[i]);
          if (missing.length > 0) return json({ error: `not in the inbox: ${missing.join(", ")}` }, 404);
          const promptRefs = yield* dispatchPrompt(presets, action.prompt, name);
          const now = new Date().toISOString();
          const rule: Rule = {
            id: "dispatch",
            name,
            enabled: true,
            events: [],
            repos: [],
            reviewer: null,
            channel: null,
            allowBots: true,
            skipSelfReview: false,
            filters: EMPTY_FILTERS,
            presetId: null,
            livePromptVersion: 1,
            ...action,
            createdAt: now,
            updatedAt: now,
          };
          const runs = yield* Effect.forEach(items, (item) =>
            runRules(
              { deliveryId: crypto.randomUUID(), event: itemEvent(item!), ctx: itemContext(item!), source: "manual", force: true },
              [rule],
              promptRefs,
            ),
          );
          return json(runs.flat(), 201);
        }),
      ),
    );

    yield* router.add("GET", "/api/prompts", route(Effect.map(listPresets(), json)));
    yield* router.add("POST", "/api/prompts", route(Effect.flatMap(body(PromptInput), (input) => Effect.map(store.createPrompt(input), (prompt) => json(prompt, 201)))));
    yield* router.add(
      "PUT",
      "/api/prompts/:id",
      route(
        Effect.gen(function* () {
          const { name } = yield* body(PromptRename);
          const prompt = yield* store.renamePrompt(yield* param("id"), name);
          return prompt ? json(prompt) : json({ error: "not found" }, 404);
        }),
      ),
    );
    yield* router.add(
      "DELETE",
      "/api/prompts/:id",
      route(Effect.map(Effect.flatMap(param("id"), store.deletePrompt), (deleted) => (deleted ? HttpServerResponse.empty({ status: 204 }) : json({ error: "not found" }, 404)))),
    );

    yield* router.add("GET", "/api/rules", route(Effect.map(store.listRules(), json)));
    yield* router.add("POST", "/api/rules", route(Effect.flatMap(body(RuleInput), (input) => Effect.map(store.createRule(input), (rule) => json(rule, 201)))));
    yield* router.add(
      "PUT",
      "/api/rules/:id",
      route(
        Effect.gen(function* () {
          const rule = yield* store.updateRule(yield* param("id"), yield* body(RuleUpdate));
          if (!rule) return json({ error: "not found" }, 404);
          // A raised limit lets queued runs start now rather than at the next settle.
          yield* startQueued(rule.id);
          return json(rule);
        }),
      ),
    );
    yield* router.add(
      "DELETE",
      "/api/rules/:id",
      route(Effect.map(Effect.flatMap(param("id"), store.deleteRule), (deleted) => (deleted ? HttpServerResponse.empty({ status: 204 }) : json({ error: "not found" }, 404)))),
    );

    /** Custom webhooks (see src/webhooks.ts). The secret is generated here; POST `:id/secret` replaces it. */
    yield* router.add("GET", "/api/webhooks", route(Effect.map(store.listWebhooks(), json)));
    yield* router.add(
      "POST",
      "/api/webhooks",
      route(
        Effect.gen(function* () {
          const input = yield* body(WebhookInput);
          const webhook = yield* store.createWebhook({ ...input, secret: generateSecret() });
          return webhook ? json(webhook, 201) : json({ error: `a webhook named ${input.slug} already exists` }, 409);
        }),
      ),
    );
    yield* router.add(
      "PUT",
      "/api/webhooks/:id",
      route(
        Effect.gen(function* () {
          const webhook = yield* store.updateWebhook(yield* param("id"), yield* body(WebhookUpdate));
          return webhook ? json(webhook) : json({ error: "not found" }, 404);
        }),
      ),
    );
    yield* router.add(
      "POST",
      "/api/webhooks/:id/secret",
      route(Effect.map(Effect.flatMap(param("id"), (id) => store.updateWebhook(id, { secret: generateSecret() })), (webhook) => (webhook ? json(webhook) : json({ error: "not found" }, 404)))),
    );
    yield* router.add(
      "DELETE",
      "/api/webhooks/:id",
      route(Effect.map(Effect.flatMap(param("id"), store.deleteWebhook), (deleted) => (deleted ? HttpServerResponse.empty({ status: 204 }) : json({ error: "not found" }, 404)))),
    );

    /** Backfill: runs an inbox rule on every item it matches now, not only on new activity. */
    yield* router.add(
      "POST",
      "/api/rules/:id/run-now",
      route(
        Effect.gen(function* () {
          const rule = yield* store.getRule(yield* param("id"));
          if (!rule) return json({ error: "not found" }, 404);
          return json(yield* poller.runAutomations(yield* poller.list(), { armed: false, ruleId: rule.id }), 201);
        }),
      ),
    );

    /**
     * Prompt versions of a preset or a rule. Saving appends a version (a draft
     * unless `promote` is set); promoting makes it the text runs use. Each
     * returns the prompt's history after the change.
     */
    for (const [path, owner] of [["prompts", "preset"], ["rules", "rule"]] as const) {
      yield* router.add("GET", `/api/${path}/:id/versions`, route(Effect.map(Effect.flatMap(param("id"), (id) => readPrompt(owner, id)), json)));
      yield* router.add(
        "POST",
        `/api/${path}/:id/versions`,
        route(
          Effect.gen(function* () {
            const id = yield* param("id");
            yield* createVersion(owner, id, yield* body(PromptVersionInput), "ui");
            return json(yield* readPrompt(owner, id), 201);
          }),
        ),
      );
      yield* router.add(
        "POST",
        `/api/${path}/:id/versions/:version/promote`,
        route(
          Effect.gen(function* () {
            const id = yield* param("id");
            yield* promoteVersion(owner, id, Number(yield* param("version")));
            return json(yield* readPrompt(owner, id));
          }),
        ),
      );
    }

    /** Providers paused because a thread ran out of usage: PUT moves one's resume time, DELETE resumes it now (see src/queuePause.ts). */
    yield* router.add("GET", "/api/queue/pauses", route(Effect.map(store.listQueuePauses(), json)));
    yield* router.add(
      "PUT",
      "/api/queue/pauses/:instanceId",
      route(
        Effect.gen(function* () {
          const { resumeAt } = yield* body(QueueResumeInput);
          return json(yield* rescheduleResume(yield* param("instanceId"), resumeAt));
        }),
      ),
    );
    yield* router.add("DELETE", "/api/queue/pauses/:instanceId", route(Effect.as(Effect.flatMap(param("instanceId"), resumeProvider), HttpServerResponse.empty({ status: 204 }))));

    yield* router.add("GET", "/api/runs", route(Effect.map(store.listRuns(), json)));
    /** The runs page: summaries matching its filters, one run in full, rating a run and deleting it (see src/runHistory.ts). */
    yield* router.add(
      "GET",
      "/api/runs/history",
      route(
        Effect.gen(function* () {
          const { limit, ...query } = yield* HttpServerRequest.schemaSearchParams(RunQuery);
          return json(yield* listRuns({ ...runScope(query), limit }));
        }),
      ),
    );
    /** How many settled runs lack usage and whether a backfill is measuring them; POST starts one (see src/usage.ts). */
    yield* router.add("GET", "/api/runs/usage/backfill", route(Effect.map(backfillStatus(), json)));
    yield* router.add("POST", "/api/runs/usage/backfill", route(Effect.map(startBackfill(), (started) => json(started, 202))));
    yield* router.add("GET", "/api/runs/:id", route(Effect.map(Effect.flatMap(param("id"), getRun), json)));
    /** PRs linked to the run's thread, read from T3 again (see src/runPullRequests.ts). */
    yield* router.add("GET", "/api/runs/:id/pull-requests", route(Effect.map(Effect.flatMap(param("id"), syncPullRequests), json)));
    yield* router.add("DELETE", "/api/runs/:id", route(Effect.as(Effect.flatMap(param("id"), deleteRun), HttpServerResponse.empty({ status: 204 }))));
    yield* router.add(
      "PUT",
      "/api/runs/:id/rating",
      route(
        Effect.gen(function* () {
          const id = yield* param("id");
          return json(yield* rateRun(id, yield* body(RunRatingInput)));
        }),
      ),
    );
    /** The values each filter offers within a window, with run counts. */
    yield* router.add("GET", "/api/runs/facets", route(Effect.map(Effect.flatMap(HttpServerRequest.schemaSearchParams(RunScopeQuery), store.runFacets), json)));
    yield* router.add(
      "GET",
      "/api/analytics",
      route(
        Effect.gen(function* () {
          const { utcOffset, ...query } = yield* HttpServerRequest.schemaSearchParams(AnalyticsQuery);
          return json(yield* store.analytics(runScope(query), utcOffset));
        }),
      ),
    );
    yield* router.add("GET", "/api/pulls", route(Effect.map(Effect.flatMap(HttpServerRequest.schemaSearchParams(RunScopeQuery), (query) => store.pullRequests(runScope(query))), json)));

    yield* router.add(
      "POST",
      "/webhooks/github",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const rawBody = yield* request.text;
          const deliveryId = request.headers["x-github-delivery"] ?? crypto.randomUUID();
          const eventName = request.headers["x-github-event"];
          if (Option.isSome(webhookSecret) && !verifySignature(webhookSecret.value, rawBody, request.headers["x-hub-signature-256"] ?? null)) {
            yield* webhookLog.warn("rejected: invalid signature", { delivery: deliveryId, github: eventName });
            return json({ error: "invalid signature" }, 401);
          }
          if (!eventName) {
            yield* webhookLog.warn("rejected: missing X-GitHub-Event header", { delivery: deliveryId });
            return json({ error: "missing X-GitHub-Event header" }, 400);
          }
          if (eventName === "ping") {
            yield* webhookLog.info("ping", { delivery: deliveryId });
            return json({ ok: true });
          }
          const payload = yield* Effect.try(() => JSON.parse(rawBody) as unknown).pipe(Effect.option);
          if (Option.isNone(payload)) {
            yield* webhookLog.warn("rejected: body is not JSON", { delivery: deliveryId, github: eventName });
            return json({ error: "body is not JSON" }, 400);
          }
          const event = eventKey(eventName, payload.value);
          const ctx = extractContext(eventName, payload.value);
          yield* webhookLog.info("event received", {
            delivery: deliveryId,
            event,
            repo: ctx.repo || undefined,
            pr: ctx.pr_number,
            sender: ctx.sender,
            reviewer: ctx.requested_reviewer,
          });
          return json(yield* handleDelivery({ deliveryId, event, ctx }), 202);
        }),
      ),
    );

    yield* router.add(
      "POST",
      "/webhooks/custom/:slug",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const delivery = yield* receiveWebhook({ slug: yield* param("slug"), secret: request.headers[WEBHOOK_SECRET_HEADER], body: yield* request.text });
          return json(delivery, 202);
        }),
      ),
    );
  }),
);

/** The UI and API on `PORT`. Client-side routes serve the HTML bundle; the router in frontend/app.tsx picks the view. */
const httpLayer = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    HttpRouter.serve(Layer.mergeAll(api, PrometheusMetrics.layerHttp({ path: "/api/metrics" })), { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provide(
        BunHttpServer.layer({
          port: config.port,
          development: config.development,
          // Fetching over SSH plus bun install (POST /api/update) outlasts Bun's 10s default.
          idleTimeout: 120,
          routes: { "/": index, "/inbox": index, "/runs": index, "/reviews": index, "/analytics": index, "/settings": index },
        }),
      ),
    ),
  ),
);

/**
 * MCP tools for other agents (see src/mcp.ts) on their own loopback-only
 * port: the main port may be tunnelled to GitHub, and these post as the bot.
 * Only with Slack configured.
 */
const mcpRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const handle = yield* makeMcpHandler;
    yield* router.add(
      "*",
      "/mcp",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const web = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.promise(() => handle(web));
        return HttpServerResponse.fromWeb(response);
      }),
    );
  }),
);
const mcpLayer: Layer.Layer<never, HttpServerError.ServeError, AppConfig | McpServices> = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    Option.isSome(config.slack)
      ? HttpRouter.serve(mcpRoutes, { disableLogger: true, disableListenLog: true }).pipe(
          // request_review waits on `gh` and a few Slack calls.
          Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: config.mcpPort, idleTimeout: 60 })),
        )
      : Layer.empty,
  ),
);

/**
 * Slack events arrive over Socket Mode, not a webhook: each `event_callback`
 * is treated like a delivery keyed `slack.<type>`; a "second pass" mention in
 * a review thread re-reviews that PR in a new T3 thread. Slack redelivers
 * unacked envelopes; `event_id` dedupes those.
 */
const slackSocketLayer = Layer.effect(
  SlackSocket,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    if (Option.isNone(config.slack)) return { status: Effect.succeed("off" as const) };
    const services = yield* Effect.context<HandlerServices | PullRequests>();
    const connected = yield* SubscriptionRef.make(false);
    yield* Effect.forkScoped(
      runSlackSocket({
        appToken: Redacted.value(config.slack.value.appToken),
        connected,
        onEvent: (payload) =>
          handleSlackEvent(payload).pipe(
            Effect.provide(services),
            Effect.catchCause((cause) => log.error("slack event failed", { error: errorMessage(Cause.squash(cause)) })),
          ),
      }),
    );
    return { status: Effect.map(SubscriptionRef.get(connected), (open) => (open ? ("connected" as const) : ("connecting" as const))) };
  }),
);

/**
 * Seeds presets, re-attaches watchers, queues and paused providers' resume timers left by the previous process,
 * starts polling, measures runs that settled without usage, and says hello.
 */
const startupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const store = yield* Store;
    const t3 = yield* T3;
    const poller = yield* Poller;
    yield* store.ensureDefaultPrompts();
    yield* resumeWatchers;
    yield* resumeTimersOnStartup();
    yield* Effect.forEach(yield* store.queuedRuleIds(), startQueued, { discard: true });
    yield* poller.start;
    yield* startBackfill();
    yield* startPullRequestBackfill();
    yield* log.info("GitHub -> T3 Code orchestrator started", {
      url: `http://localhost:${config.port}/`,
      t3: t3.origin,
      webhook: `http://localhost:${config.port}/webhooks/github`,
      slack: Option.isSome(config.slack) ? "starting" : "off",
      mcp: Option.isSome(config.slack) ? `http://127.0.0.1:${config.mcpPort}/mcp` : "off (needs Slack)",
      inbox: ["github", Option.isSome(config.linearApiKey) && "linear", Option.isSome(config.sentry) && "sentry"].filter(Boolean).join(", "),
      metrics: `http://localhost:${config.port}/api/metrics`,
    });
  }),
);

/**
 * Telemetry: logs, metrics and traces go to an OTLP collector when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set (Grafana, Jaeger, Honeycomb, ...);
 * metrics are always scraped from `/api/metrics` in Prometheus format.
 */
const telemetryLayer = Layer.unwrap(
  Effect.map(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(Config.option), (endpoint) =>
    Option.isSome(endpoint)
      ? Otlp.layer({ baseUrl: endpoint.value, resource: { serviceName: "mergeatron" }, loggerMergeWithExisting: true }).pipe(
          Layer.provide([FetchHttpClient.layer, OtlpSerialization.layerJson]),
        )
      : Layer.empty,
  ),
).pipe(Layer.provideMerge(Metric.enableRuntimeMetricsLayer));

const platformLayer = Layer.mergeAll(FetchHttpClient.layer, BunSocket.layerWebSocketConstructor, BunChildProcessSpawner.layer.pipe(Layer.provide(BunServices.layer)));
const databaseLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    if (Option.isSome(config.legacyDataPath)) yield* copyLegacyDatabase(config.legacyDataPath.value, config.dataPath);
    return Database.layer(config.dataPath);
  }),
);
const servicesLayer = Layer.mergeAll(
  Store.layer.pipe(Layer.provide(databaseLayer)),
  T3.layer,
  SlackClient.layer,
  PullRequests.layer,
  Background.layer,
  RunEvents.layer,
  Updater.layer,
  Usage.layer,
).pipe(Layer.provideMerge(Layer.mergeAll(AppConfig.layer, platformLayer)));
const appLayer = Layer.mergeAll(Poller.layer, slackSocketLayer).pipe(Layer.provideMerge(Sentry.layer), Layer.provideMerge(servicesLayer));

const mainLayer = Layer.mergeAll(httpLayer, mcpLayer, supervisorLayer, startupLayer, telemetryLayer).pipe(Layer.provide(appLayer), Layer.provide(loggerLayer));

BunRuntime.runMain(Layer.launch(mainLayer).pipe(Effect.provide(loggerLayer)));
