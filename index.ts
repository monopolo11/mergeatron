import { homedir } from "node:os";
import { join } from "node:path";
import index from "./frontend/index.html";
import { resumeWatchers, watchCompletion } from "./src/completion.ts";
import { eventKey, extractContext, verifySignature } from "./src/github.ts";
import { handleDelivery, type HandlerDeps } from "./src/handler.ts";
import { handoffIfStuck } from "./src/handoff.ts";
import { logger } from "./src/log.ts";
import { openDatabase } from "./src/db/index.ts";
import { RuleInput, SettingsInput, TestThreadInput } from "./src/rules.ts";
import { handleSlackEvent } from "./src/secondPass.ts";
import { SlackClient, SlackSocket } from "./src/slack.ts";
import { Store } from "./src/store.ts";
import { T3Client } from "./src/t3.ts";
import { applyUpdate, checkForUpdate, restart } from "./src/update.ts";

const t3Home = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
const log = logger("server");
const webhookLog = logger("webhook");

/** Falls back to the origin the running desktop/server wrote to server-runtime.json. */
async function resolveT3Origin(): Promise<string> {
  if (process.env.T3_ORIGIN) return process.env.T3_ORIGIN;
  const runtime = Bun.file(join(t3Home, "userdata", "server-runtime.json"));
  if (await runtime.exists()) {
    const state = (await runtime.json()) as { origin?: string };
    if (state.origin) return state.origin;
  }
  return "http://127.0.0.1:3773";
}

const token = process.env.T3_TOKEN;
if (!token) {
  log.error("T3_TOKEN is required. Issue one with: npx t3 auth session issue --token-only --ttl 365d");
  process.exit(1);
}
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
if (!webhookSecret) {
  log.warn("GITHUB_WEBHOOK_SECRET is not set: webhook signatures will not be verified.");
}

const slackAppToken = process.env.SLACK_APP_TOKEN;
const slackBotToken = process.env.SLACK_BOT_TOKEN;
if ((slackAppToken || slackBotToken) && !(slackAppToken && slackBotToken)) {
  log.warn("Slack needs both SLACK_APP_TOKEN and SLACK_BOT_TOKEN; the Slack trigger is disabled.");
}

const t3 = new T3Client(await resolveT3Origin(), token);
const store = new Store(openDatabase(process.env.DATA_PATH ?? "data/orchestrator.sqlite"));
const deps: HandlerDeps = {
  store,
  t3,
  slack: slackAppToken && slackBotToken ? new SlackClient(slackBotToken) : null,
  afterReview: (run) => handoffIfStuck(deps, run),
};
resumeWatchers(deps);

/**
 * Slack events arrive over Socket Mode, not a webhook: each `event_callback`
 * is treated like a delivery keyed `slack.<type>`; a "second pass" mention in
 * a review thread re-reviews that PR in a new T3 thread. Slack redelivers
 * unacked envelopes; `event_id` dedupes those.
 */
const slackSocket = slackAppToken && deps.slack ? new SlackSocket(slackAppToken, (payload) => handleSlackEvent(deps, payload)) : null;
slackSocket?.start();

