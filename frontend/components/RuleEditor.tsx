import { useForm, useStore } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { firstAvailableModel } from "@/components/DispatchDialog";
import { Empty, ExternalLink, Field, GroupLabel, RunStatus } from "@/components/Field";
import { FilterInput, type FilterOptions } from "@/components/FilterInput";
import { ModelPicker } from "@/components/ModelPicker";
import { PromptEditor, type PromptEditorHandle } from "@/components/PromptEditor";
import { usePromptHistory, usePromptVersions, VersionSelect } from "@/components/PromptVersions";
import type { TokenOption } from "@/components/TokenInput";
import { Toolbar } from "@/components/Toolbar";
import { api, timeAgo } from "@/lib/api";
import { eventsService } from "@/lib/composer";
import { applicable, eventKinds } from "@/lib/ruleFields";
import type { RuleDraft } from "@/lib/shell";
import { useUnsavedGuard } from "@/lib/unsaved";
import { cn } from "@/lib/utils";
import { itemContext, itemEvent, type InboxItem, type InboxResponse, type LabelsResponse } from "../../src/inbox.ts";
import { HAS_VALUES, termValues } from "../../src/filterQuery.ts";
import { ruleMismatch, sameName } from "../../src/match.ts";
import type { PromptHistory } from "../../src/promptVersions.ts";
import type { Prompt, Rule, Run, Webhook } from "../../src/rules.ts";
import {
  CUSTOM_WEBHOOK_VARS,
  EVENT_SOURCES,
  INBOX_EVENT_PREFIX,
  INBOX_REASON_LABELS,
  INBOX_REASONS,
  SUGGESTED_EVENTS,
  TEMPLATE_VARS,
  WORKSPACE_MODES,
  customWebhookEvent,
  eventSource,
  inboxSource,
  type EventSource,
} from "../../src/shared.ts";
import type { T3Project, T3Provider } from "../../src/t3.ts";
import { renderTemplate, schemaVariables } from "../../src/template.ts";

/** Radix Select cannot hold an empty string, so "auto" gets a sentinel. */
const AUTO_PROJECT = "__auto__";
const OWN_PROMPT = "__own__";
const mono = "font-mono text-xs";

/** Variables only webhook payloads carry; hidden on rules that listen to the inbox alone, and from dispatch presets. */
export const WEBHOOK_ONLY_VARS = new Set(["event", "action", "sender", "requested_reviewer", "comment_body", "comment_author", "comment_url", "review_state", "review_body", "review_author", "label"]);

const REASON_OPTIONS: TokenOption[] = INBOX_REASONS.map((reason) => ({ value: reason, label: INBOX_REASON_LABELS[reason] }));

type RuleEditorProps = {
  rule: Rule;
  projects: T3Project[];
  providers: T3Provider[] | null;
  runs: Run[];
  /** GitHub login from settings; null means "Skip my own PRs" has nothing to compare against. */
  githubLogin: string | null;
  onSave: (id: string, input: RuleDraft) => Promise<void>;
  onDelete: (rule: Rule) => Promise<void>;
  /** Called after "Run now" so the run log refreshes without waiting for its poll. */
  onRunsChanged: () => void;
};

/** The selected rule's form, once its prompt versions have loaded. */
export function RuleEditor(props: RuleEditorProps) {
  const history = usePromptHistory("rule", props.rule.id);
  if (history.error) return <Empty>{history.error.message}</Empty>;
  return history.data ? <RuleForm {...props} history={history.data} /> : null;
}

/**
 * Edits a rule and saves on demand: settings with a PUT, a changed prompt as
 * a new version, a draft unless "Save and promote" (see PromptVersions).
 */
