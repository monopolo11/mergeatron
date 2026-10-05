import { Link } from "@tanstack/react-router";
import { Dot } from "@/components/Field";
import { Button } from "@/components/ui/button";
import type { Status } from "@/lib/api";
import type { Tone } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { UpdateStatus } from "../../src/update.ts";

const NAV = [
  { to: "/", label: "Rules" },
  { to: "/inbox", label: "Inbox" },
  { to: "/runs", label: "Runs" },
  { to: "/reviews", label: "Reviews" },
  { to: "/analytics", label: "Analytics" },
  { to: "/settings", label: "Settings" },
] as const;

/**
 * Wordmark, navigation, connection health and the live run panel toggle. Health is
 * a dot and a word per connection; the word only says more when something
 * needs attention. Details and actions live in Settings.
 */
export function Header({
  status,
  update,
  running,
  runsOpen,
  onToggleRuns,
}: {
  status: Status | null;
  update: UpdateStatus | null;
  /** Threads running right now, shown on the Live toggle. */
  running: number;
  runsOpen: boolean;
  /** Absent where the panel does not show (the Runs page), which hides the toggle. */
  onToggleRuns?: () => void;
}) {
  return (
    <header className="flex h-10 min-w-0 items-center gap-4 overflow-hidden border-b px-3">
      <Link to="/" className="text-[13px] font-semibold whitespace-nowrap">mergeatron</Link>
      <nav className="flex h-full gap-1">
        {NAV.map(({ to, label }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact: true, includeSearch: false }}
            className="flex h-full items-center border-b-2 border-transparent px-2 text-[13px] text-muted-foreground hover:text-foreground"
            activeProps={{ className: "border-foreground text-foreground" }}
          >
            {label}
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex min-w-0 items-center gap-3 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
        {connectionHealth(status).map((item) => (
          <Link key={item.key} to="/settings" hash="connection" title={item.title} className="hover:text-foreground">
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
      </div>
      {onToggleRuns && (
        <Button size="xs" variant="ghost" aria-pressed={runsOpen} className={cn("hidden lg:inline-flex", runsOpen && "bg-muted")} onClick={onToggleRuns}>
          Live
          {running > 0 && <span className="font-mono text-active">{running}</span>}
        </Button>
      )}
    </header>
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
