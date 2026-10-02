import type { InboxLabel, PolledItem } from "./inbox.ts";
import { logger } from "./log.ts";
import type { InboxReason } from "./shared.ts";

const log = logger("linear");

/**
 * Polls Linear for the issues that involve you: assigned to or created by you
 * and not done, plus issues whose description or comments mention you, read
 * from your notifications. Uses a personal API key (`LINEAR_API_KEY`).
 */

const LINEAR_API = "https://api.linear.app/graphql";

const ISSUE_FIELDS = `fragment IssueFields on Issue {
  id identifier title description url priorityLabel branchName createdAt updatedAt
  state { name type }
  team { key }
  labels { nodes { name } }
  assignee { id displayName }
  creator { id displayName }
}`;

/** Open issues assigned to or created by the key's user. Newest activity first; 100 is plenty for one person. */
const MINE_QUERY = `${ISSUE_FIELDS}
query Mine {
  viewer { id displayName }
  issues(
    first: 100
    orderBy: updatedAt
    filter: {
      or: [{ assignee: { isMe: { eq: true } } }, { creator: { isMe: { eq: true } } }]
      state: { type: { nin: ["completed", "canceled", "duplicate"] } }
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

/** Workflow state types that mean the issue is over; `duplicate` is its own type in Linear, not a kind of canceled. */
const DONE_STATES = new Set(["completed", "canceled", "duplicate"]);

export class LinearInbox {
  constructor(
    private readonly apiKey: string,
    /** GraphQL transport; injectable for tests. */
    private readonly query: <T>(apiKey: string, query: string, variables?: Record<string, unknown>) => Promise<T> = linearGraphql,
  ) {}

  async fetch(): Promise<{ login: string | null; items: PolledItem[] }> {
    const mine = await this.query<MineResult>(this.apiKey, MINE_QUERY);
    const me = mine.viewer.id;
    const items = new Map<string, PolledItem>();
    for (const issue of mine.issues.nodes) {
      const reasons: InboxReason[] = [];
      if (issue.assignee?.id === me) reasons.push("assigned");
      if (issue.creator?.id === me) reasons.push("authored");
      items.set(issue.identifier, linearItem(issue, reasons));
    }
    // Mentions are best effort: the notifications query failing should not hide assigned work.
    try {
      const mentions = await this.query<MentionsResult>(this.apiKey, MENTIONS_QUERY);
      for (const node of mentions.notifications.nodes) {
        const issue = node.issue;
        if (!issue || DONE_STATES.has(issue.state.type)) continue;
        const existing = items.get(issue.identifier);
        if (existing) {
          if (!existing.reasons.includes("mentioned")) existing.reasons.push("mentioned");
        } else {
          items.set(issue.identifier, linearItem(issue, ["mentioned"]));
        }
      }
    } catch (error) {
      log.warn("notifications query failed; inbox has assigned and created issues only", { error });
    }
    return { login: mine.viewer.displayName, items: [...items.values()] };
  }

  /** Every label issues can carry, scoped to its team or null for workspace labels. Linear has no repositories to cover. */
  async labels(): Promise<InboxLabel[]> {
    const labels: InboxLabel[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_LABEL_PAGES; page++) {
      const { issueLabels }: LabelsResult = await this.query<LabelsResult>(this.apiKey, LABELS_QUERY, { after });
      for (const label of issueLabels.nodes) if (!label.isGroup) labels.push({ name: label.name, scope: label.team?.key ?? null });
      after = issueLabels.pageInfo.endCursor;
      if (!issueLabels.pageInfo.hasNextPage || !after) break;
    }
    return labels;
  }
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

async function linearGraphql<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(LINEAR_API, {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
  if (!response.ok || !body?.data) {
    const detail = body?.errors?.map((e) => e.message).join("; ") || `${response.status} ${response.statusText}`;
    throw new Error(`Linear API failed: ${detail}`);
  }
  return body.data;
}
