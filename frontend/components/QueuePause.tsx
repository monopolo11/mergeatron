import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePause } from "lucide-react";
import { use, useEffect, useState } from "react";
import { ExternalLink } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { timeUntil } from "@/lib/format";
import { ShellContext } from "@/lib/shell";
import type { QueuePause } from "../../src/rules.ts";

const QUERY_KEY = ["queue-pause"];

/** An ISO time as a `datetime-local` value, in the browser's time zone: `2026-10-26T12:30`. */
function localInput(iso: string): string {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * Shown above every page while the queue is paused because a thread ran out
 * of usage: why, when it resumes on its own (the provider's reset time unless
 * rescheduled), a picker to move that time, and a button to resume now.
 */
export function QueuePauseBanner() {
  const { runs, refreshRuns } = use(ShellContext)!;
  const queryClient = useQueryClient();
  const { data: pause } = useQuery({ queryKey: QUERY_KEY, queryFn: () => api<QueuePause | null>("/api/queue/pause"), refetchInterval: 5000 });
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The picker shows the scheduled time, and follows it when it moves.
  useEffect(() => setPicked(pause?.resumeAt ? localInput(pause.resumeAt) : ""), [pause?.resumeAt]);
  if (!pause) return null;

  const send = (init: RequestInit) => {
    setBusy(true);
    setError(null);
    api<QueuePause | null>("/api/queue/pause", init)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
        refreshRuns();
      })
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };
  // A `datetime-local` value has no zone, so Date reads it as local time.
  const reschedule = () => send({ method: "PUT", body: JSON.stringify({ resumeAt: new Date(picked).toISOString() }) });
  const resumeNow = () => send({ method: "DELETE" });
  const waiting = runs.filter((run) => run.status === "queued").length;
  const unchanged = pause.resumeAt !== null && picked === localInput(pause.resumeAt);

  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
      <CirclePause className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          Queue paused: usage ran out
          {pause.resumeAt ? (
            <span title={new Date(pause.resumeAt).toLocaleString()}>
              {" "}· resumes {new Date(pause.resumeAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ({timeUntil(pause.resumeAt)})
            </span>
          ) : (
            " · resumes when you resume it"
          )}
        </p>
        <p className="wrap-anywhere text-muted-foreground">
          {pause.reason}
          {pause.threadUrl && (
            <>
              {" · "}
              <ExternalLink href={pause.threadUrl}>open thread</ExternalLink>
            </>
          )}
          {waiting > 0 && ` · ${waiting} ${waiting === 1 ? "run" : "runs"} waiting`}
          {error && <span className="text-destructive"> · {error}</span>}
        </p>
      </div>
      <Input type="datetime-local" aria-label="Resume at" value={picked} onChange={(event) => setPicked(event.target.value)} className="h-7 w-auto text-xs" />
      <Button size="xs" variant="outline" disabled={busy || picked === "" || unchanged} onClick={reschedule}>
        Reschedule resume
      </Button>
      <Button size="xs" disabled={busy} onClick={resumeNow}>
        Resume now
      </Button>
    </div>
  );
}
