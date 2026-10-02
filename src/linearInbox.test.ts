import { describe, expect, test } from "bun:test";
import { LinearInbox, type LinearIssue } from "./linearInbox.ts";

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
  state: { name: "Todo", type: "unstarted" },
  team: { key: "ENG" },
  labels: { nodes: [{ name: "ready for dev" }] },
  assignee: { id: "me", displayName: "Me" },
  creator: { id: "u2", displayName: "Alice" },
  ...patch,
});

describe("LinearInbox.fetch", () => {
  test("derives reasons from assignee, creator and mention notifications", async () => {
    const inbox = new LinearInbox("key", async <T,>(_key: string, query: string): Promise<T> => {
      if (query.includes("query Mine")) {
        return {
          viewer: { id: "me", displayName: "Me" },
          issues: { nodes: [issue({}), issue({ id: "i2", identifier: "ENG-8", assignee: null, creator: { id: "me", displayName: "Me" } })] },
        } as T;
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
      } as T;
    });
    const { login, items } = await inbox.fetch();
    expect(login).toBe("Me");
    expect(items.map((item) => [item.identifier, item.reasons])).toEqual([
      ["ENG-7", ["assigned", "mentioned"]],
      ["ENG-8", ["authored"]],
      ["ENG-9", ["mentioned"]],
    ]);
    expect(items[0]).toMatchObject({ key: "linear:ENG-7", source: "linear", kind: "issue", repo: null, state: "Todo", stateType: "unstarted", team: "ENG", priority: "High", branch: "me/eng-7-rate-limit", author: "Alice", labels: ["ready for dev"] });
  });

  test("keeps assigned issues when the notifications query fails", async () => {
    const inbox = new LinearInbox("key", async <T,>(_key: string, query: string): Promise<T> => {
      if (query.includes("query Mine")) return { viewer: { id: "me", displayName: "Me" }, issues: { nodes: [issue({})] } } as T;
      throw new Error("notifications unavailable");
    });
    expect((await inbox.fetch()).items).toHaveLength(1);
  });
});
