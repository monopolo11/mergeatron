import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, type Status } from "@/lib/api";
import { saveLabel, useAutosave } from "@/lib/useAutosave";
import { cn } from "@/lib/utils";
import type { Settings } from "../../src/rules.ts";
import { RUNTIME_MODES } from "../../src/shared.ts";
import type { T3Project, T3Provider } from "../../src/t3.ts";
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
      <PopoverContent align="end" className="w-80 space-y-3 p-3 text-[13px]">
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
      <PopoverContent align="end" className="w-80 space-y-3 p-3 text-[13px]">
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
