import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { DispatchDialog } from "@/components/DispatchDialog";
import { Empty, ExternalLink, GroupLabel, RunStatus } from "@/components/Field";
import { FilterBar, useScope, type Facet } from "@/components/FilterBar";
import { Count, PageHeader } from "@/components/Toolbar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, timeAgo } from "@/lib/api";
import { resolveWindow } from "@/lib/scope";
import { cn } from "@/lib/utils";
import type { InboxItem, InboxResponse, InboxRun } from "../../src/inbox.ts";
import type { PollStatus } from "../../src/poller.ts";
import { INBOX_KINDS, INBOX_REASON_LABELS, INBOX_REASONS, INBOX_SOURCE_SETUP, INBOX_SOURCES, type InboxKind, type InboxReason, type InboxSource } from "../../src/shared.ts";

type Row = InboxResponse["items"][number];

const mono = "font-mono text-xs";
/** Columns shown only on a wide table (72rem); narrower, the last run moves under the title and the timestamps drop. */
const ROOMY = "hidden @6xl:table-cell";
const KIND_LABELS: Record<InboxKind, string> = { pull_request: "PR", issue: "Issue" };

/** `/inbox` search: the inbox's own facets (the repo facet and range are shared, see lib/scope.ts), and whether to list items that left. */
export type InboxSearch = { feed?: InboxSource[]; kind?: InboxKind[]; reason?: InboxReason[]; gone?: true };

const listOf = <T extends string>(options: readonly T[], value: unknown) => {
  const list = (Array.isArray(value) ? value : [value]).filter((item): item is T => options.some((option) => option === item));
  return list.length > 0 ? list : undefined;
};

export const validateInboxSearch = (search: Record<string, unknown>): InboxSearch => ({
  feed: listOf(INBOX_SOURCES, search.feed),
  kind: listOf(INBOX_KINDS, search.kind),
  reason: listOf(INBOX_REASONS, search.reason),
  gone: search.gone === true ? true : undefined,
});

/**
 * Polled PRs and issues updated in the range, grouped by why they involve
 * you, filtered by source, kind, reason and repo. Each row dispatches on its
 * own; checkboxes dispatch several with one composed prompt. Polls on the run
 * log's cadence.
 */
