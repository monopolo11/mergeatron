import { useForm, useStore } from "@tanstack/react-form";
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
import { Textarea } from "@/components/ui/textarea";
import { Dot, Empty, ExternalLink, Field, Heading } from "@/components/Field";
import { ModelPicker } from "@/components/ModelPicker";
import { usePromptHistory, usePromptVersions, VersionSelect } from "@/components/PromptVersions";
import { WEBHOOK_ONLY_VARS } from "@/components/RuleEditor";
import { TemplateEditor } from "@/components/TemplateEditor";
import { TokenInput } from "@/components/TokenInput";
import { Toolbar } from "@/components/Toolbar";
import { api, timeAgo } from "@/lib/api";
import type { VariableService } from "@/lib/composer";
import { ShellContext, type Shell } from "@/lib/shell";
import { saveLabel, useAutosaveForm, type AutosaveForm } from "@/lib/useAutosave";
import { confirmDiscard, useUnsavedGuard } from "@/lib/unsaved";
import { cn } from "@/lib/utils";
import type { InboxResponse } from "../../src/inbox.ts";
import type { PresetWithLatest, PromptHistory } from "../../src/promptVersions.ts";
import type { Prompt, PromptInput, Settings, Webhook } from "../../src/rules.ts";
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
  UPDATE_CHANNELS,
  WEBHOOK_SECRET_HEADER,
  MAX_SENTRY_LIMIT,
  sentryQuery,
  type InboxSource,
} from "../../src/shared.ts";
import { schemaVariables } from "../../src/template.ts";
import type { Build, UpdateResult } from "../../src/update.ts";