const json = (body: unknown, status = 200) => Response.json(body, { status });
const badRequest = (error: unknown) =>
  json({ error: error instanceof Error ? error.message : String(error) }, 400);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8787),
  development: process.env.NODE_ENV !== "production",
  routes: {
    // Client-side routes; the router in frontend/app.tsx picks the view.
    "/": index,
    "/reviews": index,
    "/analytics": index,

    "/api/status": async () => {
      const environment = await t3.environment().catch(() => null);
      return json({
        t3: { origin: t3.origin, environment },
        webhookSecretConfigured: Boolean(webhookSecret),
        slack: slackSocket ? (slackSocket.connected ? "connected" : "connecting") : "off",
      });
    },

    "/api/t3/projects": async () => {
      try {
        return json(await t3.projects());
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 502);
      }
    },

    "/api/t3/providers": async () => {
      try {
        return json(await t3.providers());
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 502);
      }
    },

    /** Starts a tiny thread in a project to prove the token, RPC and provider work end to end. */
    "/api/t3/test-thread": {
      POST: async (req) => {
        const parsed = TestThreadInput.safeParse(await req.json());
        if (!parsed.success) return badRequest(parsed.error);
        const project = (await t3.projects()).find((p) => p.id === parsed.data.projectId);
        if (!project) return json({ error: "project not found in T3" }, 404);
        const settings = store.getSettings();
        const run = store.recordRun({
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
        });
        try {
          const thread = await t3.startThread({
            project,
            title: "Orchestrator connection test",
            prompt:
              "Connection test from the GitHub webhook orchestrator. Reply with the single word ok and do nothing else.",
            modelSelection: project.defaultModelSelection ?? settings.model,
            runtimeMode: settings.runtimeMode,
            baseBranch: null,
            worktree: false,
            pullRequest: null,
          });
          store.updateRun(run.id, { status: "started", detail: `checkout ${project.workspaceRoot}`, ...thread });
          watchCompletion(deps, { ...run, threadId: thread.threadId });
          return json(thread, 201);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          store.updateRun(run.id, { status: "failed", detail, threadId: null, threadUrl: null });
          return json({ error: detail }, 502);
        }
      },
    },

    /** Compares the running code with upstream; POST fast-forwards, installs and restarts. */
    "/api/update": {
      GET: async () => {
        try {
          return json(await checkForUpdate());
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 502);
        }
      },
      POST: async (req, server) => {
        // Fetching over SSH plus bun install outlasts the 10s default idle timeout.
        server.timeout(req, 120);
        try {
          const result = await applyUpdate();
          log.info("update applied, restarting", { from: result.from, to: result.to, restart: result.restart });
          // Let the response leave before the process goes away.
          setTimeout(() => restart(result.restart), 500);
          return json(result);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 409);
        }
      },
    },

    "/api/settings": {
      GET: () => json(store.getSettings()),
      PUT: async (req) => {
        const parsed = SettingsInput.safeParse(await req.json());
        if (!parsed.success) return badRequest(parsed.error);
        store.saveSettings(parsed.data);
        return json(parsed.data);
      },
    },

    "/api/rules": {
      GET: () => json(store.listRules()),
      POST: async (req) => {
        const parsed = RuleInput.safeParse(await req.json());
        if (!parsed.success) return badRequest(parsed.error);
        return json(store.createRule(parsed.data), 201);
      },
    },

    "/api/rules/:id": {
      PUT: async (req) => {
        const parsed = RuleInput.safeParse(await req.json());
        if (!parsed.success) return badRequest(parsed.error);
        const rule = store.updateRule(req.params.id, parsed.data);
        return rule ? json(rule) : json({ error: "not found" }, 404);
      },
      DELETE: (req) =>
        store.deleteRule(req.params.id) ? new Response(null, { status: 204 }) : json({ error: "not found" }, 404),
    },

    "/api/runs": () => json(store.listRuns()),

    "/api/analytics": () => json(store.analytics()),

    "/api/pulls": () => json(store.pullRequests()),

    "/webhooks/github": {
      POST: async (req) => {
        const rawBody = await req.text();
        const deliveryId = req.headers.get("x-github-delivery") ?? crypto.randomUUID();
        const eventName = req.headers.get("x-github-event");
        if (webhookSecret && !verifySignature(webhookSecret, rawBody, req.headers.get("x-hub-signature-256"))) {
          webhookLog.warn("rejected: invalid signature", { delivery: deliveryId, github: eventName ?? undefined });
          return json({ error: "invalid signature" }, 401);
        }
        if (!eventName) {
          webhookLog.warn("rejected: missing X-GitHub-Event header", { delivery: deliveryId });
          return badRequest("missing X-GitHub-Event header");
        }
        if (eventName === "ping") {
          webhookLog.info("ping", { delivery: deliveryId });
          return json({ ok: true });
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          webhookLog.warn("rejected: body is not JSON", { delivery: deliveryId, github: eventName });
          return badRequest("body is not JSON");
        }
        const event = eventKey(eventName, payload);
        const ctx = extractContext(eventName, payload);
        webhookLog.info("event received", {
          delivery: deliveryId,
          event,
          repo: ctx.repo || undefined,
          pr: ctx.pr_number,
          sender: ctx.sender,
          reviewer: ctx.requested_reviewer,
        });
        return json(handleDelivery(deps, { deliveryId, event, ctx }), 202);
      },
    },
  },
});

log.info("GitHub -> T3 Code orchestrator started", {
  url: server.url.href,
  t3: t3.origin,
  webhook: `${server.url.href}webhooks/github`,
  slack: slackSocket ? "starting" : "off",
});
