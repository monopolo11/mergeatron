import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { InboxSourceError } from "./inboxSource.ts";
import { makeLinearInbox, type LinearIssue, type LinearQuery } from "./linearInbox.ts";

const issue = (patch: Partial<LinearIssue>): LinearIssue => ({
  id: "i1",
  identifier: "ENG-7",
  title: "Rate limit the API",
  description: "Add a limiter.",
  url: "https://linear.app/acme/issue/ENG-7",
  priorityLabel: "High",
  branchName: "me/eng-7-rate-limit",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-02T10:00:00Z",
  completedAt: null,
  state: { name: "Todo", type: "unstarted" },
  team: { key: "ENG" },
  labels: { nodes: [{ name: "ready for dev" }] },
  assignee: { id: "me", displayName: "Me" },
  creator: { id: "u2", displayName: "Alice" },
  parent: null,
  children: { nodes: [] },
  ...patch,
});

/** A transport answering from a plain function; a thrown Error becomes the source error. */
const transport = (answer: (query: string, variables?: Record<string, unknown>) => unknown): LinearQuery => (query, variables) =>
  Effect.try({ try: () => answer(query, variables) as never, catch: (error) => new InboxSourceError({ source: "linear", message: String(error) }) });

describe("LinearInbox.fetch", () => {
  test("derives reasons from assignee, creator and mention notifications", async () => {
    const inbox = makeLinearInbox(
      transport((query) => {
        if (query.includes("query Mine")) {
          return {
            viewer: { id: "me", displayName: "Me" },
            issues: {
              nodes: [
                issue({ children: { nodes: [{ identifier: "ENG-12" }] } }),
                issue({ id: "i2", identifier: "ENG-8", assignee: null, creator: { id: "me", displayName: "Me" }, parent: { identifier: "ENG-7" } }),
              ],
            },
          };
        }
        return {
          notifications: {
            nodes: [
              { type: "issueMention", issue: issue({}) },
              { type: "issueCommentMention", issue: issue({ id: "i3", identifier: "ENG-9", assignee: null }) },
              { type: "issueCommentMention", issue: issue({ id: "i4", identifier: "ENG-10", state: { name: "Done", type: "completed" } }) },
              { type: "issueMention", issue: issue({ id: "i5", identifier: "ENG-11", state: { name: "Duplicate", type: "duplicate" } }) },
              {},
            ],
          },
        };
      }),
    );
    const { login, items } = await Effect.runPromise(inbox.fetch());
    expect(login).toBe("Me");
    expect(items.map((item) => [item.identifier, item.reasons])).toEqual([
      ["ENG-7", ["assigned", "mentioned"]],
      ["ENG-8", ["authored"]],
      ["ENG-9", ["mentioned"]],
    ]);
    expect(items[0]).toMatchObject({ key: "linear:ENG-7", source: "linear", kind: "issue", repo: null, state: "Todo", stateType: "unstarted", team: "ENG", priority: "High", branch: "me/eng-7-rate-limit", author: "Alice", labels: ["ready for dev"], parent: null, children: ["ENG-12"] });
    expect(items[1]).toMatchObject({ parent: "ENG-7", children: [] });
  });

  test("keeps assigned issues when the notifications query fails", async () => {
    const inbox = makeLinearInbox(
      transport((query) => {
        if (query.includes("query Mine")) return { viewer: { id: "me", displayName: "Me" }, issues: { nodes: [issue({})] } };
        throw new Error("notifications unavailable");
      }),
    );
    expect((await Effect.runPromise(inbox.fetch())).items).toHaveLength(1);
  });

  test("polls issues done within the last week; mentions of older done, canceled and duplicate issues are left out", async () => {
    const queries: string[] = [];
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    const done = (identifier: string, completedAt: string) => issue({ id: identifier, identifier, assignee: null, state: { name: "Done", type: "completed" }, completedAt });
    const inbox = makeLinearInbox(
      transport((query) => {
        queries.push(query);
        if (query.includes("query Mine")) return { viewer: { id: "me", displayName: "Me" }, issues: { nodes: [done("ENG-1", daysAgo(1))] } };
        return {
          notifications: {
            nodes: [
              { type: "issueMention", issue: done("ENG-2", daysAgo(2)) },
              { type: "issueMention", issue: done("ENG-3", daysAgo(20)) },
              { type: "issueMention", issue: issue({ id: "i4", identifier: "ENG-4", state: { name: "Canceled", type: "canceled" } }) },
            ],
          },
        };
      }),
    );
    const { items } = await Effect.runPromise(inbox.fetch());
    expect(items.map((item) => [item.identifier, item.stateType])).toEqual([
      ["ENG-1", "completed"],
      ["ENG-2", "completed"],
    ]);
    expect(queries[0]).toContain('completedAt: { gt: "-P7D" }');
  });
});

describe("LinearInbox.labels", () => {
  test("pages through workspace and team labels, skipping groups", async () => {
    const cursors: unknown[] = [];
    const inbox = makeLinearInbox(
      transport((_query, variables) => {
        cursors.push(variables?.after);
        const first = variables?.after === null;
        return {
          issueLabels: {
            nodes: first
              ? [{ name: "Bug", isGroup: false, team: null }, { name: "Area", isGroup: true, team: null }]
              : [{ name: "ready for dev", isGroup: false, team: { key: "ENG" } }],
            pageInfo: { hasNextPage: first, endCursor: first ? "c1" : null },
          },
        };
      }),
    );
    expect(await Effect.runPromise(inbox.labels([]))).toEqual([
      { name: "Bug", scope: null },
      { name: "ready for dev", scope: "ENG" },
    ]);
    expect(cursors).toEqual([null, "c1"]);
  });
});