const SECTIONS = [
  { id: "connection", label: "Connection" },
  { id: "defaults", label: "Defaults" },
  { id: "polling", label: "Polling" },
  { id: "sentry", label: "Sentry" },
  { id: "presets", label: "Dispatch presets" },
  { id: "webhooks", label: "Webhooks" },
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
      <div className="grid h-full grid-cols-[240px_1fr] overflow-clip">
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
  const { form, state, error } = useAutosaveForm<Settings>({ defaultValues: settings, save: shell.saveSettings });
  const hash = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  const navigate = useNavigate();
  const section = SECTIONS.find((candidate) => candidate.id === hash) ?? SECTIONS[0];
  const pick = (id: SectionId) => void navigate({ to: "/settings", hash: id, replace: true });

  return (
    <div className="grid h-full grid-cols-[240px_1fr] overflow-clip">
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

      {/* Its grids answer to this pane, not the window: beside the section list it is narrower than the viewport suggests. */}
      <div className="@container min-w-0 overflow-auto">
        <Toolbar title={section.label}>
          {/* Presets and webhooks save on demand in their own editors; the autosave state is the other sections'. */}
          {section.id !== "presets" && section.id !== "webhooks" && (
            <span className={cn("ml-auto text-muted-foreground", state === "error" && "text-destructive")} title={error ?? undefined}>{saveLabel(state)}</span>
          )}
        </Toolbar>
        <div className="p-4">
          {section.id === "connection" && <Connection shell={shell} form={form} />}

          {section.id === "defaults" && (
            <div className="grid gap-x-6 gap-y-3 @3xl:grid-cols-[minmax(0,28rem)_12rem_16rem]">
              <form.Field name="model">
                {(field) => (
                  <Field label="Model" hint="Used when a rule has no model override and the T3 project has no default.">
                    <ModelPicker value={field.state.value} providers={shell.providers} onChange={field.handleChange} />
                  </Field>
                )}
              </form.Field>
              <form.Field name="runtimeMode">
                {(field) => (
                  <Field label="Runtime mode">
                    <Select value={field.state.value} onValueChange={(value) => field.handleChange(value as typeof field.state.value)}>
                      <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {RUNTIME_MODES.map((mode) => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              </form.Field>
              <form.Field name="githubLogin">
                {(field) => (
                  <Field label="Your GitHub login" hint="Rules with 'Skip my own PRs' on will not review PRs you authored.">
                    <Input className={mono} value={field.state.value ?? ""} onChange={(e) => field.handleChange(e.target.value || null)} placeholder="octocat" />
                  </Field>
                )}
              </form.Field>
              <form.Field name="usageIncludesDelegatedTasks">
                {(field) => (
                  <Field label="Count delegated tasks" hint="A run's tokens and cost include the T3 tasks its thread delegates to other threads.">
                    <div className="flex h-8 items-center">
                      <Switch size="sm" checked={field.state.value} onCheckedChange={field.handleChange} />
                    </div>
                  </Field>
                )}
              </form.Field>
            </div>
          )}

          {section.id === "polling" && <Polling form={form} />}

          {section.id === "sentry" && <Sentry shell={shell} form={form} />}

          {section.id === "presets" && <Presets />}

          {section.id === "webhooks" && <Webhooks />}

          {section.id === "reviews" && (
            <div className="grid gap-x-6 gap-y-3 @2xl:grid-cols-[14rem_1fr]">
              <form.Field name="maxChangesRequestedRounds">
                {(field) => (
                  <Field label="Pause after change requests" hint="Reviews of one PR that request changes in a row before its reviews pause and a handoff thread is written. 0 never pauses.">
                    <Input type="number" min={0} className={cn("w-20", mono)} value={field.state.value} onChange={(e) => field.handleChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
                  </Field>
                )}
              </form.Field>
              <form.Field name="handoffPrompt">
                {(field) => (
                  <TemplateField
                    label="Handoff prompt"
                    value={field.state.value}
                    fallback={DEFAULT_HANDOFF_PROMPT}
                    onChange={field.handleChange}
                    vars={HANDOFF_VARS}
                    source="github"
                    hint="First message of the handoff thread."
                    rows="min-h-40"
                  />
                )}
              </form.Field>
            </div>
          )}

          {section.id === "slack" && (
            <div className="grid gap-6">
              <div className="grid gap-x-6 gap-y-3 @2xl:grid-cols-[14rem_1fr]">
                <form.Field name="reviewChannel">
                  {(field) => (
                    <Field label="Review channel" hint="Where request_review posts when the agent names no channel. Channel id or #name.">
                      <Input className={mono} value={field.state.value ?? ""} onChange={(e) => field.handleChange(e.target.value || null)} placeholder="C0123456789" />
                    </Field>
                  )}
                </form.Field>
                <form.Field name="reviewMentions">
                  {(field) => (
                    <Field label="Default reviewers" hint="Whom request_review tags when the agent names no one, and second passes when the last round tagged no one. User ids (U…), group ids (S…), or here.">
                      <TokenInput value={field.state.value} onChange={field.handleChange} placeholder="U0123456789" />
                    </Field>
                  )}
                </form.Field>
                <form.Field name="slackUserId">
                  {(field) => (
                    <Field label="Your Slack user id" hint="Whom notify_user DMs when an agent needs you. Profile → ⋮ → Copy member ID.">
                      <Input className={mono} value={field.state.value ?? ""} onChange={(e) => field.handleChange(e.target.value || null)} placeholder="U0123456789" />
                    </Field>
                  )}
                </form.Field>
                <form.Field name="skipReaction">
                  {(field) => (
                    <Field label="Skip reaction" hint="React with :skip: instead of ⏩ on messages seen but not reviewed. Needs a custom emoji named skip.">
                      <div className="flex h-8 items-center">
                        <Switch size="sm" checked={field.state.value} onCheckedChange={field.handleChange} />
                      </div>
                    </Field>
                  )}
                </form.Field>
                <Field label="MCP for agents" hint="Tools: slack_post_message, notify_user, request_review, request_second_pass, mark_merged, review_status.">
                  <div className="flex h-8 items-center text-xs">
                    <Dot tone={shell.status?.mcp ? "ok" : "idle"} />
                    {shell.status?.mcp ? <code className={mono}>{shell.status.mcp}</code> : <span className="text-muted-foreground">off · needs Slack</span>}
                  </div>
                </Field>
              </div>
              <form.Field name="reviewRequestMessage">
                {(field) => (
                  <MessageSection
                    title="Review request message"
                    hint="Posted by request_review. Markdown becomes mrkdwn; <@U123> and <!subteam^S123> pass through."
                    value={field.state.value}
                    fallback={DEFAULT_REVIEW_REQUEST_MESSAGE}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
              <form.Field name="secondPassMessage">
                {(field) => (
                  <MessageSection
                    title="Second pass message"
                    hint="Posted by request_second_pass in the review thread. round counts from 2."
                    value={field.state.value}
                    fallback={DEFAULT_SECOND_PASS_MESSAGE}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A prompt or message template as a labelled field: editor with variable chips, reset to default. */
function TemplateField({ label, value, fallback, vars, onChange, hint, rows = "min-h-20", source }: { label: string; value: string; fallback: string; vars: readonly string[]; onChange: (value: string) => void; hint?: string; rows?: string; source?: VariableService }) {
  return (
    <Field label={label} hint={hint}>
      <TemplateEditor value={value} fallback={fallback} vars={vars} onChange={onChange} className={rows} source={source} />
    </Field>
  );
}

/** One Slack message template as its own section: heading, full-width editor with the review message variables, hint. */
function MessageSection({ title, hint, value, fallback, onChange }: { title: string; hint: string; value: string; fallback: string; onChange: (value: string) => void }) {
  return (
    <section className="grid gap-2 border-t pt-5">
      <Heading>{title}</Heading>
      <TemplateEditor value={value} fallback={fallback} vars={REVIEW_MESSAGE_VARS} onChange={onChange} className="min-h-28" skills={false} />
      <span className="text-xs text-muted-foreground">{hint}</span>
    </section>
  );
}

/** Variables the handoff prompt can use: the PR's context plus the review history. */
const HANDOFF_VARS = [...TEMPLATE_VARS.filter((name) => name.startsWith("pr_") || ["repo", "repo_url", "default_branch", "labels"].includes(name)), ...HANDOFF_TEMPLATE_VARS];

/** What the service talks to and what it runs, plus the two actions: Test thread and Update. */
function Connection({ shell, form }: { shell: Shell; form: AutosaveForm<Settings> }) {
  const { status, projects, update, webhookUrl } = shell;
  const environment = status?.t3.environment ?? null;
  const withRemote = projects.filter((project) => project.repositoryIdentity?.provider === "github").length;
  return (
    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-x-5 gap-y-2 text-xs wrap-anywhere">
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

      <dt className="text-muted-foreground">Version</dt>
      <dd>
        {update ? buildLabel(update.build) : "…"}
        {update && <span className={cn("ml-2 text-muted-foreground", mono)}>{update.commit}</span>}
      </dd>

      <dt className="text-muted-foreground">Channel</dt>
      <dd>
        <form.Field name="updateChannel">
          {(field) => (
            <Select value={field.state.value} onValueChange={(value) => field.handleChange(value as typeof field.state.value)}>
              <SelectTrigger size="sm" className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                {UPDATE_CHANNELS.map((channel) => <SelectItem key={channel} value={channel}>{channel}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </form.Field>
      </dd>

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

/** How the running code shows in Connection: its release, or why it takes no updates. */
function buildLabel(build: Build): string {
  switch (build.kind) {
    case "release":
      return build.version;
    case "main":
      return "main, moves to the next stable release";
    case "development":
      return build.reason === "dirty" ? "development build, uncommitted changes" : "development build, not on a release";
  }
}

/** The release to move to, with the checkout-install-restart action; the page reloads itself once the server is back. */
function UpdateRow({ update, error, recheck }: { update: Shell["update"]; error: string | null; recheck: Shell["recheckUpdate"] }) {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "restarting" } | { kind: "error"; message: string }>({ kind: "idle" });
  const busy = state.kind === "busy" || state.kind === "restarting";
  const recheckButton = <Button size="xs" variant="ghost" className="ml-2 text-primary" onClick={() => void recheck(true)} disabled={busy}>Recheck</Button>;
  if (!update) {
    return (
      <span className="text-muted-foreground">
        {error ? `check failed: ${error}` : "checking releases…"}
        {error && recheckButton}
      </span>
    );
  }
  if (update.build.kind === "development") return <span className="text-muted-foreground"><Dot tone="idle" />off for development builds</span>;
  const { target } = update;
  if (!target) {
    return (
      <span>
        <Dot tone="ok" />up to date <span className="text-muted-foreground">· checked {timeAgo(update.checkedAt)}</span>
        {recheckButton}
      </span>
    );
  }
  const apply = () => {
    setState({ kind: "busy" });
    api<UpdateResult>("/api/update", { method: "POST" })
      .then(() => {
        setState({ kind: "restarting" });
        waitForServer().then(() => location.reload());
      })
      .catch((e: Error) => setState({ kind: "error", message: e.message }));
  };
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          <Dot tone="warn" /><span className={mono}>{target.tag}</span>
          <ExternalLink href={target.url} className="ml-2">release notes</ExternalLink>
        </span>
        <span className="text-muted-foreground">
          {[target.migrations && "runs migrations on start", target.dependencies && "installs dependencies", update.restart === "launchd" ? "launchd restarts the service" : update.restart === "hot" ? "bun --hot reloads in place" : "the process respawns itself"].filter(Boolean).join(" · ")}
        </span>
        {recheckButton}
        <Button size="xs" onClick={apply} disabled={busy}>
          {state.kind === "busy" ? "Updating…" : state.kind === "restarting" ? "Restarting, page reloads when back…" : "Update and restart"}
        </Button>
      </div>
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
function Polling({ form }: { form: AutosaveForm<Settings> }) {
  const queryClient = useQueryClient();
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => api<InboxResponse>("/api/inbox"), refetchInterval: 15_000 });
  const [polling, setPolling] = useState<InboxSource | null>(null);
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
            <form.Field name={`polling.${source}.enabled`}>
              {(field) => <Switch size="sm" checked={field.state.value} onCheckedChange={field.handleChange} />}
            </form.Field>
            <span className="w-14 text-[13px] capitalize" title={SOURCE_NOTES[source]}>{source}</span>
            <span className="text-muted-foreground">every</span>
            <form.Field name={`polling.${source}.minutes`}>
              {(field) => <Input type="number" min={1} className={cn("h-7 w-16", mono)} value={field.state.value} onChange={(e) => field.handleChange(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />}
            </form.Field>
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
function Sentry({ shell, form }: { shell: Shell; form: AutosaveForm<Settings> }) {
  const filters = useStore(form.store, (s) => s.values.sentryFilters);
  const limit = useStore(form.store, (s) => s.values.sentryLimit);
  const config = shell.status?.sentry ?? null;
  const options = useQuery({ queryKey: ["sentry-options"], queryFn: () => api<SentryOptions>("/api/sentry/options"), enabled: config !== null, staleTime: 5 * 60_000, retry: false });
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => api<InboxResponse>("/api/inbox"), refetchInterval: 15_000, enabled: config !== null });
  const poll = inbox.data?.polling.sentry ?? null;
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

      <form.Field name="sentryFilters.projects">
        {(field) => (
          <Field label="Projects" hint="Project slugs, usually one per service. Empty covers every project.">
            <TokenInput value={field.state.value} onChange={field.handleChange} options={suggest(options.data?.projects)} placeholder="checkout-api" />
          </Field>
        )}
      </form.Field>
      <form.Field name="sentryFilters.environments">
        {(field) => (
          <Field label="Environments" hint="Any of the listed. Empty covers every environment.">
            <TokenInput value={field.state.value} onChange={field.handleChange} options={suggest(options.data?.environments)} placeholder="production" />
          </Field>
        )}
      </form.Field>
      <form.Field name="sentryFilters.tags">
        {(field) => (
          <Field label="Tags" hint="key:value. Values of one key match any; different keys must all match. Any Sentry search term works, like level:fatal or !release:beta.">
            <TokenInput value={field.state.value} onChange={field.handleChange} options={suggest(options.data?.tags)} placeholder="service:checkout" />
          </Field>
        )}
      </form.Field>
      <form.Field name="sentryLimit">
        {(field) => (
          <Field label="Limit" hint={`How many of the newest issues the inbox keeps, up to ${MAX_SENTRY_LIMIT}. Above 100 every poll pages through more of Sentry.`}>
            <LimitInput value={field.state.value} onChange={field.handleChange} />
          </Field>
        )}
      </form.Field>
      <Field label="Search" hint={`Unresolved issues seen in the last 14 days, newest first, up to ${limit}.`}>
        <code className={cn("break-words", mono)}>
          {sentryQuery(filters.tags)}
          {scope.length > 0 && <span className="text-muted-foreground"> · {scope.join(" · ")}</span>}
        </code>
      </Field>
      {options.error && <p className="text-xs text-destructive">Suggestions unavailable: {options.error.message}</p>}
    </div>
  );
}

/**
 * Edits the limit as text and saves on blur or Enter, never mid-typing: the "2"
 * of 250 would poll with limit 2 and mark the rest of the inbox gone. A draft out
 * of range shows as invalid and gives way to the saved limit on blur.
 */
function LimitInput({ value, onChange }: { value: number; onChange: (limit: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const limit = Number(draft);
  const valid = Number.isInteger(limit) && limit >= 1 && limit <= MAX_SENTRY_LIMIT;
  return (
    <Input
      type="number"
      min={1}
      max={MAX_SENTRY_LIMIT}
      className={cn("h-7 w-20", mono)}
      aria-invalid={draft !== null && !valid}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      onBlur={() => {
        if (valid && limit !== value) onChange(limit);
        setDraft(null);
      }}
    />
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
  const prompts = useQuery({ queryKey: ["prompts"], queryFn: () => api<PresetWithLatest[]>("/api/prompts") });
  const [openId, setOpenId] = useState<string | null>(null);
  // Opening another preset (or a new one) closes the open editor: its unsaved changes go only on confirm.
  const open = (id: string | null) => {
    if (id === openId || confirmDiscard()) setOpenId(id);
  };
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["prompts"] });

  const create = async (input: PromptInput = { name: "New preset", body: "" }) => {
    if (!confirmDiscard()) return;
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
          <PresetEditor key={prompt.id} prompt={prompt} onClose={() => open(null)} onDeleted={() => { setOpenId(null); void refresh(); }} />
        ) : (
          <button
            key={prompt.id}
            type="button"
            onClick={() => open(prompt.id)}
            className="grid w-full grid-cols-[12rem_1fr_auto] items-baseline gap-3 border-b px-1 py-2 text-left hover:bg-muted/40"
          >
            <span className="truncate text-[13px]">{prompt.name}</span>
            <span className={cn("truncate text-muted-foreground", mono)}>{firstLine(prompt.body)}</span>
            <span className={cn("text-muted-foreground/70", mono)}>
              v{prompt.liveVersion}
              {prompt.latestVersion > prompt.liveVersion && <span className="text-active"> · v{prompt.latestVersion} draft</span>}
            </span>
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

/** The open row, once the preset's versions have loaded. */
function PresetEditor(props: { prompt: Prompt; onClose: () => void; onDeleted: () => void }) {
  const history = usePromptHistory("preset", props.prompt.id);
  if (history.error) return <p className="border-b px-1 py-3 text-destructive">{history.error.message}</p>;
  return history.data ? <PresetForm {...props} history={history.data} /> : null;
}

/**
 * Name and body save on demand: a rename applies at once, a changed body
 * becomes a new version, a draft unless "Save and promote" (see PromptVersions).
 */
function PresetForm({ prompt, history, onClose, onDeleted }: { prompt: Prompt; history: PromptHistory; onClose: () => void; onDeleted: () => void }) {
  const queryClient = useQueryClient();
  const versions = usePromptVersions(history);
  const [saved, setSaved] = useState<PromptInput>({ name: prompt.name, body: versions.baseBody });
  const form = useForm({ defaultValues: saved, onSubmit: () => save(false) });
  const values = useStore(form.store, (s) => s.values);
  // An empty body is stored as a space, like a new preset's.
  const body = values.body || " ";
  const nameChanged = values.name.trim() !== saved.name.trim();
  const bodyChanged = body !== versions.baseBody;
  const dirty = nameChanged || bodyChanged;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useUnsavedGuard(dirty);

  const save = async (promote: boolean) => {
    setSaving(true);
    try {
      if (nameChanged) await api<Prompt>(`/api/prompts/${prompt.id}`, { method: "PUT", body: JSON.stringify({ name: values.name }) });
      await versions.save(body, promote);
      await queryClient.invalidateQueries({ queryKey: ["prompts"] });
      setSaved(values);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    const reverted = { ...saved, body: versions.reset() };
    setSaved(reverted);
    form.reset(reverted);
    setError(null);
  };
  const remove = () => api(`/api/prompts/${prompt.id}`, { method: "DELETE" }).then(onDeleted);
  return (
    <form
      className="grid gap-2 border-b bg-muted/20 px-1 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <form.Field name="name">
          {(field) => <Input className="w-56" autoFocus value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />}
        </form.Field>
        <span className={cn("ml-auto", error ? "text-destructive" : "text-warn")} title={error ?? undefined}>
          {error ? "Save failed" : dirty ? "Unsaved changes" : ""}
        </span>
        <Button type="button" size="xs" variant="ghost" disabled={!dirty || saving} onClick={discard}>Discard</Button>
        <Button type="submit" size="xs" variant="outline" disabled={!dirty || saving}>{bodyChanged ? "Save draft" : "Save"}</Button>
        {(bodyChanged || versions.base !== history.liveVersion) && (
          <Button type="button" size="xs" disabled={saving} onClick={() => void save(true)}>Save and promote</Button>
        )}
        <DeletePreset name={values.name} onConfirm={remove} />
        <Button type="button" size="xs" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      <form.Field name="body">
        {(field) => (
          <>
            <VersionSelect versions={versions} onEditFrom={field.handleChange} />
            <TemplateEditor
              value={versions.viewed?.body ?? field.state.value}
              onChange={field.handleChange}
              readOnly={versions.viewed !== null}
              vars={PRESET_VARS}
              className="min-h-36"
              placeholder="First message of the thread. Variables render per item."
            />
          </>
        )}
      </form.Field>
    </form>
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

/** Where a custom webhook receives POSTs. */
const webhookUrl = (slug: string) => `${location.origin}/webhooks/custom/${slug}`;

/** Custom webhooks as rows; the open row, or a new one, is the editor. Each fires the rules on `webhook.<slug>`. */
function Webhooks() {
  const queryClient = useQueryClient();
  const webhooks = useQuery({ queryKey: ["webhooks"], queryFn: () => api<Webhook[]>("/api/webhooks") });
  const [openId, setOpenId] = useState<string | null>(null);
  const open = (id: string | null) => {
    if (id === openId || confirmDiscard()) setOpenId(id);
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["webhooks"] });

  // A failed background refetch keeps the last data: only an empty first load shows the error, so an open form keeps its edits.
  if (!webhooks.data) return webhooks.error ? <p className="text-xs text-destructive">{webhooks.error.message}</p> : <p className="text-xs text-muted-foreground">Loading…</p>;
  return (
    <div className="border-t text-xs">
      {webhooks.data.map((webhook) =>
        webhook.id === openId ? (
          <WebhookForm key={webhook.id} webhook={webhook} onClose={() => open(null)} onSaved={refresh} onDeleted={() => { setOpenId(null); void refresh(); }} />
        ) : (
          <button
            key={webhook.id}
            type="button"
            onClick={() => open(webhook.id)}
            className="grid w-full grid-cols-[12rem_1fr_auto] items-baseline gap-3 border-b px-1 py-2 text-left hover:bg-muted/40"
          >
            <span className="truncate text-[13px]">{webhook.name}</span>
            <span className={cn("truncate text-muted-foreground", mono)}>{webhookUrl(webhook.slug)}</span>
            <span className={cn("text-muted-foreground/70", mono)}>{webhook.payloadSchema ? `${schemaVariables(webhook.payloadSchema).length} keys` : "any JSON"}</span>
          </button>
        ),
      )}
      {openId === "new" ? (
        <WebhookForm webhook={null} onClose={() => open(null)} onSaved={async (created) => { await refresh(); setOpenId(created.id); }} onDeleted={() => open(null)} />
      ) : (
        <div className="px-1 py-2">
          <Button size="xs" variant="ghost" className="text-primary" onClick={() => open("new")}>+ New webhook</Button>
        </div>
      )}
    </div>
  );
}

/**
 * Creates a webhook, or edits one's name and payload schema; the slug is fixed
 * once created, since rules name it. A saved webhook shows its URL and secret
 * header, with Rotate to replace the secret.
 */
function WebhookForm({ webhook, onClose, onSaved, onDeleted }: { webhook: Webhook | null; onClose: () => void; onSaved: (webhook: Webhook) => Promise<void> | void; onDeleted: () => void }) {
  const initial = { name: webhook?.name ?? "", slug: webhook?.slug ?? "", schema: webhook?.payloadSchema ? JSON.stringify(webhook.payloadSchema, null, 2) : "" };
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = values.name !== saved.name || values.slug !== saved.slug || values.schema !== saved.schema;
  useUnsavedGuard(dirty);

  // The schema as typed: empty is no schema, anything else must be a JSON object.
  const parsed = parseSchema(values.schema);
  const save = async () => {
    if (!parsed.ok) return setError(parsed.error);
    setSaving(true);
    try {
      const body = JSON.stringify({ name: values.name, slug: values.slug, payloadSchema: parsed.schema });
      const result = webhook
        ? await api<Webhook>(`/api/webhooks/${webhook.id}`, { method: "PUT", body })
        : await api<Webhook>("/api/webhooks", { method: "POST", body });
      setSaved(values);
      setError(null);
      await onSaved(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const failed = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const rotate = () => webhook && api<Webhook>(`/api/webhooks/${webhook.id}/secret`, { method: "POST" }).then(onSaved).catch(failed);
  const remove = () => webhook && api(`/api/webhooks/${webhook.id}`, { method: "DELETE" }).then(onDeleted).catch(failed);

  return (
    <form
      className="grid gap-3 border-b bg-muted/20 px-1 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("ml-auto", error ? "text-destructive" : "text-warn")}>{error ? "Failed" : dirty ? "Unsaved changes" : ""}</span>
        <Button type="submit" size="xs" variant="outline" disabled={!dirty || saving}>{webhook ? "Save" : "Create"}</Button>
        {webhook && <ConfirmButton label="Delete" title={`Delete "${webhook.name}"?`} description="Requests to its URL are refused from now on. Rules on its event stay, and past runs stay in the log." onConfirm={remove} />}
        <Button type="button" size="xs" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      {error && <p className="text-destructive">{error}</p>}
      <div className="grid gap-x-4 gap-y-3 @2xl:grid-cols-2">
        <Field label="Name">
          <Input autoFocus={!webhook} value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} placeholder="Deploys" />
        </Field>
        <Field label="Slug" hint={webhook ? `Rules fire on webhook.${webhook.slug}. Fixed once created.` : "Lowercase letters, digits and dashes. Fixed once created."}>
          <Input className={mono} disabled={!!webhook} value={values.slug} onChange={(e) => setValues({ ...values, slug: e.target.value.toLowerCase() })} placeholder="deploys" />
        </Field>
      </div>
      {webhook && (
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-x-5 gap-y-2 wrap-anywhere">
          <dt className="text-muted-foreground">URL</dt>
          <dd className="flex items-baseline gap-2">
            <code className={mono}>POST {webhookUrl(webhook.slug)}</code>
            <CopyButton text={webhookUrl(webhook.slug)} />
          </dd>
          <dt className="text-muted-foreground">Secret header</dt>
          <dd><SecretHeader secret={webhook.secret} onRotate={rotate} /></dd>
        </dl>
      )}
      <Field
        label="Payload schema"
        hint={
          parsed.ok
            ? parsed.schema
              ? `Requests must match it. Prompts can use {{payload}} and ${schemaVariables(parsed.schema).map((name) => `{{${name}}}`).join(", ") || "no keys yet"}.`
              : "Optional JSON schema. Without one any JSON is accepted, and prompts use {{payload}}."
            : parsed.error
        }
      >
        <Textarea
          className={cn("min-h-36", mono)}
          aria-invalid={!parsed.ok}
          value={values.schema}
          onChange={(e) => setValues({ ...values, schema: e.target.value })}
          placeholder={'{ "type": "object", "properties": { "service": { "type": "string" } } }'}
        />
      </Field>
    </form>
  );
}

/** The schema textarea's content: empty is no schema; otherwise it must be a JSON object. The server checks it is a valid schema. */
function parseSchema(text: string): { ok: true; schema: Record<string, unknown> | null } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, schema: null };
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? { ok: true, schema: value as Record<string, unknown> } : { ok: false, error: "The schema must be a JSON object." };
  } catch (e) {
    return { ok: false, error: `Not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** `X-Webhook-Secret: whsec_…`, hidden until shown, with copy and rotate. */
function SecretHeader({ secret, onRotate }: { secret: string; onRotate: () => Promise<unknown> | null }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="flex flex-wrap items-baseline gap-2">
      <code className={mono}>{WEBHOOK_SECRET_HEADER}: {shown ? secret : `${secret.slice(0, 10)}…`}</code>
      <Button type="button" size="xs" variant="ghost" className="h-5 px-1 text-primary" onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</Button>
      <CopyButton text={secret} />
      <ConfirmButton className="h-5 px-1" label="Rotate" title="Rotate the secret?" description="Senders using the current secret are refused until they switch to the new one." onConfirm={() => void onRotate()} />
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard.writeText(text).then(() => setCopied(true));
  return (
    <Button type="button" size="xs" variant="ghost" className="h-5 px-1 text-primary" onClick={copy} onBlur={() => setCopied(false)}>
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** A small destructive action behind a confirmation. */
function ConfirmButton({ label, title, description, onConfirm, className }: { label: string; title: string; description: string; onConfirm: () => void; className?: string }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" size="xs" variant="ghost" className={cn("text-destructive", className)}>{label}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{label}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
