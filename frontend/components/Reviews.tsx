import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Empty, ExternalLink } from "@/components/Field";
import { FilterBar, useScope } from "@/components/FilterBar";
import { Count, PageHeader } from "@/components/Toolbar";
import { Table, TableBody, TableCell, TableFigure, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, timeAgo } from "@/lib/api";
import { useRunFacets } from "@/lib/runFacets";
import { resolveWindow, scopeKey, scopeQuery, type RunFacet, type ScopeSearch } from "@/lib/scope";
import { PR_STATUS, TONE_TEXT } from "@/lib/status";
import type { PullRequestStatus, PullRequestSummary } from "../../src/store.ts";

const REVIEW_FACETS = ["rule", "repo", "author"] as const satisfies RunFacet[];

/** Statuses offered as filters, in the order they need attention. Validates the `/reviews?status=` search param. */
export const STATUS_FILTERS = ["reviewing", "queued", "paused", "changes_requested", "approved"] as const satisfies PullRequestStatus[];

/**
 * Status and review counts per PR from its runs in the range and filters,
 * most recently active first. Polls on the run log's cadence.
 */
export function Reviews() {
  const { status: filter } = useSearch({ from: "/reviews" });
  const navigate = useNavigate();
  const { search } = useScope();
  const { facets } = useRunFacets(REVIEW_FACETS);
  // Only the range and the facets this page shows narrow it; filters set on other pages stay in the URL for them.
  const scope: ScopeSearch = { range: search.range, from: search.from, to: search.to, rule: search.rule, repo: search.repo, author: search.author };
  const { data } = useQuery({
    queryKey: ["pulls", scopeKey(scope)],
    queryFn: () => api<PullRequestSummary[]>(`/api/pulls?${scopeQuery(scope, resolveWindow(scope))}`),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });

  const setFilter = (status?: (typeof STATUS_FILTERS)[number]) => void navigate({ to: "/reviews", search: (prev: { status?: (typeof STATUS_FILTERS)[number] }) => ({ ...prev, status }) });
  const count = (status: PullRequestStatus) => (data ?? []).filter((pr) => pr.status === status).length;
  const visible = filter ? (data ?? []).filter((pr) => pr.status === filter) : data ?? [];

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Reviews"
        summary={data && `${data.length} PRs · ${data.reduce((sum, pr) => sum + pr.reviews, 0)} reviews`}
        filters={<FilterBar facets={facets} />}
        toggles={
          data && (
            <>
              <Count value={data.length} label="all" active={!filter} onClick={() => setFilter(undefined)} />
              {STATUS_FILTERS.map((status) => (
                <Count key={status} value={count(status)} label={PR_STATUS[status].label} tone={PR_STATUS[status].tone} active={filter === status} onClick={() => setFilter(filter === status ? undefined : status)} />
              ))}
            </>
          )
        }
      />

      {!data ? (
        <Empty>Loading…</Empty>
      ) : visible.length === 0 ? (
        <Empty>{data.length === 0 ? "No PR reviews in this range. PRs show up here once a rule runs on them." : "No PRs with this status."}</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>PR</TableHead>
              <TableHead className="w-full">Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Reviews</TableHead>
              <TableHead className="text-right">Approved</TableHead>
              <TableHead className="text-right">Changes</TableHead>
              <TableHead className="text-right">Skipped</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">Last</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((pr) => (
              <TableRow key={`${pr.repo}#${pr.number}`}>
                <TableCell className="font-mono">
                  <MaybeLink href={pr.url}>{pr.repo}#{pr.number}</MaybeLink>
                </TableCell>
                <TableCell className="max-w-0 truncate" title={[pr.title, pr.author && `by ${pr.author}`].filter(Boolean).join(" ")}>
                  <MaybeLink href={pr.threadUrl}>{pr.title ?? "Untitled"}</MaybeLink>
                </TableCell>
                <TableCell className={TONE_TEXT[PR_STATUS[pr.status].tone]}>{PR_STATUS[pr.status].label}</TableCell>
                <TableFigure value={pr.reviews} />
                <TableFigure value={pr.approved} tone="ok" />
                <TableFigure value={pr.changesRequested} tone="warn" />
                <TableFigure value={pr.skipped} tone="warn" />
                <TableFigure value={pr.failed} tone="err" />
                <TableCell className="text-right text-muted-foreground" title={new Date(pr.lastAt).toLocaleString()}>{timeAgo(pr.lastAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function MaybeLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) return <>{children}</>;
  return <ExternalLink href={href}>{children}</ExternalLink>;
}
