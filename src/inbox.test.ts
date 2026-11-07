import { describe, expect, test } from "bun:test";
import { automationsFor, itemContext, itemDeliveryId, rulesLeftBy, type ItemRuns, type PolledItem } from "./inbox.ts";
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
  parent: null,
  children: [],
  tags: [],
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
  test("any: searches every field and names the one that hit", () => {
    const ctx = itemContext({ ...linear, title: "Fix the I9Form upload", body: "Blocks W4 too" });
    expect(filterMismatch("any:i9form and any:w4", ctx)).toBeNull();
    expect(filterMismatch("!any:i9", ctx)).toBe("issue_title has i9 does not match !any:i9");
    expect(filterMismatch("any:w9", ctx)).toBe("no field has w9 does not match any:w9");
  });

  test("terms test labels and the item's fields, case-insensitively; empty matches anything", () => {
    const ctx = itemContext(linear);
    expect(filterMismatch("", ctx)).toBeNull();
    expect(filterMismatch("reason:assigned and Ready For Dev and state:todo and team:eng", ctx)).toBeNull();
    expect(filterMismatch("state:unstarted and !bug", ctx)).toBeNull();
    expect(filterMismatch("reason:review_requested", ctx)).toBe("reasons assigned does not match reason:review_requested");
    expect(filterMismatch("bug", ctx)).toBe("labels ready for dev does not match bug");
    expect(filterMismatch('team:ENG and state:"In Progress"', ctx)).toBe("state Todo does not match state:In Progress");
    expect(filterMismatch("team:OPS or team:SRE", ctx)).toBe("does not match team:OPS or team:SRE");
    expect(filterMismatch("bug (", ctx)).toStartWith("filter is invalid");
  });

  test("a done Linear issue matches only filters that name its state or type", () => {
    const ctx = itemContext({ ...linear, labels: ["bug"], state: "Done", stateType: "completed" });
    expect(filterMismatch("", ctx)).toBe("state Done is done; name it in a state: term to run on done issues");
    expect(filterMismatch("state:Todo or bug", ctx)).toBe("state Done is done; name it in a state: term to run on done issues");
    expect(filterMismatch("state:Todo or state:done", ctx)).toBeNull();
    expect(filterMismatch("state:done", ctx)).toBeNull();
    expect(filterMismatch("state:completed", ctx)).toBeNull();
  });

  test("tag: tests a Sentry tag with its value, also one holding a comma", () => {
    const ctx = itemContext({ ...linear, tags: ["service:checkout", "route:a,b"] });
    expect(ctx.tags).toBe("service:checkout\nroute:a,b");
    expect(filterMismatch("tag:service:Checkout", ctx)).toBeNull();
    expect(filterMismatch('tag:"route:a,b"', ctx)).toBeNull();
    expect(filterMismatch("tag:service:billing", ctx)).toBe("tags service:checkout, route:a,b does not match tag:service:billing");
    expect(filterMismatch("!tag:service:checkout", ctx)).toBe("tags service:checkout, route:a,b does not match !tag:service:checkout");
    expect(filterMismatch("tag:service:checkout", itemContext(linear))).toBe("tags (none) does not match tag:service:checkout");
  });

  test("has:parent and has:sub-issues test whether an issue is a sub-issue and whether it has sub-issues", () => {
    const parent = itemContext({ ...linear, children: ["ENG-8", "ENG-9"] });
    const child = itemContext({ ...linear, parent: "ENG-6" });
    const lone = itemContext(linear);
    expect(child.issue_parent).toBe("ENG-6");
    expect(parent.issue_children).toBe("ENG-8, ENG-9");
    expect(filterMismatch("has:parent", child)).toBeNull();
    expect(filterMismatch("has:parent", lone)).toBe("no parent issue does not match has:parent");
    expect(filterMismatch("!has:parent", child)).toBe("parent ENG-6 does not match !has:parent");
    expect(filterMismatch("has:sub-issues", parent)).toBeNull();
    expect(filterMismatch("!has:sub-issues", parent)).toBe("sub-issues ENG-8, ENG-9 does not match !has:sub-issues");
    expect(filterMismatch("!has:parent and !has:sub-issues", lone)).toBeNull();
  });
});

