import { RUN_SOURCES, RUN_STATUSES, type RunSource, type RunStatus } from "../../src/shared.ts";

/*
 * The date range and run filters every page reads from the URL. They live in
 * the root route's search params and are retained across navigation, so a
 * range picked on Analytics still applies on Runs. Pages pass `scopeQuery` to
 * the run-based endpoints (see RunScopeQuery in src/rules.ts).
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const RANGE_PRESETS = {
  "24h": { label: "Last 24 hours", ms: DAY },
  "7d": { label: "Last 7 days", ms: 7 * DAY },
  "14d": { label: "Last 14 days", ms: 14 * DAY },
  "30d": { label: "Last 30 days", ms: 30 * DAY },
  "90d": { label: "Last 90 days", ms: 90 * DAY },
  month: { label: "This month", ms: null },
  all: { label: "All time", ms: null },
} as const;
export type RangePreset = keyof typeof RANGE_PRESETS;
export const DEFAULT_RANGE: RangePreset = "14d";

/** Run facets a page can filter on, in the order the filter menu lists them. */
export const RUN_FACETS = ["runStatus", "rule", "source", "model", "prompt", "author", "repo"] as const;
export type RunFacet = (typeof RUN_FACETS)[number];

/**
 * The shared search params. `range` is a preset; `from`/`to` (`YYYY-MM-DD`,
 * both days included) replace it with a custom range. Facets hold any-of
 * value lists; `live` keeps runs on a live prompt version; `notRunStatus`
 * makes `runStatus` the statuses to leave out ("all runs not skipped").
 */
export type ScopeSearch = {
  range?: RangePreset;
  from?: string;
  to?: string;
  live?: true;
  notRunStatus?: true;
} & { [Facet in RunFacet]?: Facet extends "source" ? RunSource[] : Facet extends "runStatus" ? RunStatus[] : string[] };

/** The search params the root route keeps when navigating between pages. */
export const SCOPE_KEYS = ["range", "from", "to", "live", "notRunStatus", ...RUN_FACETS] as const satisfies (keyof ScopeSearch)[];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day in `YYYY-MM-DD`: the parts round-trip, so no month 13 or Feb 30. */
const isDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [year, month, date] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(year, month - 1, date);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === date;
};
const strings = (value: unknown) => {
  const list = (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string" && item !== "");
  return list.length > 0 ? list : undefined;
};

/** Validates the shared search params; unknown values are dropped. */
export function validateScope(search: Record<string, unknown>): ScopeSearch {
  const range = Object.keys(RANGE_PRESETS).find((key): key is RangePreset => key === search.range);
  const date = (value: unknown) => (isDay(value) ? value : undefined);
  const sources = strings(search.source)?.filter((value): value is RunSource => RUN_SOURCES.some((source) => source === value));
  const statuses = strings(search.runStatus)?.filter((value): value is RunStatus => RUN_STATUSES.some((status) => status === value));
  return {
    range,
    from: date(search.from),
    to: date(search.to),
    live: search.live === true ? true : undefined,
    runStatus: statuses?.length ? statuses : undefined,
    notRunStatus: statuses?.length && search.notRunStatus === true ? true : undefined,
    rule: strings(search.rule),
    source: sources?.length ? sources : undefined,
    model: strings(search.model),
    prompt: strings(search.prompt),
    author: strings(search.author),
    repo: strings(search.repo),
  };
}

/** A resolved window: ISO bounds (null when open) and how to name it. */
export type Window = { from: string | null; to: string | null; label: string; detail: string | null };

const day = (iso: string) => new Date(`${iso}T00:00:00`);
const short = (date: Date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The window the search names, as of `now`. A custom range runs from the start of `from` to the end of `to`, local time. */
export function resolveWindow({ range, from, to }: Pick<ScopeSearch, "range" | "from" | "to">, now = new Date()): Window {
  if (from && to) {
    const end = day(to);
    end.setDate(end.getDate() + 1);
    return { from: day(from).toISOString(), to: end.toISOString(), label: from === to ? short(day(from)) : `${short(day(from))} to ${short(day(to))}`, detail: null };
  }
  const preset = range ?? DEFAULT_RANGE;
  const { label, ms } = RANGE_PRESETS[preset];
  if (preset === "all") return { from: null, to: null, label, detail: null };
  const start = preset === "month" ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now.getTime() - ms!);
  return { from: start.toISOString(), to: null, label, detail: preset === "24h" ? null : `${short(start)} to ${short(now)}` };
}

/** The window of the same length just before this one; null for an open-ended start. */
export function previousWindow(window: Window, now = new Date()): Window | null {
  if (!window.from) return null;
  const start = Date.parse(window.from);
  const end = window.to ? Date.parse(window.to) : now.getTime();
  return { from: new Date(start - (end - start)).toISOString(), to: window.from, label: "previous period", detail: null };
}

/** Query string for the run-based endpoints: the window and the facets, comma separated. */
export function scopeQuery(search: ScopeSearch, window: Window, extra: Record<string, string | undefined> = {}): string {
  const params = {
    from: window.from ?? undefined,
    to: window.to ?? undefined,
    live: search.live ? "1" : undefined,
    notRunStatus: search.runStatus?.length && search.notRunStatus ? "1" : undefined,
    ...Object.fromEntries(RUN_FACETS.map((facet) => [facet, search[facet]?.join(",")])),
    ...extra,
  };
  return new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString();
}

/** The query key part for a scope: the search itself, so a preset window moves with each refetch instead of each render. */
export function scopeKey(search: ScopeSearch) {
  return Object.fromEntries(SCOPE_KEYS.map((key) => [key, search[key]]));
}

/** `YYYY-MM-DD` for a local date. */
export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
