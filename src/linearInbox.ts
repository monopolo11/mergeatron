import { Clock, Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { InboxLabel, PolledItem } from "./inbox.ts";
import { InboxSourceError, type InboxSourceClient } from "./inboxSource.ts";
import { logger } from "./log.ts";
import type { InboxReason } from "./shared.ts";

const log = logger("linear");

/**
 * Polls Linear for the issues that involve you: assigned to or created by you
 * and open or done within the last week, plus issues whose description or
 * comments mention you, read from your notifications. Done issues are polled
 * so rules can fire on them; only rules that name a done state in States do
 * (see `filterMismatch`). Canceled and duplicate issues are left out. Uses a
 * personal API key (`LINEAR_API_KEY`).
 */

const LINEAR_API = "https://api.linear.app/graphql";

const ISSUE_FIELDS = `fragment IssueFields on Issue {
  id identifier title description url priorityLabel branchName createdAt updatedAt completedAt
  state { name type }
  team { key }
  labels { nodes { name } }
  assignee { id displayName }
  creator { id displayName }
}`;

/** How long a done issue stays in the inbox, as a Linear relative date. */
const DONE_WINDOW = "-P7D";
const DONE_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Open and recently done issues assigned to or created by the key's user. Newest activity first; 100 is plenty for one person. */
const MINE_QUERY = `${ISSUE_FIELDS}
query Mine {
  viewer { id displayName }
  issues(
    first: 100
    orderBy: updatedAt
    filter: {
      and: [
        { or: [{ assignee: { isMe: { eq: true } } }, { creator: { isMe: { eq: true } } }] }
        { or: [{ state: { type: { nin: ["completed", "canceled", "duplicate"] } } }, { completedAt: { gt: "${DONE_WINDOW}" } }] }
      ]
    }
  ) { nodes { ...IssueFields } }
}`;

/** Recent mention notifications; the issue state is checked in code since the filter is on the notification. */
const MENTIONS_QUERY = `${ISSUE_FIELDS}
query Mentions {
  notifications(first: 50, filter: { type: { in: ["issueMention", "issueCommentMention"] } }) {
    nodes { ... on IssueNotification { type issue { ...IssueFields } } }
  }
}`;

/** Workspace and team labels. Groups are skipped: issues carry their child labels, never the group. */
const LABELS_QUERY = `query Labels($after: String) {
  issueLabels(first: 250, after: $after) {
    nodes { name isGroup team { key } }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Stops paging a runaway connection; 20 pages is 5000 labels. */
const MAX_LABEL_PAGES = 20;

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priorityLabel: string;
  branchName: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  state: { name: string; type: string };
  team: { key: string };
  labels: { nodes: { name: string }[] };
  assignee: { id: string; displayName: string } | null;
  creator: { id: string; displayName: string } | null;
};

type MineResult = { viewer: { id: string; displayName: string }; issues: { nodes: LinearIssue[] } };
type MentionsResult = { notifications: { nodes: ({ type?: string; issue?: LinearIssue } | Record<string, never>)[] } };
type LabelsResult = {
  issueLabels: {
    nodes: { name: string; isGroup: boolean; team: { key: string } | null }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

/** Workflow state types never polled; `duplicate` is its own type in Linear, not a kind of canceled. */
const DROPPED_STATES = new Set(["canceled", "duplicate"]);

/** Whether a mentioned issue is left out, as the Mine query's filter would leave it out. */
function leftOut(issue: LinearIssue, now: number): boolean {
  if (DROPPED_STATES.has(issue.state.type)) return true;
  if (issue.state.type !== "completed") return false;
  return now - (issue.completedAt ? Date.parse(issue.completedAt) : 0) > DONE_WINDOW_MS;
}

/** GraphQL transport bound to an API key; the live one uses the HttpClient, tests inject fakes. */
export type LinearQuery = <T>(query: string, variables?: Record<string, unknown>) => Effect.Effect<T, InboxSourceError>;

export function makeLinearInbox(query: LinearQuery): InboxSourceClient {
  return {
    fetch: () =>
      Effect.gen(function* () {
        const mine = yield* query<MineResult>(MINE_QUERY);
        const now = yield* Clock.currentTimeMillis;
        const me = mine.viewer.id;
        const items = new Map<string, PolledItem>();
        for (const issue of mine.issues.nodes) {
          const reasons: InboxReason[] = [];
          if (issue.assignee?.id === me) reasons.push("assigned");
          if (issue.creator?.id === me) reasons.push("authored");
          items.set(issue.identifier, linearItem(issue, reasons));
        }
        // Mentions are best effort: the notifications query failing should not hide assigned work.
        const mentions = yield* query<MentionsResult>(MENTIONS_QUERY).pipe(
          Effect.catch((error) => log.warn("notifications query failed; inbox has assigned and created issues only", { error: error.message }).pipe(Effect.as(null))),
        );
        for (const node of mentions?.notifications.nodes ?? []) {
          const issue = node.issue;
          if (!issue || leftOut(issue, now)) continue;
          const existing = items.get(issue.identifier);
          if (existing) {
            if (!existing.reasons.includes("mentioned")) existing.reasons.push("mentioned");
          } else {
            items.set(issue.identifier, linearItem(issue, ["mentioned"]));
          }
        }
        return { login: mine.viewer.displayName, items: [...items.values()] };
      }).pipe(Effect.withSpan("linear.inbox.fetch")),

    /** Every label issues can carry, scoped to its team or null for workspace labels. Linear has no repositories to cover. */
    labels: () =>
      Effect.gen(function* () {
        const labels: InboxLabel[] = [];
        let after: string | null = null;
        for (let page = 0; page < MAX_LABEL_PAGES; page++) {
          const { issueLabels }: LabelsResult = yield* query<LabelsResult>(LABELS_QUERY, { after });
          for (const label of issueLabels.nodes) if (!label.isGroup) labels.push({ name: label.name, scope: label.team?.key ?? null });
          after = issueLabels.pageInfo.endCursor;
          if (!issueLabels.pageInfo.hasNextPage || !after) break;
        }
        return labels;
      }).pipe(Effect.withSpan("linear.inbox.labels")),
  };
}

export function linearItem(issue: LinearIssue, reasons: InboxReason[]): PolledItem {
  return {
    key: `linear:${issue.identifier}`,
    source: "linear",
    kind: "issue",
    repo: null,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    body: issue.description ?? null,
    author: issue.creator?.displayName ?? null,
    state: issue.state.name,
    stateType: issue.state.type,
    labels: issue.labels.nodes.map((label) => label.name),
    reasons,
    team: issue.team.key,
    priority: issue.priorityLabel,
    branch: issue.branchName,
    headSha: null,
    base: null,
    reviewDecision: null,
    repoUrl: null,
    defaultBranch: null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

const failed = (message: string) => new InboxSourceError({ source: "linear", message: `Linear API failed: ${message}` });

/** The live transport over the HttpClient. */
export const linearTransport = (apiKey: string): Effect.Effect<LinearQuery, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client): LinearQuery => (query, variables) =>
    Effect.gen(function* () {
      const response = yield* client.execute(
        HttpClientRequest.post(LINEAR_API).pipe(HttpClientRequest.setHeaders({ authorization: apiKey }), HttpClientRequest.bodyJsonUnsafe({ query, variables })),
      );
      const body = (yield* response.json.pipe(Effect.orElseSucceed(() => null))) as { data?: unknown; errors?: { message: string }[] } | null;
      if (response.status < 200 || response.status >= 300 || !body?.data) {
        const detail = body?.errors?.map((e) => e.message).join("; ") || `${response.status}`;
        return yield* Effect.fail(failed(detail));
      }
      return body.data;
    }).pipe(Effect.catchTag("HttpClientError", (error) => Effect.fail(failed(error.message)))) as never,
  );

/** The Linear inbox source as the poller uses it. */
export const LinearInbox = { make: makeLinearInbox, live: (apiKey: string) => Effect.map(linearTransport(apiKey), makeLinearInbox) };