describe("itemDeliveryId", () => {
  test("PRs re-run per head when the rule asks; issues and push-indifferent rules key on the item alone", () => {
    expect(itemDeliveryId(pr, rule)).toBe("github:acme/widgets#42@abc123def456");
    expect(itemDeliveryId(pr, { filters: { ...EMPTY_FILTERS, rerunOnPush: false } })).toBe("github:acme/widgets#42");
    expect(itemDeliveryId(linear, rule)).toBe("linear:ENG-7");
  });

  test("an issue's later generations get their own delivery id; a PR's never do", () => {
    expect(itemDeliveryId(linear, rule, 0)).toBe("linear:ENG-7");
    expect(itemDeliveryId(linear, rule, 2)).toBe("linear:ENG-7#2");
    expect(itemDeliveryId(pr, rule, 2)).toBe("github:acme/widgets#42@abc123def456");
  });
});

/** A run log where nothing ran and every item is at generation 0, or where `ran` lists the deliveries that did. */
const runLog = (ran: string[] = [], generation = 0): ItemRuns => ({ generation: () => generation, hasRun: (deliveryId) => ran.includes(deliveryId) });

describe("automationsFor", () => {
  test("fires matching rules once per delivery id", () => {
    expect(automationsFor(pr, [rule], runLog())).toEqual([{ rule, deliveryId: "github:acme/widgets#42@abc123def456" }]);
    expect(automationsFor(pr, [rule], runLog(["github:acme/widgets#42@abc123def456"]))).toEqual([]);
    expect(automationsFor(linear, [rule], runLog())).toEqual([]);
  });

  test("an issue fires again in a new generation", () => {
    const issues = { ...rule, events: ["inbox.linear.issue"] };
    expect(automationsFor(linear, [issues], runLog(["linear:ENG-7"]))).toEqual([]);
    expect(automationsFor(linear, [issues], runLog(["linear:ENG-7"], 1))).toEqual([{ rule: issues, deliveryId: "linear:ENG-7#1" }]);
  });

  test("a rule is armed only for activity after its last save, unless backfilling", () => {
    const edited = { ...rule, updatedAt: "2026-01-02T12:00:00Z" };
    expect(automationsFor(pr, [edited], runLog())).toEqual([]);
    expect(automationsFor(pr, [edited], runLog(), { armed: false })).toHaveLength(1);
  });

  test("filters apply", () => {
    const labelled: Rule = { ...rule, filters: { ...EMPTY_FILTERS, query: "backend and reason:review_requested" } };
    expect(automationsFor(pr, [labelled], runLog())).toHaveLength(1);
    expect(automationsFor(pr, [{ ...labelled, filters: { ...labelled.filters, query: "frontend" } }], runLog())).toEqual([]);
  });
});

describe("rulesLeftBy", () => {
  const implement: Rule = { ...rule, events: ["inbox.linear.issue"], filters: { ...EMPTY_FILTERS, query: "needs grooming" } };

  test("an issue leaves an enabled rule of its event that ran for its current generation and no longer matches", () => {
    expect(rulesLeftBy(linear, [implement], runLog(["linear:ENG-7"]))).toEqual([implement]);
    expect(rulesLeftBy(linear, [implement], runLog(["linear:ENG-7#1"], 1))).toEqual([implement]);
    // Already bumped: the new generation has no run, so the next poll does not bump again.
    expect(rulesLeftBy(linear, [implement], runLog(["linear:ENG-7"], 1))).toEqual([]);
    // Still matching, never ran, disabled, or listening to another event: nothing to re-arm.
    expect(rulesLeftBy(linear, [{ ...implement, filters: EMPTY_FILTERS }], runLog(["linear:ENG-7"]))).toEqual([]);
    expect(rulesLeftBy(linear, [implement], runLog())).toEqual([]);
    expect(rulesLeftBy(linear, [{ ...implement, enabled: false }], runLog(["linear:ENG-7"]))).toEqual([]);
    expect(rulesLeftBy(linear, [{ ...implement, events: ["inbox.github.issue"] }], runLog(["linear:ENG-7"]))).toEqual([]);
  });

  test("PRs never leave a rule: they re-run per head instead", () => {
    const labelled: Rule = { ...rule, filters: { ...EMPTY_FILTERS, query: "frontend" } };
    expect(rulesLeftBy(pr, [labelled], runLog(["github:acme/widgets#42@abc123def456"]))).toEqual([]);
  });
});
