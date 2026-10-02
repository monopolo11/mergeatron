import { useQuery } from "@tanstack/react-query";
import { Empty, Heading } from "@/components/Field";
import { Count, Toolbar } from "@/components/Toolbar";
import { Table, TableBody, TableCell, TableFigure, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RUN_SOURCES, type RunSource } from "../../src/shared.ts";
import type { Analytics as AnalyticsData, RunCounts } from "../../src/store.ts";

const SOURCE_LABELS: Record<RunSource, string> = {
  github: "GitHub webhook",
  slack: "Slack",
  poll: "Inbox automation",
  manual: "Manual (inbox dispatch, connection test)",
};

const EMPTY: RunCounts = { total: 0, queued: 0, started: 0, done: 0, skipped: 0, failed: 0 };

/** Review counts per PR author and per trigger source. Polls on the run log's cadence. */
export function Analytics() {
  const { data } = useQuery({
    queryKey: ["analytics"],
    queryFn: () => api<AnalyticsData>("/api/analytics"),
    refetchInterval: 5000,
  });

  // Every known source is listed, so an unused trigger still reads as zero.
  const sources = RUN_SOURCES.map((source) => ({
    source,
    ...(data?.bySource.find((row) => row.source === source) ?? EMPTY),
  }));

  return (
    <div className="flex min-h-full flex-col">
      <Toolbar title="Analytics">
        {data && (
          <>
            <Count value={data.all.total} label="runs" />
            <Count value={data.all.queued} label="queued" tone="idle" />
            <Count value={data.all.started} label="running" tone="active" />
            <Count value={data.all.done} label="done" tone="ok" />
            <Count value={data.all.skipped} label="skipped" tone="warn" />
            <Count value={data.all.failed} label="failed" tone="err" />
          </>
        )}
      </Toolbar>

      {!data ? (
        <Empty>Loading…</Empty>
      ) : (
        <div className="grid gap-6 p-4">
          <CountsTable
            title="By author"
            keyHeader="Author"
            rows={data.byAuthor.map((row) => ({ key: row.author, label: row.author, ...row }))}
            empty="No reviews with an author yet. Connection tests are not counted here."
          />
          <CountsTable
            title="By trigger"
            keyHeader="Source"
            rows={sources.map((row) => ({ key: row.source, label: SOURCE_LABELS[row.source], ...row }))}
          />
        </div>
      )}
    </div>
  );
}

type CountsRow = RunCounts & { key: string; label: string };

function CountsTable({ title, keyHeader, rows, empty }: { title: string; keyHeader: string; rows: CountsRow[]; empty?: string }) {
  return (
    <section className="grid gap-2">
      <Heading>{title}</Heading>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{keyHeader}</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">Queued</TableHead>
              <TableHead className="text-right">Running</TableHead>
              <TableHead className="text-right">Done</TableHead>
              <TableHead className="text-right">Skipped</TableHead>
              <TableHead className="text-right">Failed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key} className={cn(row.total === 0 && "text-muted-foreground")}>
                <TableCell className="font-mono">{row.label}</TableCell>
                <TableFigure value={row.total} />
                <TableFigure value={row.queued} tone="idle" />
                <TableFigure value={row.started} tone="active" />
                <TableFigure value={row.done} tone="ok" />
                <TableFigure value={row.skipped} tone="warn" />
                <TableFigure value={row.failed} tone="err" />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
