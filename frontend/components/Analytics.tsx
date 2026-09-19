import { useEffect, useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RUN_SOURCES, type RunSource } from "../../src/shared.ts";
import type { Analytics as AnalyticsData, RunCounts } from "../../src/store.ts";

const SOURCE_LABELS: Record<RunSource, string> = {
  github: "GitHub webhook",
  slack: "Slack",
  manual: "Connection test",
};

const EMPTY: RunCounts = { total: 0, started: 0, skipped: 0, failed: 0 };

/** Review counts per PR author and per trigger source. Refreshes with the run log. */
export function Analytics({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  useEffect(() => {
    api<AnalyticsData>("/api/analytics").then(setData).catch(() => {});
  }, [refreshKey]);

  if (!data) return <p className="p-4 text-muted-foreground">Loading…</p>;

  // Every known source is listed, so a trigger with no producer yet still reads as zero.
  const sources = RUN_SOURCES.map((source) => ({
    source,
    ...(data.bySource.find((row) => row.source === source) ?? EMPTY),
  }));

  return (
    <div className="grid gap-6 p-4">
      <div className="flex items-baseline gap-6 font-mono text-xs">
        <Stat label="runs" value={data.all.total} />
        <Stat label="started" value={data.all.started} className="text-ok" />
        <Stat label="skipped" value={data.all.skipped} className="text-warn" />
        <Stat label="failed" value={data.all.failed} className="text-destructive" />
      </div>

      <CountsTable
        title="By author"
        keyHeader="Author"
        rows={data.byAuthor.map((row) => ({ key: row.author, label: row.author, ...row }))}
        empty="No reviews with an author yet. Connection tests are not counted here."
      />

      <CountsTable
        title="By trigger"
        keyHeader="Source"
        rows={sources.map((row) => ({
          key: row.source,
          label: SOURCE_LABELS[row.source],
          note: row.source === "slack" ? "not wired yet" : undefined,
          ...row,
        }))}
      />
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <span className="text-muted-foreground">
      <span className={cn("text-base text-foreground", className)}>{value}</span> {label}
    </span>
  );
}

type CountsRow = RunCounts & { key: string; label: string; note?: string };

function CountsTable({ title, keyHeader, rows, empty }: { title: string; keyHeader: string; rows: CountsRow[]; empty?: string }) {
  return (
    <section className="grid gap-1">
      <h2 className="text-[11px] tracking-wide text-muted-foreground uppercase">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <Table className="text-xs">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-7">{keyHeader}</TableHead>
              <TableHead className="h-7 text-right">Runs</TableHead>
              <TableHead className="h-7 text-right">Started</TableHead>
              <TableHead className="h-7 text-right">Skipped</TableHead>
              <TableHead className="h-7 text-right">Failed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key} className={cn(row.total === 0 && "text-muted-foreground")}>
                <TableCell className="py-1.5 font-mono">
                  {row.label}
                  {row.note && <span className="ml-2 font-sans text-muted-foreground">{row.note}</span>}
                </TableCell>
                <TableCell className="py-1.5 text-right font-mono">{row.total}</TableCell>
                <TableCell className={cn("py-1.5 text-right font-mono", row.started > 0 && "text-ok")}>{row.started}</TableCell>
                <TableCell className={cn("py-1.5 text-right font-mono", row.skipped > 0 && "text-warn")}>{row.skipped}</TableCell>
                <TableCell className={cn("py-1.5 text-right font-mono", row.failed > 0 && "text-destructive")}>{row.failed}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