export function Inbox() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { search: scope, setScope } = useScope();
  const search = useSearch({ from: "/inbox" });
  const { data } = useQuery({
    queryKey: search.gone ? ["inbox", "gone"] : ["inbox"],
    queryFn: () => api<InboxResponse>(search.gone ? "/api/inbox?gone=1" : "/api/inbox"),
    refetchInterval: 5000,
  });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [dispatching, setDispatching] = useState<InboxItem[] | null>(null);
  const setSearch = (patch: Partial<InboxSearch>) => void navigate({ to: "/inbox", search: (prev: InboxSearch) => ({ ...prev, ...patch }), replace: true });

  const { from, to } = resolveWindow(scope);
  const inRange = (item: Row) => (!from || item.updatedAt >= from) && (!to || item.updatedAt < to);
  const ranged = (data?.items ?? []).filter(inRange);
  const current = ranged.filter((item) => !item.goneAt);
  const tally = (key: (item: Row) => readonly string[]) => {
    const counts = new Map<string, number>();
    for (const item of current) for (const value of key(item)) counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
  };
  const facet = <T extends string>(key: string, label: string, values: readonly T[], selected: readonly T[] | undefined, counts: Map<string, number>, text: (value: T) => string, onChange: (values: T[]) => void): Facet => ({
    key,
    label,
    options: values.map((value) => ({ value, text: text(value), count: counts.get(value) ?? 0 })),
    selected: selected ?? [],
    onChange: (next) => onChange(values.filter((value) => next.includes(value))),
  });
  const repoCounts = tally((item) => (item.repo ? [item.repo] : []));
  const facets: Facet[] = [
    facet("feed", "Source", INBOX_SOURCES, search.feed, tally((item) => [item.source]), (value) => value, (feed) => setSearch({ feed: feed.length ? feed : undefined })),
    facet("kind", "Kind", INBOX_KINDS, search.kind, tally((item) => [item.kind]), (value) => KIND_LABELS[value], (kind) => setSearch({ kind: kind.length ? kind : undefined })),
    facet("reason", "Reason", INBOX_REASONS, search.reason, tally((item) => item.reasons), (value) => INBOX_REASON_LABELS[value], (reason) => setSearch({ reason: reason.length ? reason : undefined })),
    facet("repo", "Repo", [...repoCounts.keys()].sort(), scope.repo, repoCounts, (value) => value, (repo) => setScope({ repo: repo.length ? repo : undefined })),
  ];

  const needle = query.trim().toLowerCase();
  const visible = ranged.filter(
    (item) =>
      (!search.feed || search.feed.includes(item.source)) &&
      (!search.kind || search.kind.includes(item.kind)) &&
      (!search.reason || item.reasons.some((reason) => search.reason!.includes(reason))) &&
      (!scope.repo || (item.repo !== null && scope.repo.includes(item.repo))) &&
      (!needle || [item.repo, item.identifier, item.title, item.author, item.state, item.team, ...item.labels, ...item.tags].some((field) => field?.toLowerCase().includes(needle))),
  );
  // An item sits under its first reason in display order and notes the others; departed items close the list.
  const groups = [
    ...INBOX_REASONS.map((reason) => ({ key: reason, label: INBOX_REASON_LABELS[reason], items: visible.filter((item) => !item.goneAt && firstReason(item) === reason) })),
    { key: "gone", label: "left the inbox", items: visible.filter((item) => item.goneAt) },
  ].filter((group) => group.items.length > 0);
  // Only what is listed dispatches: a selection the range or filters hide is left out.
  const selectedItems = visible.filter((item) => selected.includes(item.key));
  const toggle = (key: string, on: boolean) => setSelected((keys) => (on ? [...keys, key] : keys.filter((k) => k !== key)));
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["inbox"] });

  return (
    <div className="@container flex min-h-full flex-col">
      <PageHeader
        title="Inbox"
        summary={data && `${visible.filter((item) => !item.goneAt).length} items`}
        filters={
          <FilterBar facets={facets}>
            <Input className="h-6 w-44 text-xs" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Button size="xs" variant={selectedItems.length > 0 ? "default" : "outline"} disabled={selectedItems.length === 0} onClick={() => setDispatching(selectedItems)}>
              Dispatch selected{selectedItems.length > 0 ? ` (${selectedItems.length})` : ""}
            </Button>
          </FilterBar>
        }
        toggles={
          data && (
            <>
              <span className="flex gap-3 px-1.5">
                {INBOX_SOURCES.map((source) => <PollState key={source} source={source} status={data.polling[source]} onPolled={refresh} />)}
              </span>
              <span className="ml-auto" />
              <Count value={data.gone} label="left" active={!!search.gone} onClick={() => setSearch({ gone: search.gone ? undefined : true })} title="Dispatched items that stopped showing up: closed, merged, resolved or done. Kept 30 days." />
            </>
          )
        }
      />

      {!data ? (
        <Empty>Loading…</Empty>
      ) : visible.length === 0 ? (
        <Empty>
          {data.items.length === 0
            ? "Nothing in the inbox. GitHub polls through the gh CLI; set LINEAR_API_KEY in .env for Linear, SENTRY_AUTH_TOKEN and SENTRY_ORG for Sentry. Intervals and Sentry filters are in Settings."
            : "Nothing updated in this range matches these filters."}
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-7" />
              <TableHead>Item</TableHead>
              <TableHead className="w-full">Title</TableHead>
              <TableHead className={ROOMY}>Last run</TableHead>
              <TableHead className={cn(ROOMY, "text-right")}>In inbox</TableHead>
              <TableHead className={cn(ROOMY, "text-right")}>Updated</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          {groups.map((group) => (
            <TableBody key={group.key}>
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="pt-3 pb-1">
                  <GroupLabel>{group.label} · {group.items.length}</GroupLabel>
                </TableCell>
              </TableRow>
              {group.items.map((item) => (
                <TableRow key={item.key} data-state={selected.includes(item.key) ? "selected" : undefined} className={cn(item.goneAt && "text-muted-foreground/70")}>
                  <TableCell><Checkbox checked={selected.includes(item.key)} onCheckedChange={(v) => toggle(item.key, v === true)} /></TableCell>
                  <TableCell className={mono}>
                    <ExternalLink href={item.url}>{item.repo ? `${item.repo} ${item.identifier}` : item.identifier}</ExternalLink>
                  </TableCell>
                  <TableCell className="max-w-0">
                    <div className="truncate" title={item.title}>{item.title}</div>
                    <div className="truncate text-muted-foreground">{meta(item)}</div>
                    {item.lastRun && <div className="truncate @6xl:hidden"><LastRun run={item.lastRun} /></div>}
                  </TableCell>
                  <TableCell className={ROOMY}><LastRun run={item.lastRun} /></TableCell>
                  <TableCell className={cn(ROOMY, "text-right text-muted-foreground")} title={`first seen ${new Date(item.firstSeenAt).toLocaleString()} · last seen ${new Date(item.lastSeenAt).toLocaleString()}`}>
                    {item.goneAt ? `left ${timeAgo(item.goneAt)}` : since(item.firstSeenAt)}
                  </TableCell>
                  <TableCell className={cn(ROOMY, "text-right text-muted-foreground")} title={new Date(item.updatedAt).toLocaleString()}>{timeAgo(item.updatedAt)}</TableCell>
                  <TableCell className="text-right"><Button size="xs" variant="outline" onClick={() => setDispatching([item])}>Dispatch</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          ))}
        </Table>
      )}

      {dispatching && (
        <DispatchDialog
          items={dispatching}
          onClose={() => setDispatching(null)}
          onDispatched={() => { setSelected([]); refresh(); }}
        />
      )}
    </div>
  );
}

function firstReason(item: InboxItem): InboxReason {
  return INBOX_REASONS.find((reason) => item.reasons.includes(reason)) ?? item.reasons[0] ?? "mentioned";
}

/** Author, state, labels, team and priority on one dim line, plus the reasons the row is not grouped under. */
function meta(item: InboxItem): string {
  const others = item.reasons.filter((reason) => reason !== firstReason(item)).map((reason) => INBOX_REASON_LABELS[reason]);
  return [
    item.author,
    item.kind === "issue" && item.source === "github" ? "issue" : null,
    item.state,
    item.labels.join(", ") || null,
    item.team,
    item.priority,
    item.reviewDecision && item.reviewDecision !== "REVIEW_REQUIRED" ? item.reviewDecision.toLowerCase().replace("_", " ") : null,
    others.length > 0 ? `also ${others.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "4 min", "2 h", "3 d": how long an item has been in the inbox. */
function since(iso: string): string {
  return timeAgo(iso).replace(" ago", "").replace("just now", "now");
}

/** One source's polling state; click polls now. */
function PollState({ source, status, onPolled }: { source: InboxSource; status: PollStatus; onPolled: () => void }) {
  const [busy, setBusy] = useState(false);
  const poll = () => {
    setBusy(true);
    api(`/api/inbox/poll`, { method: "POST", body: JSON.stringify({ source }) }).finally(() => { setBusy(false); onPolled(); });
  };
  if (!status.configured) {
    return <span className={cn("text-muted-foreground", mono)} title={INBOX_SOURCE_SETUP[source]}>{source} off</span>;
  }
  const text = busy || status.polling ? "polling…" : status.lastError ? "error" : status.lastPolledAt ? timeAgo(status.lastPolledAt) : "not yet";
  const title = [status.login && `as ${status.login}`, status.lastError, status.nextAt && status.enabled && `next ${timeAgo(status.nextAt).replace(" ago", "")}`, !status.enabled && "polling off in Settings", "click to poll now"].filter(Boolean).join(" · ");
  return (
    <button type="button" onClick={poll} disabled={busy} title={title} className={cn("text-muted-foreground hover:text-foreground", mono, status.lastError && "text-destructive")}>
      {source} {status.items} · {text}
    </button>
  );
}

function LastRun({ run }: { run: InboxRun | null }) {
  if (!run) return <span className="text-muted-foreground/60">never</span>;
  return (
    <RunStatus run={run}>
      <span title={`${run.ruleName}: ${run.detail}`}>{run.ruleName} · {timeAgo(run.createdAt)}</span>
      {run.threadUrl && (
        <>
          {" · "}
          <ExternalLink href={run.threadUrl}>thread</ExternalLink>
        </>
      )}
    </RunStatus>
  );
}
