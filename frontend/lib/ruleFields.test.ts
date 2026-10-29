import { describe, expect, test } from "bun:test";
import { EMPTY_FILTERS } from "../../src/shared.ts";
import type { RuleDraft } from "./shell";
import { applicable } from "./ruleFields";

const draft = (events: string[]): RuleDraft => ({
  name: "rule",
  events,
  reviewer: " octocat ",
  channel: "C123",
  allowBots: true,
  skipSelfReview: true,
  filters: { ...EMPTY_FILTERS, query: " team:ONB and bug " },
  maxConcurrent: 3,
  projectId: null,
  workspace: "worktree",
  model: null,
  prompt: "",
  presetId: null,
});

describe("applicable", () => {
  test("an inbox rule keeps its trimmed filter and drops the reviewer and channel it cannot show", () => {
    const rule = applicable(draft(["inbox.linear.issue"]));
    expect(rule.reviewer).toBeNull();
    expect(rule.channel).toBeNull();
    expect(rule.filters.query).toBe("team:ONB and bug");
  });

  test("a webhook rule keeps the trimmed reviewer and its filter", () => {
    const rule = applicable(draft(["pull_request.review_requested"]));
    expect(rule.reviewer).toBe("octocat");
    expect(rule.channel).toBeNull();
    expect(rule.filters.query).toBe("team:ONB and bug");
  });

  test("a custom webhook rule shows no filter, so it is cleared", () => {
    const rule = applicable(draft(["webhook.deploys"]));
    expect(rule.reviewer).toBeNull();
    expect(rule.filters.query).toBe("");
  });

  test("mixed events keep every field any of them shows", () => {
    const rule = applicable(draft(["slack.message", "inbox.linear.issue"]));
    expect(rule.channel).toBe("C123");
    expect(rule.filters.query).toBe("team:ONB and bug");
  });
});
