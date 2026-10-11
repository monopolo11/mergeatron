import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Empty, Heading } from "@/components/Field";
import { Count, Figure, Toolbar } from "@/components/Toolbar";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableFigure, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { tokenCount, usd } from "@/lib/format";
import { scoreTone, TONE_TEXT } from "@/lib/status";
import { cn } from "@/lib/utils";
import { RUN_SOURCES, type RunSource } from "../../src/shared.ts";
import type { Analytics as AnalyticsData, RunCounts, RunStats } from "../../src/store.ts";
import type { BackfillStatus } from "../../src/usage.ts";

const SOURCE_LABELS: Record<RunSource, string> = {
  github: "GitHub webhook",
  slack: "Slack",
  poll: "Inbox automation",
  manual: "Manual (inbox dispatch, connection test)",
};

const EMPTY: RunCounts = { total: 0, queued: 0, started: 0, done: 0, skipped: 0, failed: 0 };

/**
 * Score and cost per prompt version and per model, to compare them, then
 * review counts per PR author and per trigger source. Polls on the run log's
 * cadence. The toolbar says how many runs have usage measured and measures
 * the rest (see src/usage.ts).
 */
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
            <span className="ml-auto font-mono whitespace-nowrap text-muted-foreground" title="Settled runs that opened a thread">
              measured <Figure>{data.usage.measured}</Figure>/{data.usage.runs} · <Figure>{data.usage.totalCostUsd === null ? "-" : usd(data.usage.totalCostUsd)}</Figure>
            </span>
            <MeasureButton />
          </>
        )}
      </Toolbar>

      {!data ? (
        <Empty>Loading…</Empty>
      ) : (
        <div className="grid gap-6 p-4">
          <StatsTable
            title="By prompt version"
            keyHeader="Prompt"
            rows={data.byPrompt.map((row) => ({
              ...row,
              key: `${row.owner}:${row.id}:${row.version}`,
              label: (
                <>
                  {row.name ?? row.owner} v{row.version}
                  {row.live && <span className="text-muted-foreground"> live</span>}
                </>
              ),
            }))}
            empty="No runs from a versioned prompt yet."
          />
          <StatsTable
            title="By model"
            keyHeader="Model"
            rows={data.byModel.map((row) => ({ ...row, key: `${row.modelInstanceId}/${row.modelId}`, label: `${row.modelInstanceId} / ${row.modelId}` }))}
            empty="No runs that started a thread yet."
          />
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

/**
 * Starts measuring settled runs that have no usage yet. Hidden when there are
 * none; while a backfill runs it polls until done, then refreshes the figures.
 */
function MeasureButton() {
  const queryClient = useQueryClient();
  const { data: backfill } = useQuery({
    queryKey: ["usage-backfill"],
    queryFn: () => api<BackfillStatus>("/api/runs/usage/backfill"),
    refetchInterval: (query) => (query.state.data?.running ? 2000 : 30_000),
  });
  const start = useMutation({
    mutationFn: () => api<BackfillStatus>("/api/runs/usage/backfill", { method: "POST" }),
    onSuccess: (status) => queryClient.setQueryData(["usage-backfill"], status),
  });
  if (!backfill || (backfill.pending === 0 && !backfill.running)) return null;
  if (backfill.running) return <span className="font-mono text-muted-foreground">measuring {backfill.pending}…</span>;
  return (
    <Button size="xs" variant="outline" disabled={start.isPending} onClick={() => start.mutate()} title={start.error?.message ?? "Measure settled runs from the last 30 days that have no usage yet"}>
      Measure {backfill.pending}
    </Button>
  );
}

type StatsRow = RunStats & { key: string; label: ReactNode };

/** Runs, score and usage per group; cache read is the share of input tokens served from the prompt cache. */
function StatsTable({ title, keyHeader, rows, empty }: { title: string; keyHeader: string; rows: StatsRow[]; empty: string }) {
  return (
    <section className="grid gap-2">
      <Heading>{title}</Heading>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-full">{keyHeader}</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">Scored</TableHead>
              <TableHead className="text-right">Avg score</TableHead>
              <TableHead className="text-right">Measured</TableHead>
              <TableHead className="text-right">Avg cost</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Avg out</TableHead>
              <TableHead className="text-right">Cache read</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell className="font-mono">{row.label}</TableCell>
                <TableFigure value={row.total} />
                <TableFigure value={row.rated} />
                <StatCell value={row.avgRating} format={(rating) => rating.toFixed(1)} className={row.avgRating !== null ? TONE_TEXT[scoreTone(row.avgRating)] : undefined} />
                <TableFigure value={row.measured} />
                <StatCell value={row.avgCostUsd} format={(cost) => usd(cost)} />
                <StatCell value={row.totalCostUsd} format={(cost) => usd(cost)} />
                <StatCell value={row.avgOutputTokens} format={tokenCount} />
                <StatCell value={cacheReadShare(row)} format={(share) => `${Math.round(share * 100)}%`} />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** A right-aligned figure, or a quiet `-` when no run had one. */
function StatCell({ value, format, className }: { value: number | null; format: (value: number) => string; className?: string }) {
  return <TableCell className={cn("text-right font-mono", value === null ? "text-muted-foreground/60" : className)}>{value === null ? "-" : format(value)}</TableCell>;
}

/** Cache reads over every input-side token (fresh input, cache writes, cache reads); null when nothing was measured. */
function cacheReadShare({ avgInputTokens, avgCacheCreationTokens, avgCacheReadTokens }: RunStats): number | null {
  if (avgInputTokens === null || avgCacheCreationTokens === null || avgCacheReadTokens === null) return null;
  const input = avgInputTokens + avgCacheCreationTokens + avgCacheReadTokens;
  return input === 0 ? null : avgCacheReadTokens / input;
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
