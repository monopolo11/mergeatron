import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { GITHUB_SEARCHES, makeGitHubInbox, mergeItems, parseSearchNodes, type SearchResult } from "./githubInbox.ts";
import { InboxSourceError } from "./inboxSource.ts";
import { failureOf } from "./testing.ts";

const repository = { nameWithOwner: "acme/widgets", url: "https://github.com/acme/widgets", defaultBranchRef: { name: "main" } };
const prNode = {
  __typename: "PullRequest",
  number: 42,
  title: "Add widgets",
  url: "https://github.com/acme/widgets/pull/42",
  body: null,
  isDraft: true,
  state: "OPEN",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-02T10:00:00Z",
  reviewDecision: "REVIEW_REQUIRED",
  headRefName: "feat/widgets",
  headRefOid: "abc",
  baseRefName: "main",
  author: { login: "alice" },
  repository,
  labels: { nodes: [{ name: "ready" }] },
};
const issueNode = {
  __typename: "Issue",
  number: 7,
  title: "Crash on start",
  url: "https://github.com/acme/widgets/issues/7",
  body: "Steps…",
  state: "OPEN",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T11:00:00Z",
  author: null,
  repository,
  labels: { nodes: [] },
};

const failed = (message: string) => Effect.fail(new InboxSourceError({ source: "github", message }));

describe("parseSearchNodes", () => {
  test("maps PRs and issues, marks drafts, skips unknown nodes", () => {
    const [pr, issue] = parseSearchNodes([prNode, issueNode, {}], "assigned");
    expect(pr).toMatchObject({ key: "github:acme/widgets#42", kind: "pull_request", identifier: "#42", state: "draft", branch: "feat/widgets", headSha: "abc", base: "main", reviewDecision: "REVIEW_REQUIRED", labels: ["ready"], reasons: ["assigned"], author: "alice", defaultBranch: "main" });
    expect(issue).toMatchObject({ key: "github:acme/widgets#7", kind: "issue", state: "open", author: null, branch: null, headSha: null, reasons: ["assigned"] });
    expect(parseSearchNodes([prNode, issueNode, {}], "assigned")).toHaveLength(2);
  });
});

describe("mergeItems", () => {
  test("unions reasons per key, keeping the first copy's fields", () => {
    const a = parseSearchNodes([prNode], "review_requested");
    const b = parseSearchNodes([prNode, issueNode], "mentioned");
    const merged = mergeItems([a, b]);
    expect(merged.map((item) => [item.key, item.reasons])).toEqual([
      ["github:acme/widgets#42", ["review_requested", "mentioned"]],
      ["github:acme/widgets#7", ["mentioned"]],
    ]);
  });
});

describe("GitHubInbox.fetch", () => {
  test("runs one search per reason and merges", async () => {
    const asked: string[] = [];
    const inbox = makeGitHubInbox({
      search: (_query, q) =>
        Effect.sync((): SearchResult => {
          asked.push(q);
          return { data: { viewer: { login: "me" }, search: { nodes: q.includes("review-requested") ? [prNode] : q.includes("assignee") ? [issueNode, prNode] : [] } } };
        }),
      repoLabels: () => Effect.succeed([]),
    });
    const { login, items } = await Effect.runPromise(inbox.fetch());
    expect(login).toBe("me");
    expect(asked.toSorted()).toEqual(GITHUB_SEARCHES.map((search) => search.q).toSorted());
    expect(items.map((item) => [item.identifier, item.reasons])).toEqual([
      ["#42", ["review_requested", "assigned"]],
      ["#7", ["assigned"]],
    ]);
  });

  test("surfaces GraphQL errors", async () => {
    const inbox = makeGitHubInbox({ search: () => Effect.succeed({ errors: [{ message: "bad credentials" }] }), repoLabels: () => Effect.succeed([]) });
    const error = await Effect.runPromise(failureOf(inbox.fetch()));
    expect(error.message).toContain("bad credentials");
  });
});

describe("GitHubInbox.labels", () => {
  test("lists each repo's labels and leaves out repos that fail", async () => {
    const inbox = makeGitHubInbox({
      search: () => failed("unused"),
      repoLabels: (repo) => (repo === "acme/gone" ? failed("HTTP 404") : Effect.succeed(["bug", "ready"])),
    });
    expect(await Effect.runPromise(inbox.labels(["acme/widgets", "acme/gone"]))).toEqual([
      { name: "bug", scope: "acme/widgets" },
      { name: "ready", scope: "acme/widgets" },
    ]);
  });
});
