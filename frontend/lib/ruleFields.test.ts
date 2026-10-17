import { describe, expect, test } from "bun:test";
import { EMPTY_FILTERS } from "../../src/shared.ts";
import type { RuleDraft } from "./shell";
import { applicable } from "./ruleFields";

const draft = (events: string[]): RuleDraft => ({
  name: "rule",
  events,
  repos: ["acme/widgets"],
  reviewer: " octocat ",
  channel: "C123",
  allowBots: true,
  skipSelfReview: true,
  filters: { ...EMPTY_FILTERS, reasons: ["assigned"], labels: "bug", states: ["Triage"], teams: ["ONB"] },
  maxConcurrent: 3,
  projectId: null,
  workspace: "worktree",
  model: null,
  prompt: "",
  presetId: null,
});

describe("applicable", () => {
  test("a Linear inbox rule drops the repository, reviewer and channel it cannot show", () => {
    const rule = applicable(draft(["inbox.linear.issue"]));
    expect(rule.repos).toEqual([]);
    expect(rule.reviewer).toBeNull();
    expect(rule.channel).toBeNull();
    expect(rule.filters).toMatchObject({ reasons: ["assigned"], labels: "bug", states: ["Triage"], teams: ["ONB"] });
  });

  test("a webhook rule keeps repository, trimmed reviewer and labels, and drops inbox filters", () => {
    const rule = applicable(draft(["pull_request.review_requested"]));
    expect(rule.repos).toEqual(["acme/widgets"]);
    expect(rule.reviewer).toBe("octocat");
    expect(rule.channel).toBeNull();
    expect(rule.filters).toMatchObject({ reasons: [], labels: "bug", states: [], teams: [] });
  });

  test("a custom webhook rule is not a GitHub one: repository, reviewer and labels go", () => {
    const rule = applicable(draft(["webhook.deploys"]));
    expect(rule.repos).toEqual([]);
    expect(rule.reviewer).toBeNull();
    expect(rule.filters).toMatchObject({ reasons: [], labels: "", states: [], teams: [] });
  });

  test("mixed events keep every field any of them shows", () => {
    const rule = applicable(draft(["slack.message", "inbox.linear.issue"]));
    expect(rule.repos).toEqual(["acme/widgets"]);
    expect(rule.channel).toBe("C123");
    expect(rule.filters.teams).toEqual(["ONB"]);
  });
});
