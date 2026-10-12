import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Legend, LineChart, Sparkline, StackedBars, type Point, type Series } from "@/components/Charts";
import { Empty, Heading } from "@/components/Field";
import { FilterBar, useScope } from "@/components/FilterBar";
import { PageHeader } from "@/components/Toolbar";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableFigure, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { tokenCount, usd } from "@/lib/format";
import { promptKey, SOURCE_LABELS, useRunFacets } from "@/lib/runFacets";
import { isoDay, previousWindow, resolveWindow, RUN_FACETS, scopeKey, scopeQuery, validateScope, type RunFacet, type ScopeSearch, type Window } from "@/lib/scope";
import { scoreTone, TONE_TEXT } from "@/lib/status";
import { cn } from "@/lib/utils";
import { RUN_SOURCES } from "../../src/shared.ts";
import type { Analytics as AnalyticsData, RunCounts, RunStats } from "../../src/store.ts";
import type { BackfillStatus } from "../../src/usage.ts";

const EMPTY: RunCounts = { total: 0, queued: 0, started: 0, done: 0, skipped: 0, failed: 0 };
const RUN_SERIES: Series[] = [
  { key: "done", label: "done", tone: "ok" },
  { key: "skipped", label: "skipped", tone: "warn" },
  { key: "failed", label: "failed", tone: "err" },
  { key: "open", label: "queued or running", tone: "active" },
];
const COST_SERIES: Series = { key: "cost", label: "cost", tone: "active" };

/** `/analytics` search: whether to compare with the period before the range. */
export type AnalyticsSearch = { compare?: true };
export const validateAnalyticsSearch = (search: Record<string, unknown>): AnalyticsSearch => ({ compare: search.compare === true ? true : undefined });

