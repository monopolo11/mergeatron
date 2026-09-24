import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, timeAgo } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PullRequestStatus, PullRequestSummary } from "../../src/store.ts";

const STATUS: Record<PullRequestStatus, { label: string; className: string }> = {
  reviewing: { label: "reviewing", className: "text-primary" },
  paused: { label: "paused", className: "text-destructive" },
  changes_requested: { label: "changes requested", className: "text-warn" },
  approved: { label: "approved", className: "text-ok" },
  commented: { label: "no verdict", className: "text-muted-foreground" },
  skipped: { label: "skipped", className: "text-warn" },
  failed: { label: "failed", className: "text-destructive" },
};

/** Statuses offered as filters, in the order they need attention. Validates the `/reviews?status=` search param. */
export const STATUS_FILTERS = ["reviewing", "paused", "changes_requested", "approved"] as const satisfies PullRequestStatus[];

/** Status and review counts per PR, most recently active first. Polls on the run log's cadence. */
export function Reviews() {
  const { status: filter } = useSearch({ from: "/reviews" });
  const { data } = useQuery({
    queryKey: ["pulls"],
    queryFn: () => api<PullRequestSummary[]>("/api/pulls"),
    refetchInterval: 5000,
  });

  if (!data) return <p className="p-4 text-muted-foreground">Loading…</p>;

  const count = (status: PullRequestStatus) => data.filter((pr) => pr.status === status).length;
  const visible = filter ? data.filter((pr) => pr.status === filter) : data;

  return (
    <div className="grid gap-4 p-4">
      <nav className="flex flex-wrap items-baseline gap-1 font-mono text-xs">
        <FilterLink status={undefined} active={!filter} value={data.length} label="PRs" />
        {STATUS_FILTERS.map((status) => (
          <FilterLink key={status} status={status} active={filter === status} value={count(status)} label={STATUS[status].label} className={STATUS[status].className} />
        ))}
      </nav>

      {visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {data.length === 0 ? "No PR reviews yet. PRs show up here once a rule runs on them." : "No PRs with this status."}
        </p>
      ) : (
        <Table className="text-xs">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-7">PR</TableHead>
              <TableHead className="h-7">Title</TableHead>
              <TableHead className="h-7">Status</TableHead>
              <TableHead className="h-7 text-right">Reviews</TableHead>
              <TableHead className="h-7 text-right">Approved</TableHead>
              <TableHead className="h-7 text-right">Changes</TableHead>
              <TableHead className="h-7 text-right">Skipped</TableHead>
              <TableHead className="h-7 text-right">Failed</TableHead>
              <TableHead className="h-7 text-right">Last</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((pr) => (
              <TableRow key={`${pr.repo}#${pr.number}`}>
                <TableCell className="py-1.5 font-mono">
                  <MaybeLink href={pr.url}>{pr.repo}#{pr.number}</MaybeLink>
                </TableCell>
                <TableCell className="w-full max-w-0 truncate py-1.5" title={[pr.title, pr.author && `by ${pr.author}`].filter(Boolean).join(" ")}>
                  <MaybeLink href={pr.threadUrl}>{pr.title ?? "Untitled"}</MaybeLink>
                </TableCell>
                <TableCell className={cn("py-1.5", STATUS[pr.status].className)}>{STATUS[pr.status].label}</TableCell>
                <Count value={pr.reviews} />
                <Count value={pr.approved} className="text-ok" />
                <Count value={pr.changesRequested} className="text-warn" />
                <Count value={pr.skipped} className="text-warn" />
                <Count value={pr.failed} className="text-destructive" />
                <TableCell className="py-1.5 text-right text-muted-foreground" title={new Date(pr.lastAt).toLocaleString()}>{timeAgo(pr.lastAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** A count that doubles as its status filter; the total clears the filter. */
function FilterLink({ status, active, value, label, className }: { status: (typeof STATUS_FILTERS)[number] | undefined; active: boolean; value: number; label: string; className?: string }) {
  return (
    <Link to="/reviews" search={{ status }} className={cn("rounded px-2 py-1 text-muted-foreground hover:bg-muted/60", active && "bg-muted")}>
      <span className={cn("text-base text-foreground", className)}>{value}</span> {label}
    </Link>
  );
}

/** Zeros are dimmed so the non-zero counts stand out. */
function Count({ value, className }: { value: number; className?: string }) {
  return <TableCell className={cn("py-1.5 text-right font-mono", value > 0 ? className : "text-muted-foreground/60")}>{value}</TableCell>;
}

function MaybeLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) return <>{children}</>;
  return <a href={href} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">{children}</a>;
}
