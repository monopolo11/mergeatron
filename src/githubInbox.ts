import type { PolledItem } from "./inbox.ts";
import { logger } from "./log.ts";
import type { InboxReason } from "./shared.ts";

const log = logger("github");

/**
 * Polls GitHub for the open PRs and issues that involve you, through the `gh`
 * CLI so the laptop's existing login covers private repositories. One GraphQL
 * search per reason; an item in several results gets all of them.
 */

export const GITHUB_SEARCHES: { reason: InboxReason; q: string }[] = [
  { reason: "review_requested", q: "is:open is:pr archived:false review-requested:@me" },
  { reason: "assigned", q: "is:open archived:false assignee:@me" },
  { reason: "mentioned", q: "is:open archived:false mentions:@me" },
  { reason: "authored", q: "is:open is:pr archived:false author:@me" },
];

const SEARCH_QUERY = `query($q: String!) {
  viewer { login }
  search(query: $q, type: ISSUE, first: 100) {
    nodes {
      __typename
      ... on PullRequest {
        number title url body isDraft state createdAt updatedAt reviewDecision
        headRefName headRefOid baseRefName
        author { login }
        repository { nameWithOwner url defaultBranchRef { name } }
        labels(first: 30) { nodes { name } }
      }
      ... on Issue {
        number title url body state createdAt updatedAt
        author { login }
        repository { nameWithOwner url defaultBranchRef { name } }
        labels(first: 30) { nodes { name } }
      }
    }
  }
}`;

/** The fields of the search query above we read. */
type SearchNode = {
  __typename: "PullRequest" | "Issue";
  number: number;
  title: string;
  url: string;
  body: string | null;
  state: string;
  isDraft?: boolean;
  createdAt: string;
  updatedAt: string;
  reviewDecision?: string | null;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  author: { login: string } | null;
  repository: { nameWithOwner: string; url: string; defaultBranchRef: { name: string } | null };
  labels: { nodes: { name: string }[] };
};

type SearchResult = {
  /** Nodes are typed on the way through `parseSearchNodes`, which checks `__typename`. */
  data?: { viewer: { login: string }; search: { nodes: unknown[] } };
  errors?: { message: string }[];
};

export type InboxFetch = { login: string | null; items: PolledItem[] };

export class GitHubInbox {
  /** `gh api graphql` with the search; injectable for tests. */
  constructor(private readonly search: (query: string, q: string) => Promise<SearchResult> = ghGraphql) {}

  /** The searches run at once: four small GraphQL calls every few minutes sit far below GitHub's limits. */
  async fetch(): Promise<InboxFetch> {
    let login: string | null = null;
    const batches = await Promise.all(
      GITHUB_SEARCHES.map(async ({ reason, q }) => {
        const result = await this.search(SEARCH_QUERY, q);
        if (result.errors?.length) throw new Error(`GitHub search "${q}" failed: ${result.errors.map((e) => e.message).join("; ")}`);
        if (!result.data) throw new Error(`GitHub search "${q}" returned no data`);
        login = result.data.viewer.login;
        return parseSearchNodes(result.data.search.nodes, reason);
      }),
    );
    return { login, items: mergeItems(batches) };
  }
}

/** Items from one search's nodes, all tagged with the reason the search stands for. */
export function parseSearchNodes(nodes: unknown[], reason: InboxReason): PolledItem[] {
  return nodes.flatMap((raw) => {
    const node = raw as Partial<SearchNode>;
    if (node.__typename !== "PullRequest" && node.__typename !== "Issue") return [];
    const pr = node.__typename === "PullRequest";
    const full = node as SearchNode;
    const repo = full.repository.nameWithOwner;
    return [
      {
        key: `github:${repo}#${full.number}`,
        source: "github" as const,
        kind: pr ? ("pull_request" as const) : ("issue" as const),
        repo,
        identifier: `#${full.number}`,
        title: full.title,
        url: full.url,
        body: full.body ?? null,
        author: full.author?.login ?? null,
        state: pr && full.isDraft ? "draft" : full.state.toLowerCase(),
        stateType: null,
        labels: full.labels.nodes.map((label) => label.name),
        reasons: [reason],
        team: null,
        priority: null,
        branch: full.headRefName ?? null,
        headSha: full.headRefOid ?? null,
        base: full.baseRefName ?? null,
        reviewDecision: full.reviewDecision ?? null,
        repoUrl: full.repository.url,
        defaultBranch: full.repository.defaultBranchRef?.name ?? null,
        createdAt: full.createdAt,
        updatedAt: full.updatedAt,
      },
    ];
  });
}

/** One item per key with the union of reasons, in the order the searches run. */
export function mergeItems(batches: PolledItem[][]): PolledItem[] {
  const byKey = new Map<string, PolledItem>();
  for (const item of batches.flat()) {
    const existing = byKey.get(item.key);
    if (!existing) byKey.set(item.key, { ...item, reasons: [...item.reasons] });
    else existing.reasons.push(...item.reasons.filter((reason) => !existing.reasons.includes(reason)));
  }
  return [...byKey.values()];
}

async function ghGraphql(query: string, q: string): Promise<SearchResult> {
  const result = await Bun.$`gh api graphql -f query=${query} -f q=${q}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    log.warn("gh api graphql failed", { q, error: stderr });
    throw new Error(stderr || `gh exited with ${result.exitCode}`);
  }
  return result.json() as SearchResult;
}
