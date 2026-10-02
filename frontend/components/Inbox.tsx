import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DispatchDialog } from "@/components/DispatchDialog";
import { Empty, ExternalLink, GroupLabel, RunStatus } from "@/components/Field";
import { Count, Toolbar, ToolbarDivider } from "@/components/Toolbar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, timeAgo } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { InboxItem, InboxResponse, InboxRun } from "../../src/inbox.ts";
import type { PollStatus } from "../../src/poller.ts";
import { INBOX_REASON_LABELS, INBOX_REASONS, INBOX_SOURCES, type InboxKind, type InboxReason, type InboxSource } from "../../src/shared.ts";

type Row = InboxResponse["items"][number];

const ALL = "all";
const mono = "font-mono text-xs";

/**
 * Polled PRs and issues grouped by why they involve you. Each row dispatches
 * on its own; checkboxes dispatch several with one composed prompt. Polls on
 * the run log's cadence.
 */
export function Inbox() {
  const queryClient = useQueryClient();
  const [showGone, setShowGone] = useState(false);
  const { data } = useQuery({
    queryKey: showGone ? ["inbox", "gone"] : ["inbox"],
    queryFn: () => api<InboxResponse>(showGone ? "/api/inbox?gone=1" : "/api/inbox"),
    refetchInterval: 5000,
  });
  const [source, setSource] = useState<InboxSource | typeof ALL>(ALL);
  const [kind, setKind] = useState<InboxKind | typeof ALL>(ALL);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [dispatching, setDispatching] = useState<InboxItem[] | null>(null);

  if (!data) {
    return (
      <div className="flex min-h-full flex-col">
        <Toolbar title="Inbox" />
        <Empty>Loading…</Empty>
      </div>
    );
  }

  const query = search.trim().toLowerCase();
  const visible = data.items.filter(
    (item) =>
      (source === ALL || item.source === source) &&
      (kind === ALL || item.kind === kind) &&
      (!query || [item.repo, item.identifier, item.title, item.author, item.state, item.team, ...item.labels].some((field) => field?.toLowerCase().includes(query))),
  );
  // An item sits under its first reason in display order and notes the others; departed items close the list.
  const groups = [
    ...INBOX_REASONS.map((reason) => ({ key: reason, label: INBOX_REASON_LABELS[reason], items: visible.filter((item) => !item.goneAt && firstReason(item) === reason) })),
    { key: "gone", label: "left the inbox", items: visible.filter((item) => item.goneAt) },
  ].filter((group) => group.items.length > 0);
  const count = (predicate: (item: Row) => boolean) => data.items.filter((item) => !item.goneAt).filter(predicate).length;
  const selectedItems = data.items.filter((item) => selected.includes(item.key));
  const toggle = (key: string, on: boolean) => setSelected((keys) => (on ? [...keys, key] : keys.filter((k) => k !== key)));
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["inbox"] });

  return (
    <div className="flex min-h-full flex-col">
      <Toolbar title="Inbox">
        <Count value={count(() => true)} label="all" active={source === ALL} onClick={() => setSource(ALL)} />
        {INBOX_SOURCES.map((s) => <Count key={s} value={count((item) => item.source === s)} label={s} active={source === s} onClick={() => setSource(s)} />)}
        <ToolbarDivider />
        <Count value={count((item) => item.kind === "pull_request")} label="PRs" active={kind === "pull_request"} onClick={() => setKind(kind === "pull_request" ? ALL : "pull_request")} />
        <Count value={count((item) => item.kind === "issue")} label="issues" active={kind === "issue"} onClick={() => setKind(kind === "issue" ? ALL : "issue")} />
        <ToolbarDivider />
        <Count value={data.gone} label="left" active={showGone} onClick={() => setShowGone((v) => !v)} title="Items that stopped showing up: closed, merged, unassigned or done. Kept 30 days." />
        <Input className="h-7 w-44 text-xs" placeholder="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="ml-auto flex items-center gap-3">
          {INBOX_SOURCES.map((s) => <PollState key={s} source={s} status={data.polling[s]} onPolled={refresh} />)}
          <Button size="xs" variant={selected.length > 0 ? "default" : "outline"} disabled={selected.length === 0} onClick={() => setDispatching(selectedItems)}>
            Dispatch selected{selected.length > 0 ? ` (${selected.length})` : ""}
          </Button>
        </span>
      </Toolbar>

      {visible.length === 0 ? (
        <Empty>
          {data.items.length === 0
            ? "Nothing in the inbox. GitHub polls through the gh CLI; set LINEAR_API_KEY in .env for Linear. Intervals are in Settings."
            : "Nothing matches these filters."}
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-7" />
              <TableHead>Item</TableHead>
              <TableHead className="w-full">Title</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead className="text-right">In inbox</TableHead>
              <TableHead className="text-right">Updated</TableHead>
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
                  </TableCell>
                  <TableCell><LastRun run={item.lastRun} /></TableCell>
                  <TableCell className="text-right text-muted-foreground" title={`first seen ${new Date(item.firstSeenAt).toLocaleString()} · last seen ${new Date(item.lastSeenAt).toLocaleString()}`}>
                    {item.goneAt ? `left ${timeAgo(item.goneAt)}` : since(item.firstSeenAt)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground" title={new Date(item.updatedAt).toLocaleString()}>{timeAgo(item.updatedAt)}</TableCell>
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
    return <span className={cn("text-muted-foreground", mono)} title={source === "linear" ? "Set LINEAR_API_KEY in .env" : "Install and log in to the gh CLI"}>{source} off</span>;
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
