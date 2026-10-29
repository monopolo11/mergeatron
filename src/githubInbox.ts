import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { exec } from "./exec.ts";
import type { InboxLabel, PolledItem } from "./inbox.ts";
import { InboxSourceError, type InboxSourceClient } from "./inboxSource.ts";
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

export type SearchResult = {
  /** Nodes are typed on the way through `parseSearchNodes`, which checks `__typename`. */
  data?: { viewer: { login: string }; search: { nodes: unknown[] } };
  errors?: { message: string }[];
};

/** How the source talks to GitHub; the live one runs `gh`, tests inject fakes. */
export type GitHubTransport = {
  /** `gh api graphql` with the search. */
  readonly search: (query: string, q: string) => Effect.Effect<SearchResult, InboxSourceError>;
  /** Label names of one `owner/name` repository. */
  readonly repoLabels: (repo: string) => Effect.Effect<string[], InboxSourceError>;
};

const failed = (message: string) => new InboxSourceError({ source: "github", message });

export function makeGitHubInbox(transport: GitHubTransport): InboxSourceClient {
  return {
    /** The searches run at once: four small GraphQL calls every few minutes sit far below GitHub's limits. */
    fetch: () =>
      Effect.gen(function* () {
        const batches = yield* Effect.forEach(
          GITHUB_SEARCHES,
          ({ reason, q }) =>
            Effect.gen(function* () {
              const result = yield* transport.search(SEARCH_QUERY, q);
              if (result.errors?.length) return yield* Effect.fail(failed(`GitHub search "${q}" failed: ${result.errors.map((e) => e.message).join("; ")}`));
              if (!result.data) return yield* Effect.fail(failed(`GitHub search "${q}" returned no data`));
              return { login: result.data.viewer.login, items: parseSearchNodes(result.data.search.nodes, reason) };
            }),
          { concurrency: "unbounded" },
        );
        return { login: batches.at(-1)?.login ?? null, items: mergeItems(batches.map((batch) => batch.items)) };
      }).pipe(Effect.withSpan("github.inbox.fetch")),

    /** Labels live on repositories: one listing per repo, at once. A repo that fails (renamed, no access) is left out. */
    labels: (repos) =>
      Effect.forEach(
        repos,
        (repo) =>
          transport.repoLabels(repo).pipe(
            Effect.map((names): InboxLabel[] => names.map((name) => ({ name, scope: repo }))),
            Effect.catch((error) => log.warn("labels fetch failed", { repo, error: error.message }).pipe(Effect.as([] as InboxLabel[]))),
          ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((lists) => lists.flat()),
        Effect.withSpan("github.inbox.labels", { attributes: { repos: repos.length } }),
      ),
  };
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
        parent: null,
        children: [],
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

/** The live transport: `gh` child processes. */
export const ghTransport: Effect.Effect<GitHubTransport, never, ChildProcessSpawner.ChildProcessSpawner> = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const gh = (args: string[]) =>
    exec("gh", args).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError((error) => failed(error.message)),
      Effect.flatMap((output) => (output.exitCode === 0 ? Effect.succeed(output.stdout) : Effect.fail(failed(output.stderr || `gh exited with ${output.exitCode}`)))),
    );
  return {
    search: (query, q) =>
      gh(["api", "graphql", "-f", `query=${query}`, "-f", `q=${q}`]).pipe(
        Effect.tapError((error) => log.warn("gh api graphql failed", { q, error: error.message })),
        Effect.flatMap((stdout) => Effect.try({ try: () => JSON.parse(stdout) as SearchResult, catch: () => failed("gh returned no JSON") })),
      ),
    repoLabels: (repo) => Effect.map(gh(["api", "--paginate", `repos/${repo}/labels?per_page=100`, "--jq", ".[].name"]), (stdout) => stdout.split("\n").filter(Boolean)),
  };
});

/** The GitHub inbox source as the poller uses it. */
export const GitHubInbox = { make: makeGitHubInbox, live: Effect.map(ghTransport, makeGitHubInbox) };
