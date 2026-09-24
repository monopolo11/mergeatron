import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, type Status } from "@/lib/api";
import { saveLabel, useAutosave } from "@/lib/useAutosave";
import { cn } from "@/lib/utils";
import type { Settings } from "../../src/rules.ts";
import { DEFAULT_HANDOFF_PROMPT, HANDOFF_TEMPLATE_VARS, RUNTIME_MODES } from "../../src/shared.ts";
import type { T3Project, T3Provider } from "../../src/t3.ts";
import type { UpdateResult, UpdateStatus } from "../../src/update.ts";
import { ModelPicker } from "@/components/ModelPicker";

export function Dot({ tone }: { tone: "ok" | "warn" | "err" | "idle" }) {
  return (
    <i
      className={cn(
        "mr-1.5 inline-block size-[7px] rounded-full align-middle",
        tone === "ok" && "bg-ok",
        tone === "warn" && "bg-warn",
        tone === "err" && "bg-destructive",
        tone === "idle" && "bg-muted-foreground",
      )}
    />
  );
}

const NAV = [
  { to: "/", label: "Rules" },
  { to: "/reviews", label: "Reviews" },
  { to: "/analytics", label: "Analytics" },
] as const;

export function Header({
  status,
  projects,
  providers,
  settings,
  onSettingsSaved,
  onThreadStarted,
}: {
  status: Status | null;
  projects: T3Project[];
  providers: T3Provider[] | null;
  settings: Settings | null;
  onSettingsSaved: (settings: Settings) => void;
  onThreadStarted: () => void;
}) {
  const environment = status?.t3.environment ?? null;
  return (
    <header className="flex h-11 items-center gap-5 border-b px-4">
      <span className="text-[13px] font-semibold">GitHub + Slack → T3 Code</span>
      <div className="flex flex-1 items-center gap-4 text-xs text-muted-foreground">
        <span title={status?.t3.origin}>
          <Dot tone={environment ? "ok" : status ? "err" : "idle"} />
          {environment ? `T3 ${environment.label} · ${environment.serverVersion}` : status ? "T3 unreachable" : "T3 …"}
        </span>
        <span>
          <Dot tone={status ? (status.webhookSecretConfigured ? "ok" : "warn") : "idle"} />
          {status && !status.webhookSecretConfigured ? "webhook secret not set" : "webhook secret"}
        </span>
        <span title={status?.slack === "off" ? "Set SLACK_APP_TOKEN and SLACK_BOT_TOKEN" : "Socket Mode connection"}>
          <Dot tone={status ? (status.slack === "connected" ? "ok" : status.slack === "connecting" ? "warn" : "idle") : "idle"} />
          {status ? `slack ${status.slack}` : "slack"}
        </span>
        <code className="font-mono text-[11.5px]">POST {location.origin}/webhooks/github</code>
        <span>{projects.length} projects</span>
      </div>
      <nav className="flex gap-1">
        {NAV.map(({ to, label }) => (
          <Button key={to} asChild size="sm" variant="ghost">
            <Link to={to} activeOptions={{ exact: true, includeSearch: false }} activeProps={{ className: "bg-muted" }}>{label}</Link>
          </Button>
        ))}
      </nav>
      <UpdateButton />
      <TestThread projects={projects} onStarted={onThreadStarted} />
      {settings && <SettingsPopover settings={settings} providers={providers} onSaved={onSettingsSaved} />}
    </header>
  );
}

/** Starts a one-message thread in a project to prove token, RPC and provider all work. */
function TestThread({ projects, onStarted }: { projects: T3Project[]; onStarted: () => void }) {
  const [projectId, setProjectId] = useState("");
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "busy" } | { kind: "ok"; url: string } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const selected = projectId || projects[0]?.id || "";

  const start = () => {
    setState({ kind: "busy" });
    api<{ threadUrl: string }>("/api/t3/test-thread", { method: "POST", body: JSON.stringify({ projectId: selected }) })
      .then((thread) => setState({ kind: "ok", url: thread.threadUrl }))
      .catch((e: Error) => setState({ kind: "error", message: e.message }))
      .finally(onStarted);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">Test thread</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] space-y-3 p-3 text-[13px]">
        <p className="text-muted-foreground">Starts a one-message thread in a project. Proves the token, RPC and provider work.</p>
        <div className="flex gap-2">
          <Select value={selected} onValueChange={setProjectId} disabled={projects.length === 0}>
            <SelectTrigger size="sm" className="flex-1"><SelectValue placeholder="project" /></SelectTrigger>
            <SelectContent>
              {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.title}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={start} disabled={!selected || state.kind === "busy"}>
            {state.kind === "busy" ? "Starting…" : "Start"}
          </Button>
        </div>
        {state.kind === "ok" && (
          <p className="text-ok">
            Thread started. <a className="underline underline-offset-4" href={state.url} target="_blank" rel="noreferrer">Open in T3</a>
          </p>
        )}
        {state.kind === "error" && <p className="text-destructive">{state.message}</p>}
      </PopoverContent>
    </Popover>
  );
}

const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;

/**
 * Shows up only when upstream has commits the checkout lacks. Updating pulls,
 * installs and restarts the server, then this page polls until it is back and
 * reloads itself.
 */
