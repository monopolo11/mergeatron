import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createRule, updateRule } from "./ruleAdmin.ts";
import { failureOf, runWith, testLayer } from "./testing.ts";

describe("updateRule", () => {
  test("changes only the fields given, filters included", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const rule = yield* createRule({ name: "triage", events: ["inbox.linear.issue"], prompt: "fix {{issue_url}}", filters: { teams: ["ENG"], labels: "bug" } });
        const updated = yield* updateRule(rule.id, { enabled: false, filters: { labels: "bug and !wontfix" } });
        expect(updated).toMatchObject({ name: "triage", enabled: false, events: ["inbox.linear.issue"], filters: { teams: ["ENG"], labels: "bug and !wontfix" } });
      }),
    ));

  test("rejects what the UI would, and unknown ids", () =>
    runWith(
      testLayer(),
      Effect.gen(function* () {
        const rule = yield* createRule({ name: "triage", events: ["inbox.linear.issue"], prompt: "x" });
        expect((yield* failureOf(updateRule(rule.id, { filters: { labels: "(bug and" } })))._tag).toBe("SchemaError");
        expect((yield* failureOf(updateRule(rule.id, { events: ["inbox.linear.issue", "inbox.sentry.issue"] })))._tag).toBe("SchemaError");
        expect((yield* failureOf(updateRule("nope", { enabled: true })))._tag).toBe("RuleNotFoundError");
      }),
    ));
});
