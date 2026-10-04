import { describe, expect, test } from "bun:test";
import { automationsFor, itemContext, itemDeliveryId, type PolledItem } from "./inbox.ts";
import { filterMismatch } from "./match.ts";
import type { Rule } from "./rules.ts";
import { EMPTY_FILTERS } from "./shared.ts";

export const pr: PolledItem = {
  key: "github:acme/widgets#42",
  source: "github",
  kind: "pull_request",
  repo: "acme/widgets",
  identifier: "#42",
  title: "Add widgets",
  url: "https://github.com/acme/widgets/pull/42",
  body: "Adds widgets.",
  author: "alice",
  state: "open",
  stateType: null,
  labels: ["ready", "backend"],
  reasons: ["review_requested", "mentioned"],
  team: null,
  priority: null,
  branch: "feat/widgets",
  headSha: "abc123def456789",
  base: "main",
  reviewDecision: "REVIEW_REQUIRED",
  repoUrl: "https://github.com/acme/widgets",
  defaultBranch: "main",
  createdAt: "2026-01-01T10:00:00Z",
  updatedAt: "2026-01-02T10:00:00Z",
};

export const linear: PolledItem = {
  ...pr,
  key: "linear:ENG-7",
  source: "linear",
  kind: "issue",
  repo: null,
  identifier: "ENG-7",
  title: "Rate limit the API",
  url: "https://linear.app/acme/issue/ENG-7",
  state: "Todo",
  stateType: "unstarted",
  labels: ["ready for dev"],
  reasons: ["assigned"],
  team: "ENG",
  priority: "High",
  branch: "alice/eng-7-rate-limit",
  headSha: null,
  base: null,
  reviewDecision: null,
  repoUrl: null,
  defaultBranch: null,
};

export const rule: Rule = {
  id: "r1",
  name: "review",
  enabled: true,
  events: ["inbox.github.pull_request"],
  repos: [],
  reviewer: null,
  channel: null,
  allowBots: true,
  skipSelfReview: true,
  filters: EMPTY_FILTERS,
  maxConcurrent: 0,
  projectId: null,
  workspace: "worktree",
  model: null,
  prompt: "x",
  livePromptVersion: 1,
  presetId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("itemContext", () => {
  test("a PR gets the webhook's pr_* names plus labels, reasons and state", () => {
    expect(itemContext(pr)).toEqual({
      repo: "acme/widgets",
      event: "inbox.github.pull_request",
      state: "open",
      labels: "ready, backend",
      reasons: "review_requested, mentioned",
      repo_url: "https://github.com/acme/widgets",
      default_branch: "main",
      branch: "feat/widgets",
      review_decision: "REVIEW_REQUIRED",
      pr_number: "42",
      pr_title: "Add widgets",
      pr_url: "https://github.com/acme/widgets/pull/42",
      pr_body: "Adds widgets.",
      pr_author: "alice",
      pr_head: "feat/widgets",
      pr_head_sha: "abc123def456789",
      pr_base: "main",
    });
  });

  test("a Linear issue gets issue_* names, its identifier, team, priority and state type", () => {
    expect(itemContext(linear)).toMatchObject({
      repo: "",
      event: "inbox.linear.issue",
      issue_identifier: "ENG-7",
      issue_title: "Rate limit the API",
      issue_url: "https://linear.app/acme/issue/ENG-7",
      state: "Todo",
      state_type: "unstarted",
      team: "ENG",
      priority: "High",
      labels: "ready for dev",
    });
    expect(itemContext(linear).issue_number).toBeUndefined();
  });
});

describe("filterMismatch", () => {
  test("lists match any value, case-insensitively; empty lists match anything", () => {
    const ctx = itemContext(linear);
    expect(filterMismatch(EMPTY_FILTERS, ctx)).toBeNull();
    expect(filterMismatch({ ...EMPTY_FILTERS, reasons: ["assigned"], labels: "Ready For Dev", states: ["todo"], teams: ["eng"] }, ctx)).toBeNull();
    expect(filterMismatch({ ...EMPTY_FILTERS, states: ["unstarted"] }, ctx)).toBeNull();
    expect(filterMismatch({ ...EMPTY_FILTERS, reasons: ["review_requested"] }, ctx)).toBe("reasons assigned include none of review_requested");
    expect(filterMismatch({ ...EMPTY_FILTERS, labels: "bug" }, ctx)).toBe("labels ready for dev do not match bug");
    expect(filterMismatch({ ...EMPTY_FILTERS, labels: "!bug" }, ctx)).toBeNull();
    expect(filterMismatch({ ...EMPTY_FILTERS, labels: "bug (" }, ctx)).toStartWith("label filter is invalid");
    expect(filterMismatch({ ...EMPTY_FILTERS, states: ["In Progress"] }, ctx)).toBe("state Todo is not In Progress");
    expect(filterMismatch({ ...EMPTY_FILTERS, teams: ["OPS"] }, ctx)).toBe("team ENG is not OPS");
  });
});

describe("itemDeliveryId", () => {
  test("PRs re-run per head when the rule asks; issues and push-indifferent rules key on the item alone", () => {
    expect(itemDeliveryId(pr, rule)).toBe("github:acme/widgets#42@abc123def456");
    expect(itemDeliveryId(pr, { filters: { ...EMPTY_FILTERS, rerunOnPush: false } })).toBe("github:acme/widgets#42");
    expect(itemDeliveryId(linear, rule)).toBe("linear:ENG-7");
  });
});

describe("automationsFor", () => {
  const never = () => false;

  test("fires matching rules once per delivery id", () => {
    expect(automationsFor(pr, [rule], never)).toEqual([{ rule, deliveryId: "github:acme/widgets#42@abc123def456" }]);
    expect(automationsFor(pr, [rule], () => true)).toEqual([]);
    expect(automationsFor(linear, [rule], never)).toEqual([]);
  });

  test("a rule is armed only for activity after its last save, unless backfilling", () => {
    const edited = { ...rule, updatedAt: "2026-01-02T12:00:00Z" };
    expect(automationsFor(pr, [edited], never)).toEqual([]);
    expect(automationsFor(pr, [edited], never, { armed: false })).toHaveLength(1);
  });

  test("filters apply", () => {
    const labelled: Rule = { ...rule, filters: { ...EMPTY_FILTERS, labels: "backend", reasons: ["review_requested"] } };
    expect(automationsFor(pr, [labelled], never)).toHaveLength(1);
    expect(automationsFor(pr, [{ ...labelled, filters: { ...labelled.filters, labels: "frontend" } }], never)).toEqual([]);
  });
});
