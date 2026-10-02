import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { use, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dot, Empty, ExternalLink, Field, Heading } from "@/components/Field";
import { ModelPicker } from "@/components/ModelPicker";
import { WEBHOOK_ONLY_VARS } from "@/components/RuleEditor";
import { TemplateEditor } from "@/components/TemplateEditor";
import { TokenInput } from "@/components/TokenInput";
import { Toolbar } from "@/components/Toolbar";
import { api, timeAgo } from "@/lib/api";
import { ShellContext, type Shell } from "@/lib/shell";
import { saveLabel, useAutosave } from "@/lib/useAutosave";
import { cn } from "@/lib/utils";
import type { InboxResponse } from "../../src/inbox.ts";
import type { Prompt, PromptInput, Settings } from "../../src/rules.ts";
import type { SentryOptions } from "../../src/sentryInbox.ts";
import {
  DEFAULT_HANDOFF_PROMPT,
  DEFAULT_PROMPTS,
  DEFAULT_REVIEW_REQUEST_MESSAGE,
  DEFAULT_SECOND_PASS_MESSAGE,
  HANDOFF_TEMPLATE_VARS,
  INBOX_SOURCE_SETUP,
  INBOX_SOURCES,
  REVIEW_MESSAGE_VARS,
  RUNTIME_MODES,
  TEMPLATE_VARS,
  sentryQuery,
  type InboxSource,
  type SentryFilters,
} from "../../src/shared.ts";
import type { UpdateResult } from "../../src/update.ts";

