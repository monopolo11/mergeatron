import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { WebhookInput, type Rule } from "./rules.ts";
import { EMPTY_FILTERS } from "./shared.ts";
import { Store } from "./store.ts";
import type { StartThreadInput, T3Project } from "./t3.ts";
import { renderTemplate, schemaVariables } from "./template.ts";
import { failureOf, fakeT3, runWith, settle, testLayer } from "./testing.ts";
import { generateSecret, receiveWebhook, verifySecret } from "./webhooks.ts";

const schema = {
  type: "object",
  required: ["service"],
  properties: { service: { type: "string" }, deploy: { type: "object", properties: { sha: { type: "string" } } }, tags: { type: "array" } },
};

const rule: Omit<Rule, "id" | "livePromptVersion" | "createdAt" | "updatedAt"> = {
  name: "deploys",
  enabled: true,
  events: ["webhook.deploys"],
  repos: [],
  reviewer: null,
  channel: null,
  allowBots: true,
  skipSelfReview: true,
  filters: EMPTY_FILTERS,
  maxConcurrent: 0,
  projectId: "p1",
  workspace: "local",
  model: null,
  prompt: "Check {{payload.service}} at {{payload.deploy.sha}}{{payload.missing}}",
  presetId: null,
};

describe("custom webhooks", () => {
  const project: T3Project = { id: "p1", title: "widgets", workspaceRoot: "/w", deletedAt: null, defaultModelSelection: null };

  test("a request with the secret and a matching body starts the rules on webhook.<slug>", async () => {
    const started: StartThreadInput[] = [];
    const t3 = fakeT3({
      projects: () => Effect.succeed([project]),
      startThread: (input) => Effect.sync(() => (started.push(input), { threadId: "t", threadUrl: "http://t3/t" })),
    });
    await runWith(
      testLayer({ t3 }),
      Effect.gen(function* () {
        const store = yield* Store;
        const webhook = (yield* store.createWebhook({ name: "Deploys", slug: "deploys", payloadSchema: schema, secret: generateSecret() }))!;
        yield* store.createRule(rule);
        const body = JSON.stringify({ service: "api", deploy: { sha: "abc123" } });

        const result = yield* receiveWebhook({ slug: "deploys", secret: webhook.secret, body });
        yield* settle;
        expect(result.matched).toEqual(["deploys"]);
        expect(started[0]).toMatchObject({ title: "deploys: Deploys", prompt: "Check api at abc123" });
        expect((yield* store.listRuns())[0]).toMatchObject({ source: "webhook", event: "webhook.deploys", status: "started" });
      }),
    );
  });

  test("unknown slugs, wrong secrets and bodies off the schema are refused before any rule runs", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const webhook = (yield* store.createWebhook({ name: "Deploys", slug: "deploys", payloadSchema: schema, secret: generateSecret() }))!;
        yield* store.createRule(rule);
        const ok = JSON.stringify({ service: "api" });

        expect((yield* failureOf(receiveWebhook({ slug: "other", secret: webhook.secret, body: ok })))._tag).toBe("WebhookNotFoundError");
        expect((yield* failureOf(receiveWebhook({ slug: "deploys", secret: undefined, body: ok })))._tag).toBe("WebhookSecretError");
        expect((yield* failureOf(receiveWebhook({ slug: "deploys", secret: generateSecret(), body: ok })))._tag).toBe("WebhookSecretError");
        expect((yield* failureOf(receiveWebhook({ slug: "deploys", secret: webhook.secret, body: "not json" })))._tag).toBe("InvalidPayloadError");
        const invalid = yield* failureOf(receiveWebhook({ slug: "deploys", secret: webhook.secret, body: JSON.stringify({ service: 1 }) }));
        expect(invalid).toMatchObject({ _tag: "InvalidPayloadError", message: "/service must be string" });
        expect(yield* store.listRuns()).toHaveLength(0);
      }),
    ));

  test("a header of the secret's length but other bytes is refused, not a crash", () => {
    const secret = generateSecret();
    expect(verifySecret(secret, secret)).toBe(true);
    expect(verifySecret(secret, "é".repeat(secret.length))).toBe(false);
  });

  test("slugs are unique", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        expect(yield* store.createWebhook({ name: "A", slug: "deploys", payloadSchema: null, secret: generateSecret() })).not.toBeNull();
        expect(yield* store.createWebhook({ name: "B", slug: "deploys", payloadSchema: null, secret: generateSecret() })).toBeNull();
      }),
    ));

  test("the input refuses bad slugs and schemas that do not compile", () => {
    const decode = Schema.decodeUnknownSync(WebhookInput);
    expect(decode({ name: "Deploys", slug: "deploys", payloadSchema: schema })).toMatchObject({ slug: "deploys" });
    expect(() => decode({ name: "Deploys", slug: "Deploys/prod" })).toThrow();
    expect(() => decode({ name: "Deploys", slug: "deploys", payloadSchema: { type: "nope" } })).toThrow("Not a valid JSON schema");
  });
});

describe("payload variables", () => {
  test("a dotted name reads its path out of the JSON variable; objects render as JSON", () => {
    const vars = { payload: JSON.stringify({ user: { login: "octo", id: 7 }, tags: ["a"] }) };
    expect(renderTemplate("{{payload.user.login}} {{ payload.user.id }} {{payload.tags.0}} {{payload.nope.deeper}}", vars)).toBe("octo 7 a ");
    expect(renderTemplate("{{payload.user}}", vars)).toBe(JSON.stringify({ login: "octo", id: 7 }, null, 2));
    expect(renderTemplate("{{payload.constructor}}", vars)).toBe("");
  });

  test("a schema lists every property path, nested objects included", () => {
    expect(schemaVariables(schema)).toEqual(["payload.service", "payload.deploy", "payload.deploy.sha", "payload.tags"]);
    expect(schemaVariables(null)).toEqual([]);
  });
});