function RuleForm({ rule, projects, providers, runs, githubLogin, onSave, onDelete, onRunsChanged, history }: RuleEditorProps & { history: PromptHistory }) {
  // `enabled` is the list switch's, not the form's: saving the form must never write a stale copy back.
  const { id, createdAt, updatedAt, enabled, livePromptVersion, ...stored } = rule;
  const promptRef = useRef<PromptEditorHandle>(null);
  const versions = usePromptVersions(history);

  const [saved, setSaved] = useState<RuleDraft>({ ...stored, prompt: versions.baseBody });
  const form = useForm({ defaultValues: saved, onSubmit: () => save(false) });
  const draft = useStore(form.store, (s) => s.values);
  const value = useMemo(() => applicable(draft), [draft]);

  const promptChanged = value.prompt !== versions.baseBody;
  // Against the stored rule as is, so a stored value the form hides (and clears) shows as unsaved until saved away.
  const settingsChanged = JSON.stringify({ ...value, prompt: "" }) !== JSON.stringify({ ...saved, prompt: "" });
  const dirty = promptChanged || settingsChanged;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useUnsavedGuard(dirty);

  const save = async (promote: boolean) => {
    setSaving(true);
    try {
      if (settingsChanged) await onSave(id, value);
      await versions.save(value.prompt, promote);
      setSaved(value);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    const reverted = { ...saved, prompt: versions.reset() };
    setSaved(reverted);
    form.reset(reverted);
    setError(null);
  };

  const events = draft.events;
  const { isSlack, isInbox, isWebhook, isCustom, inboxLinear, inboxSentry, inboxGitHub } = eventKinds(events);
  // Linear and Sentry issues and custom webhooks name no repository, so the rule must pick a project.
  const needsProject = inboxLinear || inboxSentry || isCustom;
  const inboxPr = events.includes("inbox.github.pull_request");
  const inboxIssue = events.some((event) => event.startsWith(INBOX_EVENT_PREFIX) && event.endsWith(".issue"));
  // Slack messages carry PR variables once a PR link is found in the text.
  const showsPullRequestVars = events.some((event) => event.startsWith("pull_request")) || isSlack || inboxPr;
  const project = projects.find((p) => p.id === draft.projectId);

  // Inbox items feed the token suggestions and the match preview; only fetched for inbox rules.
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => api<InboxResponse>("/api/inbox"), refetchInterval: 15_000, enabled: isInbox });
  const prompts = useQuery({ queryKey: ["prompts"], queryFn: () => api<Prompt[]>("/api/prompts") });
  const webhooks = useQuery({ queryKey: ["webhooks"], queryFn: () => api<Webhook[]>("/api/webhooks") });
  // Labels synced from the rule's provider, so suggestions cover labels no inbox item carries yet.
  const synced = useQuery({ queryKey: ["labels"], queryFn: () => api<LabelsResponse>("/api/labels"), enabled: isInbox || isWebhook, staleTime: 5 * 60_000 });
  const candidates = (inbox.data?.items ?? []).filter((item) => events.includes(itemEvent(item)));
  // Labels and states are counted within the repos and teams the filter names, so the suggestions fit the rule.
  const repos = termValues(value.filters.query, "repo");
  const teams = termValues(value.filters.query, "team");
  const scoped = candidates.filter((item) => within(repos, item.repo) && within(teams, item.team));
  const syncedLabels = [
    ...(isWebhook || inboxGitHub ? (synced.data?.github ?? []).filter((label) => within(repos, label.scope)) : []),
    ...(inboxLinear ? (synced.data?.linear ?? []).filter((label) => within(teams, label.scope)) : []),
    ...(inboxSentry ? (synced.data?.sentry ?? []) : []),
  ];
  const repoOptions = countOptions([...candidates.flatMap((item) => (item.repo ? [item.repo] : [])), ...runs.flatMap((run) => (run.repo ? [run.repo] : []))]);
  const teamOptions = countOptions(candidates.flatMap((item) => (item.team ? [item.team] : [])));
  const labelOptions = countOptions(
    scoped.flatMap((item) => item.labels),
    syncedLabels.map((label) => label.name),
  );
  const stateOptions = countOptions(scoped.flatMap((item) => [item.state, ...(item.stateType ? [item.stateType] : [])]));
  const tagOptions = countOptions(scoped.flatMap((item) => item.tags));
  // The keys the filter offers for these events, each with its suggested values.
  const filterOptions: FilterOptions = {
    ...((isInbox || isWebhook) && { label: labelOptions, state: stateOptions }),
    ...((inboxLinear || inboxSentry) && { team: teamOptions }),
    ...(isInbox && { reason: REASON_OPTIONS }),
    ...((isWebhook || isSlack || inboxGitHub) && { repo: repoOptions }),
    ...(inboxSentry && { tag: tagOptions }),
    ...(inboxLinear && { has: HAS_VALUES.map((value) => ({ value })) }),
    any: [],
  };

  // What the rule as drafted would fire on, with the matcher's own reason for every miss.
  const previewRule: Rule = { ...value, id, createdAt, updatedAt, livePromptVersion, enabled: true };
  const matches = candidates
    .map((item) => ({
      item,
      why: ruleMismatch(previewRule, itemEvent(item), itemContext(item)),
      run: runs.find((run) => run.ruleId === id && (run.context?.pr_url === item.url || run.context?.issue_url === item.url)) ?? null,
    }))
    .toSorted((a, b) => Number(a.why !== null) - Number(b.why !== null));
  const matched = matches.filter((match) => match.why === null);
  const notRun = matched.filter((match) => !match.run);
  const running = runs.filter((run) => run.ruleId === id && run.status === "started").length;
  const queued = runs.filter((run) => run.ruleId === id && run.status === "queued").length;
  const [runNow, setRunNow] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const backfill = () => {
    setRunNow({ busy: true, error: null });
    api<Run[]>(`/api/rules/${id}/run-now`, { method: "POST" })
      .then(() => setRunNow({ busy: false, error: null }))
      .catch((e: Error) => setRunNow({ busy: false, error: e.message }))
      .finally(onRunsChanged);
  };

  // Preview against the freshest delivery this rule (or this event) has seen, else the first inbox match.
  const sample = runs.find((run) => run.context && (run.ruleId === id || events.includes(run.event)));
  const previewCtx = sample?.context ?? (matched[0] ? itemContext(matched[0].item) : null);
  const previewLabel = sample ? `Preview with delivery from ${timeAgo(sample.createdAt)}` : matched[0] ? `Preview with ${matched[0].item.identifier}` : "Preview";
  // A linked preset replaces the rule's own text when a thread starts, so the preview follows it.
  const linked = prompts.data?.find((prompt) => prompt.id === draft.presetId) ?? null;
  // What the prompt box shows: the linked preset, a version picked to view, or the draft.
  const shownPrompt = linked?.body ?? versions.viewed?.body ?? draft.prompt;
  const preview = previewCtx ? renderTemplate(shownPrompt, previewCtx) : null;

  // A custom webhook's body is `{{payload}}`; its schema's properties are offered as paths into it.
  const payloadVars = (webhooks.data ?? []).filter((webhook) => events.includes(customWebhookEvent(webhook.slug))).flatMap((webhook) => schemaVariables(webhook.payloadSchema));
  const vars = [
    ...(isCustom && !isSlack && !isInbox && !isWebhook
      ? ["default_branch"]
      : TEMPLATE_VARS.filter(
          (name) =>
            (showsPullRequestVars || !name.startsWith("pr_")) &&
            (isSlack || !name.startsWith("slack_")) &&
            (isWebhook || isSlack || !WEBHOOK_ONLY_VARS.has(name)) &&
            (isWebhook || isSlack || inboxIssue || !name.startsWith("issue_")),
        )),
    ...(isCustom ? new Set([...CUSTOM_WEBHOOK_VARS, ...payloadVars]) : []),
  ];

  const insertText = (text: string) => promptRef.current?.insert(text);

  return (
    <div>
      <Toolbar title={draft.name || "Untitled rule"}>
        <span className={cn("ml-auto", error ? "text-destructive" : "text-warn")}>{error ? "Save failed" : dirty ? "Unsaved changes" : ""}</span>
        <Button size="xs" variant="ghost" disabled={!dirty || saving} onClick={discard}>Discard</Button>
        <Button size="xs" variant="outline" disabled={!dirty || saving} onClick={() => void save(false)}>
          {promptChanged ? "Save draft" : "Save"}
        </Button>
        {(promptChanged || versions.base !== history.liveVersion) && (
          <Button size="xs" disabled={saving} onClick={() => void save(true)}>Save and promote</Button>
        )}
        <DeleteButton name={draft.name} onConfirm={() => onDelete(rule)} />
      </Toolbar>

      <form
        className="grid gap-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="grid gap-x-4 gap-y-3 @2xl:grid-cols-2">
          <form.Field name="name">
            {(field) => (
              <Field label="Name">
                <Input autoFocus={rule.name === "New rule"} value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
              </Field>
            )}
          </form.Field>
          <form.Field name="events">
            {(field) => (
              <Field
                label="Events"
                hint={
                  isInbox
                    ? "Fires after each poll for items with activity newer than this rule's last save. Run now below covers what is already in the inbox."
                    : events.includes("slack.message")
                      ? "slack.message fires only for channel messages that link a GitHub PR."
                      : events.includes("slack.second_pass")
                        ? "slack.second_pass fires when the bot is mentioned with 'second pass' (or third, fourth...) inside a review thread. Use {{previous_result}} to hand the agent the previous review."
                        : isCustom
                          ? "A custom webhook fires on every accepted POST to its URL."
                          : "Any selected event starts this rule."
                }
              >
                <EventPicker value={field.state.value} webhooks={webhooks.data ?? []} onChange={field.handleChange} />
              </Field>
            )}
          </form.Field>

          {(isInbox || isWebhook || isSlack) && (
            <form.Field name="filters.query">
              {(field) => (
                <Field
                  label="Filter"
                  className="@2xl:col-span-2"
                  hint={`Labels, ${Object.keys(filterOptions).filter((key) => key !== "label").map((key) => `${key}:`).join(", ")} joined with and, or, ! and parentheses. Empty matches any. any: is text in any field, like !any:i9.${inboxSentry ? " A Sentry issue's label is its level; tag: takes a tag and its value, like tag:service:checkout." : ""}`}
                >
                  <FilterInput value={field.state.value} onChange={field.handleChange} options={filterOptions} placeholder={inboxLinear ? "reason:assigned and state:Todo and !has:parent" : "(bug or p0) and !wontfix"} />
                </Field>
              )}
            </form.Field>
          )}
          {isSlack && (
            <form.Field name="channel">
              {(field) => (
                <Field label="Slack channel" hint="Channel id (C…), from the channel's details. Empty means any channel the bot is in.">
                  <Input className={mono} value={field.state.value ?? ""} onChange={(e) => field.handleChange(e.target.value || null)} placeholder="C0123456789" />
                </Field>
              )}
            </form.Field>
          )}
          {isSlack && (
            <form.Field name="allowBots">
              {(field) => (
                <Field label="Bot posts" hint="Also fire for PR links posted by other bots and apps, such as another orchestrator's agents or GitHub notifications. This bot's own posts never fire.">
                  <label className="flex h-8 items-center gap-2 text-[13px]">
                    <Switch size="sm" checked={field.state.value} onCheckedChange={field.handleChange} />
                    <span className={cn(!field.state.value && "text-muted-foreground")}>{field.state.value ? "Reviewed" : "Ignored"}</span>
                  </label>
                </Field>
              )}
            </form.Field>
          )}
          {isWebhook && (
            <form.Field name="reviewer">
              {(field) => (
                <Field label="Requested reviewer" hint="Fire only when this user or team is requested. Empty means anyone.">
                  <Input value={field.state.value ?? ""} onChange={(e) => field.handleChange(e.target.value || null)} placeholder="login or team slug" />
                </Field>
              )}
            </form.Field>
          )}
          {showsPullRequestVars && (
            <form.Field name="skipSelfReview">
              {(field) => (
                <Field
                  label="Skip my own PRs"
                  hint={githubLogin ? `PRs authored by ${githubLogin} are recorded as skipped.` : "Set your GitHub login in Settings to make this take effect."}
                >
                  <label className="flex h-8 items-center gap-2 text-[13px]">
                    <Switch size="sm" checked={field.state.value} onCheckedChange={field.handleChange} />
                    <span className={cn(!field.state.value && "text-muted-foreground")}>{field.state.value ? "Skipped" : "Reviewed like any other PR"}</span>
                  </label>
                </Field>
              )}
            </form.Field>
          )}
          {inboxPr && (
            <form.Field name="filters.rerunOnPush">
              {(field) => (
                <Field label="Re-run on push" hint="Each new head commit gets its own run, like pull_request.synchronize. Off runs once per PR.">
                  <label className="flex h-8 items-center gap-2 text-[13px]">
                    <Switch size="sm" checked={field.state.value} onCheckedChange={field.handleChange} />
                    <span className={cn(!field.state.value && "text-muted-foreground")}>{field.state.value ? "Per head commit" : "Once per PR"}</span>
                  </label>
                </Field>
              )}
            </form.Field>
          )}
          <form.Field name="maxConcurrent">
            {(field) => (
              <Field label="Concurrency" hint="Threads of this rule running at once. Further matches queue and start as earlier ones settle. 0 is unlimited.">
                <div className="flex h-8 items-center gap-3">
                  <Input type="number" min={0} className={cn("w-20", mono)} value={field.state.value} onChange={(e) => field.handleChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
                  <span className="text-xs text-muted-foreground">
                    {running} running{queued > 0 ? ` · ${queued} queued` : ""}
                  </span>
                </div>
              </Field>
            )}
          </form.Field>

          <form.Field name="projectId">
            {(field) => (
              <Field
                label="T3 project"
                hint={
                  field.state.value
                    ? undefined
                    : needsProject
                      ? `${inboxSentry ? "Sentry issues have" : inboxLinear ? "Linear issues have" : "A custom webhook has"} no repository: pick a project.`
                      : isSlack
                        ? "Matched by comparing the PR linked in the message to each project's git remote."
                        : "Matched by comparing the repository to each project's git remote."
                }
              >
                <Select value={field.state.value ?? AUTO_PROJECT} onValueChange={(v) => field.handleChange(v === AUTO_PROJECT ? null : v)}>
                  <SelectTrigger size="sm" className={cn("w-full", needsProject && !field.state.value && "border-warn")}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO_PROJECT}>Auto by git remote</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.title}
                        {p.repositoryIdentity?.owner && <span className="ml-1 text-muted-foreground">{p.repositoryIdentity.owner}/{p.repositoryIdentity.name}</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </form.Field>
          <form.Field name="workspace">
            {(field) => (
              <Field label="Workspace">
                <Select value={field.state.value} onValueChange={(v) => field.handleChange(v as typeof field.state.value)}>
                  <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WORKSPACE_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {mode === "worktree" ? "Worktree from PR head (default branch otherwise)" : "Local project checkout"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </form.Field>
          <form.Field name="model">
            {(field) => (
              <Field label="Model" className="@2xl:col-span-2">
                <div className="flex flex-wrap gap-2">
                  <Select
                    value={field.state.value ? "override" : "default"}
                    onValueChange={(v) => field.handleChange(v === "override" ? firstAvailableModel(providers) ?? { instanceId: "claudeAgent", model: "claude-fable-5-1" } : null)}
                  >
                    <SelectTrigger size="sm" className="w-56"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">
                        {project?.defaultModelSelection ? `Project default (${project.defaultModelSelection.model})` : "Project default, else global"}
                      </SelectItem>
                      <SelectItem value="override">Override for this rule</SelectItem>
                    </SelectContent>
                  </Select>
                  {field.state.value && <ModelPicker value={field.state.value} providers={providers} onChange={field.handleChange} />}
                </div>
              </Field>
            )}
          </form.Field>
        </div>

        {isInbox && (
          <Field
            label={inbox.data ? `Matches now · ${matched.length} of ${candidates.length} in the inbox` : "Matches now"}
            hint={!enabled ? "This rule is off; matches are shown as if it were on." : undefined}
          >
            {!inbox.data ? (
              <span className="text-xs text-muted-foreground">Loading the inbox…</span>
            ) : candidates.length === 0 ? (
              <span className="text-xs text-muted-foreground">No inbox items for these events yet.</span>
            ) : (
              <MatchesTable matches={matches} />
            )}
            {inbox.data && (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {notRun.length > 0 && (
                  <Button size="xs" variant="outline" onClick={backfill} disabled={runNow.busy}>
                    {runNow.busy ? "Starting…" : `Run on ${notRun.length} now`}
                  </Button>
                )}
                <span>
                  {matched.length - notRun.length > 0 && `${matched.length - notRun.length} already ran. `}
                  New or re-enabled rules react to activity after they are saved; Run now backfills on purpose.
                </span>
                {runNow.error && <span className="text-destructive">{runNow.error}</span>}
              </div>
            )}
          </Field>
        )}

        <form.Field name="prompt">
          {(field) => (
            <Field
              label="Prompt"
              hint={
                linked
                  ? `Follows the live version of the preset "${linked.name}": promoting one in Settings changes this rule too.`
                  : `First message of the thread. Runs use the live version. Click a variable to insert it at the cursor.${isSlack ? " The final reply is posted back to the Slack thread." : ""}`
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                {prompts.data && prompts.data.length > 0 && (
                  <form.Field name="presetId">
                    {(preset) => (
                      <>
                        <Select value={linked?.id ?? OWN_PROMPT} onValueChange={(v) => preset.handleChange(v === OWN_PROMPT ? null : v)}>
                          <SelectTrigger size="sm" className="w-64"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value={OWN_PROMPT}>Write it here</SelectItem>
                            {prompts.data.map((prompt) => (
                              <SelectItem key={prompt.id} value={prompt.id}>Preset: {prompt.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {linked && (
                          <>
                            <Button size="xs" variant="ghost" className="text-primary" onClick={() => { field.handleChange(linked.body); preset.handleChange(null); }}>
                              Unlink and edit a copy
                            </Button>
                            <Link to="/settings" hash="presets" className="link text-xs text-primary">Edit preset</Link>
                          </>
                        )}
                      </>
                    )}
                  </form.Field>
                )}
                {!linked && <VersionSelect versions={versions} onEditFrom={field.handleChange} />}
              </div>
              <PromptEditor
                ref={promptRef}
                className={cn("min-h-52 leading-relaxed", mono, versions.viewed && !linked && "text-muted-foreground")}
                value={shownPrompt}
                readOnly={linked !== null || versions.viewed !== null}
                source={eventsService(events)}
                onChange={field.handleChange}
              />
              {!linked && !versions.viewed && (
                <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5">
                  {vars.map((name) => (
                    <Button key={name} variant="ghost" size="xs" className={cn("h-5 px-1 text-primary", mono)} onClick={() => insertText(`{{${name}}}`)}>
                      {`{{${name}}}`}
                    </Button>
                  ))}
                  {prompts.data && prompts.data.length > 0 && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button type="button" variant="ghost" size="xs" className="h-5 px-1 text-primary">insert preset ▾</Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-64 p-1">
                        {prompts.data.map((prompt) => (
                          <button key={prompt.id} type="button" className="block w-full rounded px-2 py-1 text-left text-[13px] hover:bg-muted/60" onClick={() => insertText((field.state.value && !field.state.value.endsWith("\n") ? "\n\n" : "") + prompt.body)}>
                            {prompt.name}
                          </button>
                        ))}
                        <p className="px-2 pt-1 text-[11px] text-muted-foreground">
                          Inserts a copy. Pick "Preset: …" above to follow a preset instead. Presets are managed in <Link to="/settings" hash="presets" className="link text-primary">Settings</Link>.
                        </p>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              )}
            </Field>
          )}
        </form.Field>

        <Field label={previewLabel}>
          {preview ? (
            <pre className={cn("max-h-48 overflow-auto rounded-md border bg-input/20 p-3 whitespace-pre-wrap text-muted-foreground", mono)}>{preview}</pre>
          ) : (
            <span className="text-xs text-muted-foreground">{isInbox ? "Appears once an inbox item matches." : "Appears after the first delivery matching this event."}</span>
          )}
        </Field>
      </form>
    </div>
  );
}

/** What gets saved: blank reviewer and channel become null, like an untouched field. */
type Match = { item: InboxItem; why: string | null; run: Run | null };

const MATCH_ROWS = 20;

/** Matching items first with what this rule did for them, then the misses with the matcher's reason. */
function MatchesTable({ matches }: { matches: Match[] }) {
  const [all, setAll] = useState(false);
  const rows = all ? matches : matches.slice(0, MATCH_ROWS);
  // Linear teams and Sentry projects; a rule polls one source, so one header fits.
  const team = matches.find((match) => match.item.team)?.item;
  const cell = "py-1 align-top";
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Labels</TableHead>
            {team && <TableHead>{team.source === "sentry" ? "Project" : "Team"}</TableHead>}
            <TableHead>Reasons</TableHead>
            <TableHead>This rule</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_tr:last-child]:border-0">
          {rows.map(({ item, why, run }) => (
            <TableRow key={item.key} className={cn(why !== null && "text-muted-foreground/70")}>
              <TableCell className={cn(cell, mono)}>
                <ExternalLink href={item.url}>{item.repo ? `${item.repo} ${item.identifier}` : item.identifier}</ExternalLink>
              </TableCell>
              <TableCell className={cn(cell, "min-w-40 whitespace-normal")}>{item.title}</TableCell>
              <TableCell className={cell}>{item.state}</TableCell>
              <TableCell className={cn(cell, "min-w-28 break-words whitespace-normal", mono)}>{item.labels.join(", ")}</TableCell>
              {team && <TableCell className={cell}>{item.team}</TableCell>}
              <TableCell className={cn(cell, "whitespace-normal")}>{item.reasons.map((reason) => INBOX_REASON_LABELS[reason]).join(", ")}</TableCell>
              <TableCell className={cn(cell, "min-w-40 whitespace-normal")}>
                {why !== null ? (
                  why
                ) : run ? (
                  <RunStatus run={run}>
                    {timeAgo(run.createdAt)}
                    {run.threadUrl && (
                      <>
                        {" · "}
                        <ExternalLink href={run.threadUrl}>thread</ExternalLink>
                      </>
                    )}
                  </RunStatus>
                ) : (
                  <span className="text-ok">matches · not run yet</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {matches.length > MATCH_ROWS && (
        <button type="button" className="w-full border-t px-2 py-1 text-left text-xs text-primary hover:bg-muted/40" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `${matches.length - MATCH_ROWS} more`}
        </button>
      )}
    </div>
  );
}

/** Distinct values with how often they occur, most common first; `known` values that never occur follow, uncounted. */
function countOptions(values: string[], known: string[] = []): TokenOption[] {
  const counts = new Map<string, TokenOption>();
  for (const value of values) {
    const key = value.toLowerCase();
    const entry = counts.get(key);
    if (entry) entry.count = (entry.count ?? 0) + 1;
    else counts.set(key, { value, count: 1 });
  }
  for (const value of known) if (!counts.has(value.toLowerCase())) counts.set(value.toLowerCase(), { value });
  return [...counts.values()].toSorted((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.value.localeCompare(b.value));
}

/** True when nothing is wanted, the value is unscoped (a Linear workspace label, a GitHub item's team), or it is one of the wanted names. */
function within(wanted: string[], name: string | null): boolean {
  return wanted.length === 0 || !name || wanted.some((w) => sameName(w, name));
}

type EventOption = { key: string; label: string };

/**
 * Multi-select of event keys in two panes: the sources on the left, with how
 * many of each are picked, and the open source's events on the right. Custom
 * webhooks defined in Settings list under Webhooks. Keys saved via the API
 * that are not offered (or whose webhook was deleted) stay selected and list
 * under their source by key. Picking an inbox event of one source drops the
 * other source's inbox events: a rule polls one source.
 */
function EventPicker({ value, webhooks, onChange }: { value: string[]; webhooks: Webhook[]; onChange: (events: string[]) => void }) {
  const offered: EventOption[] = [...SUGGESTED_EVENTS, ...webhooks.map((webhook) => ({ key: customWebhookEvent(webhook.slug), label: webhook.name }))];
  const unknown = value.filter((key) => !offered.some((e) => e.key === key)).map((key) => ({ key, label: key }));
  const options = [...offered, ...unknown];
  const ofSource = (source: EventSource) => options.filter((e) => eventSource(e.key) === source);
  const [open, setOpen] = useState<EventSource>(() => (value[0] ? eventSource(value[0]) : "github"));

  const toggle = (key: string, checked: boolean) => {
    const source = inboxSource(key);
    const otherSource = (k: string) => source !== null && inboxSource(k) !== null && inboxSource(k) !== source;
    const next = checked ? [...value.filter((k) => !otherSource(k)), key] : value.filter((k) => k !== key);
    if (next.length > 0) onChange(next);
  };
  const labelOf = (key: string) => options.find((e) => e.key === key)?.label ?? key;
  // `GitHub PR opened, PR labeled · Slack Bot mentioned`: picks grouped by source.
  const picked = EVENT_SOURCES.map((source) => ({ ...source, keys: value.filter((key) => eventSource(key) === source.id) })).filter((source) => source.keys.length > 0);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-start truncate font-normal">
          <span className="truncate">
            {picked.map((source, i) => (
              <span key={source.id}>
                <span className="text-muted-foreground">{i > 0 && " · "}{source.label} </span>
                {source.keys.map(labelOf).join(", ")}
              </span>
            ))}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-[30rem] grid-cols-[8.5rem_1fr] p-0">
        <nav className="border-r p-1">
          {EVENT_SOURCES.map((source) => {
            const count = value.filter((key) => eventSource(key) === source.id).length;
            return (
              <button
                key={source.id}
                type="button"
                onClick={() => setOpen(source.id)}
                className={cn("flex w-full items-center rounded px-2 py-1.5 text-left text-[13px] hover:bg-muted/60", open === source.id && "bg-muted")}
              >
                {source.label}
                {count > 0 && <span className="ml-auto text-xs text-muted-foreground">{count}</span>}
              </button>
            );
          })}
        </nav>
        <div className="h-80 overflow-auto p-1">
          {open === "inbox" && <GroupLabel className="px-2 py-1">One source per rule</GroupLabel>}
          {ofSource(open).map((event) => {
            const checked = value.includes(event.key);
            return (
              <label key={event.key} title={event.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] hover:bg-muted/60">
                <Checkbox checked={checked} disabled={checked && value.length === 1} onCheckedChange={(v) => toggle(event.key, v === true)} />
                <span className="truncate">{event.label}</span>
              </label>
            );
          })}
          {open === "webhook" && (
            <Link to="/settings" hash="webhooks" className="link block px-2 py-1 text-[13px] text-primary">
              {webhooks.length === 0 ? "Define one in Settings" : "Manage in Settings"}
            </Link>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DeleteButton({ name, onConfirm }: { name: string; onConfirm: () => Promise<void> }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="xs" variant="ghost" className="text-destructive">Delete</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{name || "Untitled rule"}"?</AlertDialogTitle>
          <AlertDialogDescription>Past runs stay in the log. Threads already started in T3 are not affected.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