const SECTIONS = [
  { id: "connection", label: "Connection" },
  { id: "defaults", label: "Defaults" },
  { id: "polling", label: "Polling" },
  { id: "sentry", label: "Sentry" },
  { id: "presets", label: "Dispatch presets" },
  { id: "reviews", label: "Reviews" },
  { id: "slack", label: "Slack and MCP" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const mono = "font-mono text-xs";

/**
 * Settings route, shaped like Rules: the section list on the left, the picked
 * section on the right under its own toolbar. The URL hash names the section,
 * so links such as /settings#presets land on it and reloads keep it.
 */
export function SettingsPage() {
  const shell = use(ShellContext)!;
  if (!shell.settings) {
    return (
      <div className="grid h-full grid-cols-[240px_1fr] overflow-hidden">
        <aside className="border-r">
          <Toolbar title="Settings" />
        </aside>
        <Empty>Loading…</Empty>
      </div>
    );
  }
  return <SettingsForm shell={shell} settings={shell.settings} />;
}

function SettingsForm({ shell, settings }: { shell: Shell; settings: Settings }) {
  const [draft, setDraft] = useState(settings);
  const { state, error } = useAutosave(draft, shell.saveSettings);
  const patch = (partial: Partial<Settings>) => setDraft((d) => ({ ...d, ...partial }));
  const hash = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  const navigate = useNavigate();
  const section = SECTIONS.find((candidate) => candidate.id === hash) ?? SECTIONS[0];
  const pick = (id: SectionId) => void navigate({ to: "/settings", hash: id, replace: true });

  return (
    <div className="grid h-full grid-cols-[240px_1fr] overflow-hidden">
      <aside className="overflow-auto border-r">
        <Toolbar title="Settings" />
        <nav>
          {SECTIONS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => pick(candidate.id)}
              className={cn(
                "block w-full border-b px-3 py-2 text-left text-[13px] text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                section.id === candidate.id && "bg-muted/60 text-foreground",
              )}
            >
              {candidate.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 overflow-auto">
        <Toolbar title={section.label}>
          <span className={cn("ml-auto text-muted-foreground", state === "error" && "text-destructive")} title={error ?? undefined}>{saveLabel(state)}</span>
        </Toolbar>
        <div className="p-4">
          {section.id === "connection" && <Connection shell={shell} />}

          {section.id === "defaults" && (
            <div className="grid gap-x-6 gap-y-3 md:grid-cols-[minmax(0,28rem)_12rem_16rem]">
              <Field label="Model" hint="Used when a rule has no model override and the T3 project has no default.">
                <ModelPicker value={draft.model} providers={shell.providers} onChange={(model) => patch({ model })} />
              </Field>
              <Field label="Runtime mode">
                <Select value={draft.runtimeMode} onValueChange={(value) => patch({ runtimeMode: value as Settings["runtimeMode"] })}>
                  <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {RUNTIME_MODES.map((mode) => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Your GitHub login" hint="Rules with 'Skip my own PRs' on will not review PRs you authored.">
                <Input className={mono} value={draft.githubLogin ?? ""} onChange={(e) => patch({ githubLogin: e.target.value || null })} placeholder="octocat" />
              </Field>
            </div>
          )}

          {section.id === "polling" && <Polling draft={draft} patch={patch} />}

          {section.id === "sentry" && <Sentry shell={shell} filters={draft.sentryFilters} onChange={(sentryFilters) => patch({ sentryFilters })} />}

          {section.id === "presets" && <Presets />}

          {section.id === "reviews" && (
            <div className="grid gap-x-6 gap-y-3 md:grid-cols-[14rem_1fr]">
              <Field label="Pause after change requests" hint="Reviews of one PR that request changes in a row before its reviews pause and a handoff thread is written. 0 never pauses.">
                <Input type="number" min={0} className={cn("w-20", mono)} value={draft.maxChangesRequestedRounds} onChange={(e) => patch({ maxChangesRequestedRounds: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
              </Field>
              <TemplateField
                label="Handoff prompt"
                value={draft.handoffPrompt}
                fallback={DEFAULT_HANDOFF_PROMPT}
                onChange={(handoffPrompt) => patch({ handoffPrompt })}
                vars={HANDOFF_VARS}
                hint="First message of the handoff thread."
                rows="min-h-40"
              />
            </div>
          )}

          {section.id === "slack" && (
            <div className="grid gap-6">
              <div className="grid gap-x-6 gap-y-3 md:grid-cols-[14rem_1fr]">
                <Field label="Review channel" hint="Where request_review posts when the agent names no channel. Channel id or #name.">
                  <Input className={mono} value={draft.reviewChannel ?? ""} onChange={(e) => patch({ reviewChannel: e.target.value || null })} placeholder="C0123456789" />
                </Field>
                <Field label="Your Slack user id" hint="Whom notify_user DMs when an agent needs you. Profile → ⋮ → Copy member ID.">
                  <Input className={mono} value={draft.slackUserId ?? ""} onChange={(e) => patch({ slackUserId: e.target.value || null })} placeholder="U0123456789" />
                </Field>
                <Field label="MCP for agents" hint="Tools: slack_post_message, notify_user, request_review, request_second_pass, mark_merged, review_status.">
                  <div className="flex h-8 items-center text-xs">
                    <Dot tone={shell.status?.mcp ? "ok" : "idle"} />
                    {shell.status?.mcp ? <code className={mono}>{shell.status.mcp}</code> : <span className="text-muted-foreground">off · needs Slack</span>}
                  </div>
                </Field>
              </div>
              <MessageSection
                title="Review request message"
                hint="Posted by request_review. Markdown becomes mrkdwn; <@U123> and <!subteam^S123> pass through."
                value={draft.reviewRequestMessage}
                fallback={DEFAULT_REVIEW_REQUEST_MESSAGE}
                onChange={(reviewRequestMessage) => patch({ reviewRequestMessage })}
              />
              <MessageSection
                title="Second pass message"
                hint="Posted by request_second_pass in the review thread. round counts from 2."
                value={draft.secondPassMessage}
                fallback={DEFAULT_SECOND_PASS_MESSAGE}
                onChange={(secondPassMessage) => patch({ secondPassMessage })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A prompt or message template as a labelled field: editor with variable chips, reset to default. */
function TemplateField({ label, value, fallback, vars, onChange, hint, rows = "min-h-20" }: { label: string; value: string; fallback: string; vars: readonly string[]; onChange: (value: string) => void; hint?: string; rows?: string }) {
  return (
    <Field label={label} hint={hint}>
      <TemplateEditor value={value} fallback={fallback} vars={vars} onChange={onChange} className={rows} />
    </Field>
  );
}

/** One Slack message template as its own section: heading, full-width editor with the review message variables, hint. */
function MessageSection({ title, hint, value, fallback, onChange }: { title: string; hint: string; value: string; fallback: string; onChange: (value: string) => void }) {
  return (
    <section className="grid gap-2 border-t pt-5">
      <Heading>{title}</Heading>
      <TemplateEditor value={value} fallback={fallback} vars={REVIEW_MESSAGE_VARS} onChange={onChange} className="min-h-28" />
      <span className="text-xs text-muted-foreground">{hint}</span>
    </section>
  );
}

/** Variables the handoff prompt can use: the PR's context plus the review history. */
const HANDOFF_VARS = [...TEMPLATE_VARS.filter((name) => name.startsWith("pr_") || ["repo", "repo_url", "default_branch", "labels"].includes(name)), ...HANDOFF_TEMPLATE_VARS];

/** What the service talks to, plus the two actions: Test thread and Update. */
function Connection({ shell }: { shell: Shell }) {
  const { status, projects, update, webhookUrl } = shell;
  const environment = status?.t3.environment ?? null;
  const withRemote = projects.filter((project) => project.repositoryIdentity?.provider === "github").length;
  return (
    <dl className="grid grid-cols-[7rem_1fr] items-baseline gap-x-5 gap-y-2 text-xs">
      <dt className="text-muted-foreground">T3 Code</dt>
      <dd className="min-w-0">
        <Dot tone={environment ? "ok" : status ? "err" : "idle"} />
        {environment ? `${environment.label} · ${environment.serverVersion}` : status ? "unreachable" : "…"}
        {status && <span className={cn("ml-2 text-muted-foreground", mono)}>{status.t3.origin}</span>}
      </dd>

      <dt className="text-muted-foreground">Test thread</dt>
      <dd><TestThread projects={projects} onStarted={shell.refreshRuns} /></dd>

      <dt className="text-muted-foreground">Webhook</dt>
      <dd className="min-w-0">
        <code className={mono}>POST {webhookUrl}</code>
        <span className="ml-3">
          <Dot tone={status ? (status.webhookSecretConfigured ? "ok" : "warn") : "idle"} />
          {status?.webhookSecretConfigured ? "secret set" : "secret not set"}
        </span>
      </dd>

      <dt className="text-muted-foreground">Slack</dt>
      <dd>
        <Dot tone={status ? (status.slack === "connected" ? "ok" : status.slack === "connecting" ? "warn" : "idle") : "idle"} />
        {status ? (status.slack === "off" ? "off · set SLACK_APP_TOKEN and SLACK_BOT_TOKEN" : `Socket Mode ${status.slack}`) : "…"}
        {status?.mcp && <span className="ml-2 text-muted-foreground">· MCP for agents at <code className={mono}>{status.mcp}</code></span>}
      </dd>

      <dt className="text-muted-foreground">Projects</dt>
      <dd>{projects.length} in T3 · {withRemote} with a GitHub remote</dd>

      <dt className="text-muted-foreground">Update</dt>
      <dd><UpdateRow update={update} error={shell.updateError} recheck={shell.recheckUpdate} /></dd>
    </dl>
  );
}

/** Starts a one-message thread in a project to prove token, RPC and provider all work. */
function TestThread({ projects, onStarted }: { projects: Shell["projects"]; onStarted: () => void }) {
  const [projectId, setProjectId] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "ok"; url: string } | { kind: "error"; message: string }>({ kind: "idle" });
  const selected = projectId || projects[0]?.id || "";
  const start = () => {
    setState({ kind: "busy" });
    api<{ threadUrl: string }>("/api/t3/test-thread", { method: "POST", body: JSON.stringify({ projectId: selected }) })
      .then((thread) => setState({ kind: "ok", url: thread.threadUrl }))
      .catch((e: Error) => setState({ kind: "error", message: e.message }))
      .finally(onStarted);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={selected} onValueChange={setProjectId} disabled={projects.length === 0}>
        <SelectTrigger size="sm" className="w-56"><SelectValue placeholder="project" /></SelectTrigger>
        <SelectContent>
          {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.title}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button size="xs" variant="outline" onClick={start} disabled={!selected || state.kind === "busy"}>{state.kind === "busy" ? "Starting…" : "Start"}</Button>
      <span className="text-muted-foreground">Starts a one-message thread. Proves the token, RPC and provider work.</span>
      {state.kind === "ok" && (
        <span className="text-ok">Thread started. <ExternalLink href={state.url} className="underline">Open in T3</ExternalLink></span>
      )}
      {state.kind === "error" && <span className="text-destructive">{state.message}</span>}
    </div>
  );
}

/** Upstream check with the pull-install-restart action; the page reloads itself once the server is back. */
function UpdateRow({ update, error, recheck }: { update: Shell["update"]; error: string | null; recheck: () => Promise<void> }) {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "restarting" } | { kind: "error"; message: string }>({ kind: "idle" });
  if (!update) {
    return (
      <span className="text-muted-foreground">
        {error ? `check failed: ${error}` : "checking upstream…"}
        {error && <Button size="xs" variant="ghost" className="ml-2 text-primary" onClick={() => void recheck()}>Recheck</Button>}
      </span>
    );
  }
  const busy = state.kind === "busy" || state.kind === "restarting";
  const apply = () => {
    setState({ kind: "busy" });
    api<UpdateResult>("/api/update", { method: "POST" })
      .then(() => {
        setState({ kind: "restarting" });
        waitForServer().then(() => location.reload());
      })
      .catch((e: Error) => setState({ kind: "error", message: e.message }));
  };
  if (update.commits.length === 0) {
    return (
      <span>
        <Dot tone="ok" />up to date with {update.upstream} <span className="text-muted-foreground">· checked {timeAgo(update.checkedAt)}</span>
        <Button size="xs" variant="ghost" className="ml-2 text-primary" onClick={() => void recheck()}>Recheck</Button>
      </span>
    );
  }
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          <Dot tone="warn" />{update.commits.length} commits behind {update.upstream}
          <span className={cn("ml-2 text-muted-foreground", mono)}>{update.current} → {update.latest}</span>
        </span>
        <span className="text-muted-foreground">
          {[update.migrations && "runs migrations on start", update.dependencies && "installs dependencies", update.restart === "launchd" ? "launchd restarts the service" : update.restart === "hot" ? "bun --hot reloads in place" : "the process respawns itself"].filter(Boolean).join(" · ")}
        </span>
        <Button size="xs" variant="ghost" className="text-primary" onClick={() => void recheck()} disabled={busy}>Recheck</Button>
        <Button size="xs" onClick={apply} disabled={busy || update.dirty}>
          {state.kind === "busy" ? "Pulling…" : state.kind === "restarting" ? "Restarting, page reloads when back…" : "Update and restart"}
        </Button>
      </div>
      <ul className={cn("max-h-32 space-y-0.5 overflow-auto", mono)}>
        {update.commits.map((commit) => (
          <li key={commit.sha} className="truncate"><span className="text-muted-foreground">{commit.sha}</span> {commit.subject}</li>
        ))}
      </ul>
      {update.dirty && <p className="text-warn">The checkout has uncommitted changes. Commit or discard them, then recheck.</p>}
      {state.kind === "error" && <p className="text-destructive">{state.message}</p>}
    </div>
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

/** What each source polls, shown as the source's tooltip. */
const SOURCE_NOTES: Record<InboxSource, string> = {
  github: "Through the gh CLI: review requested, assigned to you, mentioning you, authored by you.",
  linear: "Needs LINEAR_API_KEY in .env: assigned to you, created by you, mentioning you.",
  sentry: "Needs SENTRY_AUTH_TOKEN and SENTRY_ORG in .env: unresolved issues passing the filters under Sentry.",
};

/** One row per inbox source: on/off, interval, live state, poll now. */
function Polling({ draft, patch }: { draft: Settings; patch: (partial: Partial<Settings>) => void }) {
  const queryClient = useQueryClient();
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => api<InboxResponse>("/api/inbox"), refetchInterval: 15_000 });
  const [polling, setPolling] = useState<InboxSource | null>(null);
  const patchSource = (source: InboxSource, partial: Partial<Settings["polling"][InboxSource]>) =>
    patch({ polling: { ...draft.polling, [source]: { ...draft.polling[source], ...partial } } });
  const pollNow = (source: InboxSource) => {
    setPolling(source);
    api("/api/inbox/poll", { method: "POST", body: JSON.stringify({ source }) }).finally(() => {
      setPolling(null);
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    });
  };
  return (
    <div className="grid gap-2 text-xs">
      {INBOX_SOURCES.map((source) => {
        const status = inbox.data?.polling[source] ?? null;
        const live = !status
          ? "…"
          : !status.configured
            ? INBOX_SOURCE_SETUP[source]
            : [status.login && `as ${status.login}`, `${status.items} items`, status.lastPolledAt ? `polled ${timeAgo(status.lastPolledAt)}` : "not polled yet", status.nextAt && status.enabled && `next ${until(status.nextAt)}`]
                .filter(Boolean)
                .join(" · ");
        return (
          <div key={source} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Switch size="sm" checked={draft.polling[source].enabled} onCheckedChange={(enabled) => patchSource(source, { enabled })} />
            <span className="w-14 text-[13px] capitalize" title={SOURCE_NOTES[source]}>{source}</span>
            <span className="text-muted-foreground">every</span>
            <Input type="number" min={1} className={cn("h-7 w-16", mono)} value={draft.polling[source].minutes} onChange={(e) => patchSource(source, { minutes: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
            <span className="text-muted-foreground">min</span>
            <span className={cn("text-muted-foreground", status?.lastError && "text-destructive")} title={status?.lastError ?? undefined}>
              {status?.lastError ? `failed: ${status.lastError}` : live}
            </span>
            {status?.configured && (
              <Button size="xs" variant="outline" onClick={() => pollNow(source)} disabled={polling === source || status.polling}>
                {polling === source || status.polling ? "Polling…" : "Poll now"}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Which Sentry issues reach the inbox. Suggestions come from the instance;
 * the search line is what the next poll sends. Saving polls Sentry right away.
 */
function Sentry({ shell, filters, onChange }: { shell: Shell; filters: SentryFilters; onChange: (filters: SentryFilters) => void }) {
  const config = shell.status?.sentry ?? null;
  const options = useQuery({ queryKey: ["sentry-options"], queryFn: () => api<SentryOptions>("/api/sentry/options"), enabled: config !== null, staleTime: 5 * 60_000, retry: false });
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => api<InboxResponse>("/api/inbox"), refetchInterval: 15_000, enabled: config !== null });
  const poll = inbox.data?.polling.sentry ?? null;
  const patch = (partial: Partial<SentryFilters>) => onChange({ ...filters, ...partial });
  const suggest = (values: string[] | undefined) => (values ?? []).map((value) => ({ value }));
  const scope = [filters.environments.length > 0 && `environment ${filters.environments.join(", ")}`, filters.projects.length > 0 && `project ${filters.projects.join(", ")}`].filter(Boolean);

  return (
    <div className="grid max-w-3xl gap-4">
      <dl className="grid grid-cols-[7rem_1fr] items-baseline gap-x-5 gap-y-2 text-xs">
        <dt className="text-muted-foreground">Instance</dt>
        <dd className="min-w-0">
          <Dot tone={config ? "ok" : "idle"} />
          {config ? (
            <>
              <code className={mono}>{config.url}</code> · org <code className={mono}>{config.org}</code>
            </>
          ) : shell.status ? (
            `off · ${INBOX_SOURCE_SETUP.sentry}, plus SENTRY_URL for self-hosted`
          ) : (
            "…"
          )}
        </dd>
        {config && (
          <>
            <dt className="text-muted-foreground">Inbox</dt>
            <dd className={cn(poll?.lastError && "text-destructive")}>
              {!poll ? "…" : poll.lastError ? `failed: ${poll.lastError}` : `${poll.items} issues · ${poll.polling ? "polling…" : poll.lastPolledAt ? `polled ${timeAgo(poll.lastPolledAt)}` : "not polled yet"}`}
            </dd>
          </>
        )}
      </dl>

      <Field label="Projects" hint="Project slugs, usually one per service. Empty covers every project.">
        <TokenInput value={filters.projects} onChange={(projects) => patch({ projects })} options={suggest(options.data?.projects)} placeholder="checkout-api" />
      </Field>
      <Field label="Environments" hint="Any of the listed. Empty covers every environment.">
        <TokenInput value={filters.environments} onChange={(environments) => patch({ environments })} options={suggest(options.data?.environments)} placeholder="production" />
      </Field>
      <Field label="Tags" hint="key:value. Values of one key match any; different keys must all match. Any Sentry search term works, like level:fatal or !release:beta.">
        <TokenInput value={filters.tags} onChange={(tags) => patch({ tags })} options={suggest(options.data?.tags)} placeholder="service:checkout" />
      </Field>
      <Field label="Search" hint="Unresolved issues seen in the last 14 days, newest first, up to 100.">
        <code className={cn("break-words", mono)}>
          {sentryQuery(filters.tags)}
          {scope.length > 0 && <span className="text-muted-foreground"> · {scope.join(" · ")}</span>}
        </code>
      </Field>
      {options.error && <p className="text-xs text-destructive">Suggestions unavailable: {options.error.message}</p>}
    </div>
  );
}

/** "in 2 min" or "due now", for the next poll. */
function until(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  return minutes <= 0 ? "due now" : `in ${minutes} min`;
}

/** Variables presets can use: everything an inbox item carries, for PRs and issues alike. */
const PRESET_VARS = TEMPLATE_VARS.filter((name) => !name.startsWith("slack_") && !WEBHOOK_ONLY_VARS.has(name));

/** The preset library as rows; the open row is the editor. Presets stack into the first message when dispatching from the Inbox. */
function Presets() {
  const queryClient = useQueryClient();
  const prompts = useQuery({ queryKey: ["prompts"], queryFn: () => api<Prompt[]>("/api/prompts") });
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["prompts"] });

  const create = async (input: PromptInput = { name: "New preset", body: "" }) => {
    setBusy(true);
    try {
      const created = await api<Prompt>("/api/prompts", { method: "POST", body: JSON.stringify({ ...input, body: input.body || " " }) });
      await refresh();
      setOpenId(created.id);
    } finally {
      setBusy(false);
    }
  };
  const addDefaults = async () => {
    setBusy(true);
    try {
      for (const preset of DEFAULT_PROMPTS) await api<Prompt>("/api/prompts", { method: "POST", body: JSON.stringify(preset) });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!prompts.data) return <p className="text-xs text-muted-foreground">Loading…</p>;
  return (
    <div className="border-t text-xs">
      {prompts.data.map((prompt) =>
        prompt.id === openId ? (
          <PresetEditor key={prompt.id} prompt={prompt} onClose={() => setOpenId(null)} onDeleted={() => { setOpenId(null); void refresh(); }} />
        ) : (
          <button
            key={prompt.id}
            type="button"
            onClick={() => setOpenId(prompt.id)}
            className="grid w-full grid-cols-[12rem_1fr_auto] items-baseline gap-3 border-b px-1 py-2 text-left hover:bg-muted/40"
          >
            <span className="truncate text-[13px]">{prompt.name}</span>
            <span className={cn("truncate text-muted-foreground", mono)}>{firstLine(prompt.body)}</span>
            <span className="text-muted-foreground/70">edit</span>
          </button>
        ),
      )}
      <div className="flex items-center gap-3 px-1 py-2">
        <Button size="xs" variant="ghost" className="text-primary" onClick={() => void create()} disabled={busy}>+ New preset</Button>
        {prompts.data.length === 0 && (
          <Button size="xs" variant="ghost" className="text-primary" onClick={() => void addDefaults()} disabled={busy}>Add the three defaults</Button>
        )}
      </div>
    </div>
  );
}

function firstLine(body: string): string {
  return body.split("\n").find((line) => line.trim()) ?? "";
}

/** The open row: name and body autosave; variable chips insert at the cursor. */
function PresetEditor({ prompt, onClose, onDeleted }: { prompt: Prompt; onClose: () => void; onDeleted: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PromptInput>({ name: prompt.name, body: prompt.body });
  const { state, error } = useAutosave(draft, async (value) => {
    const saved = await api<Prompt>(`/api/prompts/${prompt.id}`, { method: "PUT", body: JSON.stringify({ ...value, body: value.body || " " }) });
    queryClient.setQueryData<Prompt[]>(["prompts"], (all) => all?.map((p) => (p.id === saved.id ? saved : p)));
  });
  const remove = () => api(`/api/prompts/${prompt.id}`, { method: "DELETE" }).then(onDeleted);
  return (
    <div className="grid gap-2 border-b bg-muted/20 px-1 py-3">
      <div className="flex items-center gap-2">
        <Input className="w-72" autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <span className={cn("text-muted-foreground", state === "error" && "text-destructive")} title={error ?? undefined}>{saveLabel(state)}</span>
        <span className="ml-auto flex items-center gap-1">
          <DeletePreset name={draft.name} onConfirm={remove} />
          <Button size="xs" variant="ghost" onClick={onClose}>Close</Button>
        </span>
      </div>
      <TemplateEditor value={draft.body} onChange={(body) => setDraft({ ...draft, body })} vars={PRESET_VARS} className="min-h-36" placeholder="First message of the thread. Variables render per item." />
    </div>
  );
}

function DeletePreset({ name, onConfirm }: { name: string; onConfirm: () => Promise<void> }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="xs" variant="ghost" className="text-destructive">Delete</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{name || "Untitled preset"}"?</AlertDialogTitle>
          <AlertDialogDescription>Rules and past runs are not affected; the dispatch dialog stops offering it.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
