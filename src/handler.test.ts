import { describe, expect, test } from "bun:test";
import { hostsRepository, matchRules, resolveProject } from "./handler.ts";
import type { Rule } from "./rules.ts";
import type { T3Project } from "./t3.ts";

const base: Rule = {
  id: "r1",
  name: "review",
  enabled: true,
  event: "pull_request.review_requested",
  repos: [],
  reviewer: null,
  projectId: null,
  workspace: "worktree",
  model: null,
  prompt: "x",
  createdAt: "",
  updatedAt: "",
};

const ctx = { repo: "Acme/Widgets", requested_reviewer: "bernardo" };

describe("matchRules", () => {
  test("matches on event key and respects enabled", () => {
    expect(matchRules([base], "pull_request.review_requested", ctx)).toHaveLength(1);
    expect(matchRules([base], "pull_request.opened", ctx)).toHaveLength(0);
    expect(matchRules([{ ...base, enabled: false }], "pull_request.review_requested", ctx)).toHaveLength(0);
  });

  test("repository filter is case-insensitive and empty means any", () => {
    expect(matchRules([{ ...base, repos: ["acme/widgets"] }], base.event, ctx)).toHaveLength(1);
    expect(matchRules([{ ...base, repos: ["acme/other"] }], base.event, ctx)).toHaveLength(0);
  });

  test("reviewer filter compares against the requested reviewer", () => {
    expect(matchRules([{ ...base, reviewer: "Bernardo" }], base.event, ctx)).toHaveLength(1);
    expect(matchRules([{ ...base, reviewer: "someone" }], base.event, ctx)).toHaveLength(0);
    expect(matchRules([{ ...base, reviewer: "bernardo" }], base.event, { repo: "acme/widgets" })).toHaveLength(0);
  });
});

describe("resolveProject", () => {
  const projects: T3Project[] = [
    { id: "p1", title: "widgets", workspaceRoot: "/w", deletedAt: null, defaultModelSelection: null, repositoryIdentity: { canonicalKey: "github.com/acme/widgets", provider: "github", owner: "acme", name: "widgets" } },
    { id: "p2", title: "no-remote", workspaceRoot: "/n", deletedAt: null, defaultModelSelection: null, repositoryIdentity: null },
  ];

  test("prefers the explicit project id", () => {
    expect(resolveProject({ ...base, projectId: "p2" }, projects, "acme/widgets")?.id).toBe("p2");
    expect(resolveProject({ ...base, projectId: "gone" }, projects, "acme/widgets")).toBeNull();
  });

  test("falls back to the project whose remote matches the repository", () => {
    expect(resolveProject(base, projects, "ACME/widgets")?.id).toBe("p1");
    expect(resolveProject(base, projects, "acme/other")).toBeNull();
  });

  test("hostsRepository requires a GitHub identity with matching owner/name", () => {
    expect(hostsRepository(projects[0]!, "acme/widgets")).toBe(true);
    expect(hostsRepository(projects[1]!, "acme/widgets")).toBe(false);
    expect(hostsRepository({ ...projects[0]!, repositoryIdentity: { canonicalKey: "x", owner: "acme", name: "widgets" } }, "acme/widgets")).toBe(false);
  });
});