/** Analytics for the scope, fetched again when the scope changes and every 15s; the window is resolved at fetch time. */
function useAnalytics(search: ScopeSearch, window: (now: Date) => Window | null, key: string, enabled = true) {
  return useQuery({
    queryKey: ["analytics", key, scopeKey(search)],
    queryFn: () => api<AnalyticsData>(`/api/analytics?${scopeQuery(search, window(new Date())!, { utcOffset: String(-new Date().getTimezoneOffset()) })}`),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * Runs, outcome, score and cost over the range and filters in the URL: stat
 * tiles (with the change from the period before when comparing), runs and
 * cost per day, then breakdowns per model, author, trigger and prompt
 * version. Clicking a breakdown row adds it as a filter.
 */
export function Analytics() {
  const { search, setScope } = useScope();
  const { compare } = useSearch({ from: "/analytics" });
  const navigate = useNavigate();
  const { facets, promptLabel } = useRunFacets(RUN_FACETS);
  const window = resolveWindow(search);
  const comparable = previousWindow(window) !== null;
  const { data } = useAnalytics(search, (now) => resolveWindow(search, now), "current");
  const { data: previous } = useAnalytics(search, (now) => previousWindow(resolveWindow(search, now), now), "previous", !!compare && comparable);

  /** Adds a breakdown row's value to its facet, or removes it when already there. */
  const toggleFilter = (facet: RunFacet, value: string) => {
    const current: readonly string[] = search[facet] ?? [];
    setScope(validateScope({ ...search, [facet]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value] }));
  };
  const picked = (facet: RunFacet, value: string) => (search[facet] as readonly string[] | undefined)?.includes(value) ?? false;

  const points = data ? dayPoints(data, window) : [];
  const sources = RUN_SOURCES.map((source) => ({ source, ...(data?.bySource.find((row) => row.source === source) ?? EMPTY) }));

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Analytics"
        summary={
          data && (
            <>
              {data.all.total} runs · {data.all.totalCostUsd === null ? "-" : usd(data.all.totalCostUsd)} · measured {data.usage.measured}/{data.usage.runs}
            </>
          )
        }
        filters={
          <FilterBar facets={facets}>
            <MeasureButton />
            {comparable && (
              <Label className="gap-2 text-xs font-normal text-muted-foreground">
                Compare to previous period
                <Switch size="sm" checked={!!compare} onCheckedChange={(on) => void navigate({ to: "/analytics", search: (prev: AnalyticsSearch) => ({ ...prev, compare: on || undefined }), replace: true })} />
              </Label>
            )}
          </FilterBar>
        }
      />

      {!data ? (
        <Empty>Loading…</Empty>
      ) : data.all.total === 0 ? (
        <Empty>No runs in this range{Object.values(search).some((value) => Array.isArray(value)) ? " with these filters" : ""}.</Empty>
      ) : (
        <div className="@container grid gap-6 p-4">
          <div className="grid gap-6 @5xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <div className="grid content-start gap-6">
              <Tiles all={data.all} previous={compare ? previous?.all : undefined} points={points} />
              <section className="grid gap-2">
                <Heading className="flex items-center gap-3">
                  Runs per day <Legend series={RUN_SERIES} />
                </Heading>
                <StackedBars points={points} series={RUN_SERIES} />
              </section>
              <section className="grid gap-2">
                <Heading>Cost per day</Heading>
                <LineChart points={points} series={COST_SERIES} format={(value) => (value === 0 ? "$0" : usd(value))} />
              </section>
            </div>
            <div className="grid content-start gap-6 @2xl:grid-cols-2 @5xl:grid-cols-1">
              <CountsTable
                title="By model"
                keyHeader="Model"
                cost
                rows={data.byModel.map((row) => ({
                  ...row,
                  key: `${row.modelInstanceId}/${row.modelId}/${row.reasoning}`,
                  label: row.reasoning ? `${row.modelId} · ${row.reasoning}` : row.modelId,
                  title: `${row.modelInstanceId} / ${row.modelId} / ${row.reasoning ?? "default reasoning"}`,
                  picked: picked("model", row.modelId),
                  onPick: () => toggleFilter("model", row.modelId),
                }))}
                empty="No runs that started a thread."
              />
              <CountsTable
                title="By author"
                keyHeader="Author"
                cost
                rows={data.byAuthor.map((row) => ({ ...row, key: row.author, label: row.author, picked: picked("author", row.author), onPick: () => toggleFilter("author", row.author) }))}
                empty="No reviews with an author. Connection tests are not counted here."
              />
              <CountsTable
                title="By trigger"
                keyHeader="Source"
                rows={sources.map((row) => ({ ...row, key: row.source, label: SOURCE_LABELS[row.source], picked: picked("source", row.source), onPick: () => toggleFilter("source", row.source) }))}
              />
            </div>
          </div>
          <StatsTable
            title="By prompt version"
            keyHeader="Prompt"
            rows={data.byPrompt.map((row) => ({
              ...row,
              key: promptKey(row),
              label: (
                <>
                  {row.name ? `${row.name} v${row.version}` : promptLabel(row)}
                  {row.live && <span className="text-muted-foreground"> live</span>}
                </>
              ),
              picked: picked("prompt", promptKey(row)),
              onPick: () => toggleFilter("prompt", promptKey(row)),
            }))}
            empty="No runs from a versioned prompt."
          />
        </div>
      )}
    </div>
  );
}

/** One point per day of the window, zero-filled; an open window starts at the first day with runs. */
function dayPoints(data: AnalyticsData, window: Window): Point[] {
  const byDay = new Map(data.byDay.map((row) => [row.day, row]));
  const first = window.from ? new Date(window.from) : data.byDay[0] ? new Date(`${data.byDay[0].day}T00:00:00`) : new Date();
  const last = window.to ? new Date(Date.parse(window.to) - 1) : new Date();
  const points: Point[] = [];
  for (const day = new Date(first.getFullYear(), first.getMonth(), first.getDate()); day <= last; day.setDate(day.getDate() + 1)) {
    const row = byDay.get(isoDay(day));
    points.push({
      label: day.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      values: {
        done: row?.done ?? 0,
        skipped: row?.skipped ?? 0,
        failed: row?.failed ?? 0,
        open: (row?.queued ?? 0) + (row?.started ?? 0),
        total: row?.total ?? 0,
        cost: row?.totalCostUsd ?? null,
        rating: row?.avgRating ?? null,
      },
    });
  }
  return points;
}

/** Which direction of change is good for a tile, for its tone; null when neither is. */
type Better = "up" | "down" | null;

/** The headline figures, each with a sparkline over the days and, when comparing, the change from the previous period. */
function Tiles({ all, previous, points }: { all: RunStats; previous?: RunStats; points: Point[] }) {
  const series = (key: string) => points.map((point) => point.values[key] ?? null);
  const pct = (part: number, whole: number) => (whole === 0 ? "-" : `${Math.round((part / whole) * 100)}%`);
  const tiles: { label: string; value: string; sub?: string; delta?: { value: number | null; text: string; better: Better }; trend: (number | null)[] }[] = [
    { label: "Runs", value: String(all.total), delta: change(all.total, previous?.total, "percent", null), trend: series("total") },
    { label: "Done", value: String(all.done), sub: `${pct(all.done, all.total)} of runs`, delta: change(all.done, previous?.done, "count", "up"), trend: series("done") },
    { label: "Failed", value: String(all.failed), sub: `${pct(all.failed, all.total)} of runs`, delta: change(all.failed, previous?.failed, "count", "down"), trend: series("failed") },
    {
      label: "Avg score",
      value: all.avgRating?.toFixed(1) ?? "-",
      sub: `${all.rated} scored`,
      delta: change(all.avgRating, previous?.avgRating, "score", "up"),
      trend: series("rating"),
    },
    {
      label: "Cost",
      value: all.totalCostUsd === null ? "-" : usd(all.totalCostUsd),
      sub: `${all.measured} measured`,
      delta: change(all.totalCostUsd, previous?.totalCostUsd, "usd", "down"),
      trend: series("cost"),
    },
    {
      label: "Avg cost",
      value: all.avgCostUsd === null ? "-" : usd(all.avgCostUsd),
      sub: all.avgOutputTokens === null ? undefined : `${tokenCount(all.avgOutputTokens)} out`,
      delta: change(all.avgCostUsd, previous?.avgCostUsd, "usd", "down"),
      trend: points.map((point) => (point.values.cost === null || !point.values.total ? null : point.values.cost! / point.values.total)),
    },
  ];
  const TONES: Record<"good" | "bad" | "flat", string> = { good: TONE_TEXT.ok, bad: TONE_TEXT.err, flat: "text-muted-foreground" };
  return (
    <div className="grid grid-cols-2 gap-px border-y bg-border sm:grid-cols-3">
      {tiles.map((tile) => {
        const sign = tile.delta?.value ? Math.sign(tile.delta.value) : 0;
        const verdict = !tile.delta?.better || sign === 0 ? "flat" : (sign > 0) === (tile.delta.better === "up") ? "good" : "bad";
        return (
          <div key={tile.label} className="grid gap-0.5 bg-background px-3 py-2.5">
            <span className="text-[11px] tracking-wide text-muted-foreground uppercase">{tile.label}</span>
            <span className="font-mono text-xl">{tile.value}</span>
            <span className="flex items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground">
              <span className="truncate">
                {tile.delta && <span className={TONES[verdict]}>{tile.delta.text}</span>}
                {tile.delta && tile.sub && " · "}
                {tile.sub}
              </span>
              <Sparkline values={tile.trend} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The change from the previous period, formatted; undefined when not comparing or either side has no value. */
function change(now: number | null, before: number | null | undefined, kind: "percent" | "count" | "score" | "usd", better: Better) {
  if (before === undefined || before === null || now === null) return undefined;
  const value = now - before;
  const signed = (text: string) => (value > 0 ? `+${text}` : value < 0 ? `-${text}` : "±0");
  const abs = Math.abs(value);
  const text =
    kind === "percent" ? (before === 0 ? signed(String(abs)) : signed(`${Math.round((abs / before) * 100)}%`)) : kind === "score" ? signed(abs.toFixed(1)) : kind === "usd" ? signed(usd(abs)) : signed(String(abs));
  return { value, text, better };
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

/** A breakdown row that can be picked as a filter. */
type Pickable = { key: string; picked?: boolean; onPick?: () => void };

function PickRow({ row, className, children }: { row: Pickable; className?: string; children: ReactNode }) {
  return (
    <TableRow
      data-state={row.picked ? "selected" : undefined}
      className={cn(row.onPick && "cursor-pointer", className)}
      onClick={row.onPick}
      title={row.onPick ? (row.picked ? "Remove this filter" : "Filter to this") : undefined}
    >
      {children}
    </TableRow>
  );
}

type StatsRow = RunStats & Pickable & { label: ReactNode };

/** Runs, score and usage per group; cache read is the share of input tokens served from the prompt cache. */
function StatsTable({ title, keyHeader, rows, empty }: { title: string; keyHeader: string; rows: StatsRow[]; empty: string }) {
  return (
    <section className="grid content-start gap-2">
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
              <PickRow key={row.key} row={row}>
                <TableCell className="font-mono">
                  <Share value={row.total} of={Math.max(...rows.map((r) => r.total))} />
                  {row.label}
                </TableCell>
                <TableFigure value={row.total} />
                <TableFigure value={row.rated} />
                <StatCell value={row.avgRating} format={(rating) => rating.toFixed(1)} className={row.avgRating !== null ? TONE_TEXT[scoreTone(row.avgRating)] : undefined} />
                <TableFigure value={row.measured} />
                <StatCell value={row.avgCostUsd} format={(cost) => usd(cost)} />
                <StatCell value={row.totalCostUsd} format={(cost) => usd(cost)} />
                <StatCell value={row.avgOutputTokens} format={tokenCount} />
                <StatCell value={cacheReadShare(row)} format={(share) => `${Math.round(share * 100)}%`} />
              </PickRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** A thin bar before a row's label: its runs against the table's largest group. */
function Share({ value, of }: { value: number; of: number }) {
  return (
    <span aria-hidden className="mr-2 inline-block h-1.5 w-10 bg-muted align-middle">
      <span className="block h-full bg-muted-foreground/60" style={{ width: `${(value / Math.max(of, 1)) * 100}%` }} />
    </span>
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

type CountsRow = RunCounts & Pickable & { label: string; title?: string; totalCostUsd?: number | null };

/** Run counts per group with done and failed split out; `cost` adds the estimated cost of the runs with usage measured. */
function CountsTable({ title, keyHeader, rows, empty, cost }: { title: string; keyHeader: string; rows: CountsRow[]; empty?: string; cost?: boolean }) {
  const most = Math.max(...rows.map((row) => row.total));
  return (
    <section className="grid content-start gap-2">
      <Heading>{title}</Heading>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-full">{keyHeader}</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">Done</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              {cost && <TableHead className="text-right">Cost</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <PickRow key={row.key} row={row} className={cn(row.total === 0 && "text-muted-foreground")}>
                <TableCell className="max-w-0 truncate font-mono" title={row.title}>
                  <Share value={row.total} of={most} />
                  {row.label}
                </TableCell>
                <TableFigure value={row.total} />
                <TableFigure value={row.done} tone="ok" />
                <TableFigure value={row.failed} tone="err" />
                {cost && <StatCell value={row.totalCostUsd ?? null} format={(total) => usd(total)} />}
              </PickRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
