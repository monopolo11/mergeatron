import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Dot } from "@/components/Field";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, timeAgo, type Status } from "@/lib/api";
import { timeUntil } from "@/lib/format";
import type { Tone } from "@/lib/status";
import { cn } from "@/lib/utils";
import logo from "../favicon.svg";
import type { InboxResponse } from "../../src/inbox.ts";
import { INBOX_SOURCES } from "../../src/shared.ts";
import type { PullRequestSummary } from "../../src/store.ts";
import type { UpdateStatus } from "../../src/update.ts";

/**
 * The app's left column: logo, navigation with live counts (open inbox items,
 * running runs, paused reviews), the inbox's next poll under Inbox, and
 * connection health, the update notice and the live run panel toggle at the
 * bottom. Health details and actions live in Settings.
 */
export function Sidebar({
  status,
  update,
  running,
  runsOpen,
  onToggleRuns,
}: {
  status: Status | null;
  update: UpdateStatus | null;
  /** Threads running right now. */
  running: number;
  runsOpen: boolean;
  /** Absent where the panel does not show (the Runs page), which hides the toggle. */
  onToggleRuns?: () => void;
}) {
  // Same keys as the Inbox and Reviews pages' unfiltered queries, so the counts share their polling.
  const { data: inbox } = useQuery({ queryKey: ["inbox"], queryFn: () => api<InboxResponse>("/api/inbox"), refetchInterval: 5000 });
  const { data: pulls } = useQuery({ queryKey: ["pulls", "all"], queryFn: () => api<PullRequestSummary[]>("/api/pulls"), refetchInterval: 15_000 });
  const open = inbox?.items.filter((item) => !item.goneAt).length;
  const paused = pulls?.filter((pull) => pull.status === "paused").length;

  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto border-r text-[13px]">
      <Link to="/" className="flex h-11 shrink-0 items-center gap-2 border-b px-3 font-semibold">
        <img src={logo} alt="" className="size-5" />
        mergeatron
      </Link>
      <nav className="grid py-1">
        <NavItem to="/">Rules</NavItem>
        <NavItem to="/inbox" count={open || null}>Inbox</NavItem>
        {inbox && <NextPoll polling={inbox.polling} />}
        <NavItem to="/runs" count={running || null} tone="active">Runs</NavItem>
        <NavItem to="/reviews" count={paused || null} tone="warn" title="Paused reviews">Reviews</NavItem>
        <NavItem to="/analytics">Analytics</NavItem>
        <NavItem to="/settings">Settings</NavItem>
      </nav>
      <div className="mt-auto grid gap-1 border-t px-3 py-2.5 text-xs text-muted-foreground">
        {connectionHealth(status).map((item) => (
          <Link key={item.key} to="/settings" hash="connection" title={item.title} className="truncate hover:text-foreground">
            <Dot tone={item.tone} />
            {item.label}
          </Link>
        ))}
        {update && update.commits.length > 0 && (
          <Link to="/settings" hash="connection" className="text-foreground hover:underline">
            <Dot tone="warn" />
            update · {update.commits.length}
          </Link>
        )}
        {onToggleRuns && (
          <button
            type="button"
            aria-pressed={runsOpen}
            onClick={onToggleRuns}
            className={cn("mt-1 hidden items-center justify-between border-t pt-2 text-left hover:text-foreground lg:flex", runsOpen && "text-foreground")}
          >
            Live panel
            {running > 0 && <span className="font-mono text-active">{running}</span>}
          </button>
        )}
      </div>
    </aside>
  );
}

function NavItem({ to, count, tone, title, children }: { to: "/" | "/inbox" | "/runs" | "/reviews" | "/analytics" | "/settings"; count?: number | null; tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true, includeSearch: false }}
      className="flex items-center justify-between px-3 py-1.5 text-muted-foreground hover:text-foreground"
      activeProps={{ className: "bg-muted/60 text-foreground shadow-[inset_2px_0_0_var(--foreground)]" }}
    >
      {children}
      {count != null && <span className={cn("font-mono text-xs", tone === "active" && "text-active", tone === "warn" && "text-warn")} title={title}>{count}</span>}
    </Link>
  );
}

/**
 * One line under Inbox: the soonest next poll of the enabled sources, and any
 * source whose last poll failed. Hover lists each source; click polls them all.
 */
function NextPoll({ polling }: { polling: InboxResponse["polling"] }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const sources = INBOX_SOURCES.map((source) => ({ source, ...polling[source] })).filter((status) => status.configured);
  if (sources.length === 0) return null;

  const failing = sources.filter((status) => status.lastError);
  const next = sources
    .filter((status) => status.enabled && status.nextAt)
    .map((status) => status.nextAt!)
    .sort()[0];
  const state = busy || sources.some((status) => status.polling) ? "polling…" : next ? `next poll ${timeUntil(next)}` : "polling off";
  const pollAll = () => {
    setBusy(true);
    Promise.allSettled(sources.map(({ source }) => api("/api/inbox/poll", { method: "POST", body: JSON.stringify({ source }) }))).finally(() => {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" disabled={busy} onClick={pollAll} className="flex justify-between gap-2 py-0.5 pr-3 pl-5 text-left text-[11px] text-muted-foreground hover:text-foreground">
          <span className="truncate">{state}</span>
          {failing.length > 0 && <span className="truncate text-destructive">{failing.map((status) => status.source).join(", ")} failed</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="grid w-80 gap-1 p-2 text-xs">
        {sources.map((status) => (
          <div key={status.source} className={cn("grid grid-cols-[56px_minmax(0,1fr)_auto] gap-2", status.lastError && "text-destructive")}>
            <span>{status.source}</span>
            <span className={cn("truncate", !status.lastError && "opacity-70")}>
              {status.lastError ?? `${status.items} items${status.lastPolledAt ? ` · polled ${timeAgo(status.lastPolledAt)}` : ""}`}
            </span>
            <span className="font-mono">{status.polling ? "polling" : !status.enabled ? "off" : status.nextAt ? timeUntil(status.nextAt) : "-"}</span>
          </div>
        ))}
        <div className="mt-1 border-t pt-1 opacity-70">Click to poll all now</div>
      </TooltipContent>
    </Tooltip>
  );
}

/** One entry per connection; the label stays a single word while healthy. */
function connectionHealth(status: Status | null): { key: string; label: string; tone: Tone; title: string }[] {
  if (!status) return [{ key: "t3", label: "connecting…", tone: "idle", title: "Loading status" }];
  const environment = status.t3.environment;
  return [
    environment
      ? { key: "t3", label: "t3", tone: "ok", title: `${environment.label} · ${environment.serverVersion} · ${status.t3.origin}` }
      : { key: "t3", label: "t3 unreachable", tone: "err", title: status.t3.origin },
    status.webhookSecretConfigured
      ? { key: "webhook", label: "webhook", tone: "ok", title: "Webhook secret set" }
      : { key: "webhook", label: "webhook secret not set", tone: "warn", title: "Set GITHUB_WEBHOOK_SECRET in .env" },
    status.slack === "connected"
      ? { key: "slack", label: "slack", tone: "ok", title: "Socket Mode connected" }
      : status.slack === "connecting"
        ? { key: "slack", label: "slack connecting", tone: "warn", title: "Socket Mode connecting" }
        : { key: "slack", label: "slack off", tone: "idle", title: "Set SLACK_APP_TOKEN and SLACK_BOT_TOKEN" },
  ];
}
