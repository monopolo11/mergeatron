import { homedir } from "node:os";
import { join } from "node:path";
import index from "./frontend/index.html";
import { verifySignature } from "./src/github.ts";
import { handleDelivery } from "./src/handler.ts";
import { openDatabase } from "./src/db/index.ts";
import { RuleInput, SettingsInput, TestThreadInput } from "./src/rules.ts";
import { Store } from "./src/store.ts";
import { T3Client } from "./src/t3.ts";

const t3Home = process.env.T3CODE_HOME ?? join(homedir(), ".t3");

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
  console.error("T3_TOKEN is required. Issue one with: npx t3 auth session issue --token-only --ttl 365d");
  process.exit(1);
}
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
if (!webhookSecret) {
  console.warn("GITHUB_WEBHOOK_SECRET is not set: webhook signatures will not be verified.");
}

const t3 = new T3Client(await resolveT3Origin(), token);
const store = new Store(openDatabase(process.env.DATA_PATH ?? "data/orchestrator.sqlite"));
const deps = { store, t3 };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const badRequest = (error: unknown) =>
  json({ error: error instanceof Error ? error.message : String(error) }, 400);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8787),
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": index,

    "/api/status": async () => {
      const environment = await t3.environment().catch(() => null);
      return json({
        t3: { origin: t3.origin, environment },
        webhookSecretConfigured: Boolean(webhookSecret),
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
          return json(thread, 201);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          store.updateRun(run.id, { status: "failed", detail, threadId: null, threadUrl: null });
          return json({ error: detail }, 502);
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

    "/webhooks/github": {
      POST: async (req) => {
        const rawBody = await req.text();
        if (webhookSecret && !verifySignature(webhookSecret, rawBody, req.headers.get("x-hub-signature-256"))) {
          return json({ error: "invalid signature" }, 401);
        }
        const eventName = req.headers.get("x-github-event");
        if (!eventName) return badRequest("missing X-GitHub-Event header");
        if (eventName === "ping") return json({ ok: true });

        let payload: unknown;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return badRequest("body is not JSON");
        }
        const result = handleDelivery(deps, {
          deliveryId: req.headers.get("x-github-delivery") ?? crypto.randomUUID(),
          eventName,
          payload,
        });
        console.log(`[webhook] ${result.event} ${result.repo} -> ${result.matched.length} rule(s)`);
        return json(result, 202);
      },
    },
  },
});

console.log(`GitHub -> T3 Code orchestrator on ${server.url}`);
console.log(`T3 Code at ${t3.origin}; webhook endpoint POST ${server.url}webhooks/github`);
