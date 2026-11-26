import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createRule, updateRule } from "./ruleAdmin.ts";
import { createVersion, promoteVersion } from "./promptVersions.ts";
import { Store } from "./store.ts";
import { failureOf, runWith, testLayer } from "./testing.ts";

describe("updateRule", () => {
  test("changes only the fields given, filters included", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const rule = yield* createRule({ name: "triage", events: ["inbox.linear.issue"], prompt: "fix {{issue_url}}", filters: { query: "team:ENG and bug", rerunOnPush: false } });
        const updated = yield* updateRule(rule.id, { enabled: false, filters: { query: "team:ENG and bug and !wontfix" } });
        expect(updated).toMatchObject({ name: "triage", enabled: false, events: ["inbox.linear.issue"], filters: { query: "team:ENG and bug and !wontfix", rerunOnPush: false } });
      }),
    ));

  test("rejects what the UI would, and unknown ids", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const rule = yield* createRule({ name: "triage", events: ["inbox.linear.issue"], prompt: "x" });
        expect((yield* failureOf(updateRule(rule.id, { filters: { query: "(bug and" } })))._tag).toBe("SchemaError");
        expect((yield* failureOf(updateRule(rule.id, { events: ["inbox.linear.issue", "inbox.sentry.issue"] })))._tag).toBe("SchemaError");
        expect((yield* failureOf(updateRule("nope", { enabled: true })))._tag).toBe("RuleNotFoundError");
      }),
    ));

  test("switches to a workflow only once a JSON input is live", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const rule = yield* createRule({ name: "ship", events: ["webhook.deploys"], prompt: "ship {{payload.title}}" });
        expect((yield* failureOf(updateRule(rule.id, { workflow: "ship" })))._tag).toBe("WorkflowInputError");
        yield* store.createPromptVersion("rule", rule.id, { body: '{ "task": "{{payload.title}}" }', note: null, source: "ui" }, true);
        expect(yield* updateRule(rule.id, { workflow: "ship" })).toMatchObject({ workflow: "ship" });
        // Version 1, the prose, cannot go live again while the rule starts a workflow.
        expect((yield* failureOf(promoteVersion("rule", rule.id, 1)))._tag).toBe("WorkflowInputError");
        expect((yield* failureOf(createVersion("rule", rule.id, { body: "prose", note: null, promote: true }, "ui")))._tag).toBe("WorkflowInputError");
        expect((yield* store.getRule(rule.id))?.livePromptVersion).toBe(2);
      }),
    ));
});