function UpdateButton() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "restarting" } | { kind: "error"; message: string }>({ kind: "idle" });

  const check = () => api<UpdateStatus>("/api/update").then(setStatus).catch(() => setStatus(null));
  useEffect(() => {
    void check();
    const timer = setInterval(() => void check(), UPDATE_CHECK_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  const update = () => {
    setState({ kind: "busy" });
    api<UpdateResult>("/api/update", { method: "POST" })
      .then(() => {
        setState({ kind: "restarting" });
        waitForServer().then(() => location.reload());
      })
      .catch((e: Error) => setState({ kind: "error", message: e.message }));
  };

  if (!status || status.commits.length === 0) return null;
  const busy = state.kind === "busy" || state.kind === "restarting";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <Dot tone="warn" />
          Update · {status.commits.length}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-3 p-3 text-[13px]">
        <div className="flex items-baseline justify-between">
          <span className="font-medium">
            {status.upstream} <span className="font-mono text-xs text-muted-foreground">{status.current} → {status.latest}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => void check()} disabled={busy}>Recheck</Button>
        </div>
        <ul className="max-h-48 space-y-0.5 overflow-auto font-mono text-xs">
          {status.commits.map((commit) => (
            <li key={commit.sha} className="truncate">
              <span className="text-muted-foreground">{commit.sha}</span> {commit.subject}
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground">
          {[
            status.migrations && "runs migrations on start",
            status.dependencies && "installs dependencies",
            status.restart === "launchd" ? "launchd restarts the service" : status.restart === "hot" ? "bun --hot reloads in place" : "the process respawns itself",
          ]
            .filter(Boolean)
            .join(" · ")}
          .
        </p>
        {status.dirty && <p className="text-warn">The checkout has uncommitted changes. Commit or discard them, then recheck.</p>}
        <Button size="sm" className="w-full" onClick={update} disabled={busy || status.dirty}>
          {state.kind === "busy" ? "Pulling…" : state.kind === "restarting" ? "Restarting, page reloads when back…" : "Update and restart"}
        </Button>
        {state.kind === "error" && <p className="text-destructive">{state.message}</p>}
      </PopoverContent>
    </Popover>
  );
}

/** Resolves once `/api/status` answers again after the restart; starts after the old process has had time to exit. */
async function waitForServer(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2500));
  for (;;) {
    const ok = await fetch("/api/status").then((r) => r.ok).catch(() => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function SettingsPopover({ settings, providers, onSaved }: { settings: Settings; providers: T3Provider[] | null; onSaved: (s: Settings) => void }) {
  const [draft, setDraft] = useState(settings);
  const { state, error } = useAutosave(draft, (value) =>
    api<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(value) }).then(onSaved),
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">Settings</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] space-y-3 p-3 text-[13px]">
        <div className="flex items-baseline justify-between">
          <span className="font-medium">Defaults</span>
          <span className={cn("text-xs text-muted-foreground", state === "error" && "text-destructive")}>{saveLabel(state)}</span>
        </div>
        <p className="text-muted-foreground">Used when a rule has no model override and the T3 project has no default.</p>
        <Field label="Model">
          <ModelPicker value={draft.model} providers={providers} onChange={(model) => setDraft({ ...draft, model })} className="[&>*]:flex-1" />
        </Field>
        <Field label="Runtime mode">
          <Select value={draft.runtimeMode} onValueChange={(value) => setDraft({ ...draft, runtimeMode: value as Settings["runtimeMode"] })}>
            <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RUNTIME_MODES.map((mode) => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Your GitHub login" hint="Rules with 'Skip my own PRs' on will not review PRs you authored.">
          <Input
            className="h-8 font-mono text-xs"
            value={draft.githubLogin ?? ""}
            onChange={(e) => setDraft({ ...draft, githubLogin: e.target.value || null })}
            placeholder="octocat"
          />
        </Field>
        <Field label="Pause after change requests" hint="Reviews of one PR that request changes in a row before its reviews pause and a handoff thread is written. 0 never pauses.">
          <Input
            type="number"
            min={0}
            className="h-8 w-20 font-mono text-xs"
            value={draft.maxChangesRequestedRounds}
            onChange={(e) => setDraft({ ...draft, maxChangesRequestedRounds: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          />
        </Field>
        <Field
          label="Handoff prompt"
          hint={`First message of the handoff thread. PR variables plus ${HANDOFF_TEMPLATE_VARS.map((name) => `{{${name}}}`).join(", ")}.`}
        >
          <Textarea
            className="min-h-40 font-mono text-xs"
            value={draft.handoffPrompt}
            onChange={(e) => setDraft({ ...draft, handoffPrompt: e.target.value })}
          />
          {draft.handoffPrompt !== DEFAULT_HANDOFF_PROMPT && (
            <Button size="xs" variant="ghost" className="justify-self-start text-primary" onClick={() => setDraft({ ...draft, handoffPrompt: DEFAULT_HANDOFF_PROMPT })}>
              Reset to default
            </Button>
          )}
        </Field>
        {error && <p className="text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1", className)}>
      <Label className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</Label>
      {children}
      {hint && <span className="text-[11.5px] text-muted-foreground">{hint}</span>}
    </div>
  );
}
