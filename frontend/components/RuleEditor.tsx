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
import { Textarea } from "@/components/ui/textarea";
import { firstAvailableModel } from "@/components/DispatchDialog";
import { ExternalLink, Field, GroupLabel, RunStatus } from "@/components/Field";
import { ModelPicker } from "@/components/ModelPicker";
import { TokenInput, type TokenOption } from "@/components/TokenInput";
import { Toolbar } from "@/components/Toolbar";
import { api, timeAgo } from "@/lib/api";
import { saveLabel, useAutosave } from "@/lib/useAutosave";
import { cn } from "@/lib/utils";
import { itemContext, itemEvent, type InboxItem, type InboxResponse } from "../../src/inbox.ts";
import { ruleMismatch, sameName } from "../../src/match.ts";
import type { Prompt, Rule, RuleInput, Run } from "../../src/rules.ts";
import {
  INBOX_EVENT_PREFIX,
  INBOX_REASON_LABELS,
  INBOX_REASONS,
  SLACK_EVENT_PREFIX,
  SUGGESTED_EVENTS,
  TEMPLATE_VARS,
  WORKSPACE_MODES,
  type RuleFilters,
} from "../../src/shared.ts";
import type { T3Project, T3Provider } from "../../src/t3.ts";
import { renderTemplate } from "../../src/template.ts";

/** Radix Select cannot hold an empty string, so "auto" gets a sentinel. */
const AUTO_PROJECT = "__auto__";
const mono = "font-mono text-xs";

/** Variables only webhook payloads carry; hidden on rules that listen to the inbox alone, and from dispatch presets. */
export const WEBHOOK_ONLY_VARS = new Set(["event", "action", "sender", "requested_reviewer", "comment_body", "comment_author", "comment_url", "review_state", "review_body", "review_author", "label"]);

const REASON_OPTIONS: TokenOption[] = INBOX_REASONS.map((reason) => ({ value: reason, label: INBOX_REASON_LABELS[reason] }));

export function RuleEditor({
  rule,
  projects,
  providers,
  runs,
  githubLogin,
  onSave,
  onDelete,
  onRunsChanged,
}: {
  rule: Rule;
  projects: T3Project[];
  providers: T3Provider[] | null;
  runs: Run[];
  /** GitHub login from settings; null means "Skip my own PRs" has nothing to compare against. */
  githubLogin: string | null;
  onSave: (id: string, input: RuleInput) => Promise<void>;
  onDelete: (rule: Rule) => Promise<void>;
  /** Called after "Run now" so the run log refreshes without waiting for its poll. */
  onRunsChanged: () => void;
}) {
  const { id, createdAt, updatedAt, ...initial } = rule;
  const [draft, setDraft] = useState<RuleInput>(initial);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const value = useMemo<RuleInput>(
    () => ({ ...draft, reviewer: draft.reviewer?.trim() || null, channel: draft.channel?.trim() || null }),
    [draft],
  );
  const { state, error } = useAutosave(value, (input) => onSave(id, input));

  const patch = (partial: Partial<RuleInput>) => setDraft((d) => ({ ...d, ...partial }));
  const patchFilters = (partial: Partial<RuleFilters>) => setDraft((d) => ({ ...d, filters: { ...d.filters, ...partial } }));

  const events = draft.events;
  const isSlack = events.some((event) => event.startsWith(SLACK_EVENT_PREFIX));
  const isInbox = events.some((event) => event.startsWith(INBOX_EVENT_PREFIX));
  const isWebhook = events.some((event) => !event.startsWith(SLACK_EVENT_PREFIX) && !event.startsWith(INBOX_EVENT_PREFIX));
  const inboxLinear = events.includes("inbox.linear.issue");
  const inboxGitHub = events.some((event) => event.startsWith("inbox.github."));
  const inboxPr = events.includes("inbox.github.pull_request");
  const inboxIssue = events.some((event) => event.startsWith(INBOX_EVENT_PREFIX) && event.endsWith(".issue"));
  // Slack messages carry PR variables once a PR link is found in the text.
  const showsPullRequestVars = events.some((event) => event.startsWith("pull_request")) || isSlack || inboxPr;
  const project = projects.find((p) => p.id === draft.projectId);

  // Inbox items feed the token suggestions and the match preview; only fetched for inbox rules.
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => api<InboxResponse>("/api/inbox"), refetchInterval: 15_000, enabled: isInbox });
  const prompts = useQuery({ queryKey: ["prompts"], queryFn: () => api<Prompt[]>("/api/prompts") });
  const candidates = (inbox.data?.items ?? []).filter((item) => events.includes(itemEvent(item)));
  // Labels and states are counted within the chosen repos and teams, so the suggestions fit the rule.
  const scoped = candidates.filter(
    (item) =>
      (value.repos.length === 0 || !item.repo || value.repos.some((repo) => sameName(repo, item.repo!))) &&
      (value.filters.teams.length === 0 || !item.team || value.filters.teams.some((team) => sameName(team, item.team!))),
  );
  const repoOptions = countOptions([...candidates.flatMap((item) => (item.repo ? [item.repo] : [])), ...runs.flatMap((run) => (run.repo ? [run.repo] : []))]);
  const teamOptions = countOptions(candidates.flatMap((item) => (item.team ? [item.team] : [])));
  const labelOptions = countOptions(scoped.flatMap((item) => item.labels));
  const stateOptions = countOptions(scoped.flatMap((item) => [item.state, ...(item.stateType ? [item.stateType] : [])]));

  // What the rule as drafted would fire on, with the matcher's own reason for every miss.
  const previewRule: Rule = { ...value, id, createdAt, updatedAt, enabled: true };
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
  const preview = previewCtx ? renderTemplate(draft.prompt, previewCtx) : null;

  const vars = TEMPLATE_VARS.filter(
    (name) =>
      (showsPullRequestVars || !name.startsWith("pr_")) &&
      (isSlack || !name.startsWith("slack_")) &&
      (isWebhook || isSlack || !WEBHOOK_ONLY_VARS.has(name)) &&
      (isWebhook || isSlack || inboxIssue || !name.startsWith("issue_")),
  );

  const insertText = (text: string) => {
    const textarea = promptRef.current;
    if (!textarea) return patch({ prompt: draft.prompt + text });
    const { selectionStart, selectionEnd } = textarea;
    patch({ prompt: draft.prompt.slice(0, selectionStart) + text + draft.prompt.slice(selectionEnd) });
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(selectionStart + text.length, selectionStart + text.length);
    });
  };

  return (
    <div>
      <Toolbar title={draft.name || "Untitled rule"}>
        <span className={cn("ml-auto text-muted-foreground", state === "error" && "text-destructive")} title={error ?? undefined}>
          {saveLabel(state)}
        </span>
        <DeleteButton name={draft.name} onConfirm={() => onDelete(rule)} />
      </Toolbar>

      <div className="grid gap-4 p-4">
        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
          <Field label="Name">
            <Input autoFocus={rule.name === "New rule"} value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
          </Field>
          <Field
            label="Events"
            hint={
              isInbox
                ? "Fires after each poll for items with activity newer than this rule's last save. Run now below covers what is already in the inbox."
                : draft.events.includes("slack.message")
                  ? "slack.message fires only for channel messages that link a GitHub PR."
                  : draft.events.includes("slack.second_pass")
                    ? "slack.second_pass fires when the bot is mentioned with 'second pass' inside a review thread. Use {{previous_result}} to hand the agent the first review."
                    : "Any selected event starts this rule."
            }
          >
            <EventPicker value={draft.events} onChange={(events) => patch({ events })} />
          </Field>

          {(isWebhook || isSlack || inboxGitHub) && (
            <Field label="Repositories" hint={isSlack ? "owner/name of the PR linked in the message. Empty matches any." : "owner/name. Empty matches every repository."}>
              <TokenInput value={draft.repos} onChange={(repos) => patch({ repos })} options={repoOptions} placeholder="owner/name" />
            </Field>
          )}
          {inboxLinear && (
            <Field label="Teams" hint="Linear team keys. Empty matches every team.">
              <TokenInput value={draft.filters.teams} onChange={(teams) => patchFilters({ teams })} options={teamOptions} placeholder="ENG" />
            </Field>
          )}
          {isInbox && (
            <Field label="Reasons" hint="Why the item is in your inbox; any of the listed. Empty matches any.">
              <TokenInput value={draft.filters.reasons} onChange={(reasons) => patchFilters({ reasons: reasons as RuleFilters["reasons"] })} options={REASON_OPTIONS} optionsOnly placeholder="review requested, assigned to me, …" />
            </Field>
          )}
          {isInbox && (
            <Field label="States" hint={inboxLinear ? "State name (Todo) or type (unstarted, started). Any of the listed." : "open or draft. Any of the listed."}>
              <TokenInput value={draft.filters.states} onChange={(states) => patchFilters({ states })} options={stateOptions} placeholder={inboxLinear ? "Todo" : "open"} />
            </Field>
          )}
          {(isInbox || isWebhook) && (
            <Field
              label={
                <>
                  Labels ·{" "}
                  <button type="button" className="text-primary normal-case tracking-normal" onClick={() => patchFilters({ allLabels: !draft.filters.allLabels })}>
                    {draft.filters.allLabels ? "all" : "any"} ▾
                  </button>{" "}
                  of
                </>
              }
              hint={draft.filters.allLabels ? "Every listed label must be present. Empty matches any." : "At least one listed label must be present. Empty matches any."}
            >
              <TokenInput value={draft.filters.labels} onChange={(labels) => patchFilters({ labels })} options={labelOptions} placeholder="label" />
            </Field>
          )}

          {isSlack && (
            <Field label="Slack channel" hint="Channel id (C…), from the channel's details. Empty means any channel the bot is in.">
              <Input className={mono} value={draft.channel ?? ""} onChange={(e) => patch({ channel: e.target.value || null })} placeholder="C0123456789" />
            </Field>
          )}
          {isSlack && (
            <Field label="Bot posts" hint="Also fire for PR links posted by other bots and apps, such as another orchestrator's agents or GitHub notifications. This bot's own posts never fire.">
              <label className="flex h-8 items-center gap-2 text-[13px]">
                <Switch size="sm" checked={draft.allowBots} onCheckedChange={(allowBots) => patch({ allowBots })} />
                <span className={cn(!draft.allowBots && "text-muted-foreground")}>{draft.allowBots ? "Reviewed" : "Ignored"}</span>
              </label>
            </Field>
          )}
          {isWebhook && (
            <Field label="Requested reviewer" hint="Fire only when this user or team is requested. Empty means anyone.">
              <Input value={draft.reviewer ?? ""} onChange={(e) => patch({ reviewer: e.target.value || null })} placeholder="login or team slug" />
            </Field>
          )}
          {showsPullRequestVars && (
            <Field
              label="Skip my own PRs"
              hint={githubLogin ? `PRs authored by ${githubLogin} are recorded as skipped.` : "Set your GitHub login in Settings to make this take effect."}
            >
              <label className="flex h-8 items-center gap-2 text-[13px]">
                <Switch size="sm" checked={draft.skipSelfReview} onCheckedChange={(skipSelfReview) => patch({ skipSelfReview })} />
                <span className={cn(!draft.skipSelfReview && "text-muted-foreground")}>{draft.skipSelfReview ? "Skipped" : "Reviewed like any other PR"}</span>
              </label>
            </Field>
          )}
          {inboxPr && (
            <Field label="Re-run on push" hint="Each new head commit gets its own run, like pull_request.synchronize. Off runs once per PR.">
              <label className="flex h-8 items-center gap-2 text-[13px]">
                <Switch size="sm" checked={draft.filters.rerunOnPush} onCheckedChange={(rerunOnPush) => patchFilters({ rerunOnPush })} />
                <span className={cn(!draft.filters.rerunOnPush && "text-muted-foreground")}>{draft.filters.rerunOnPush ? "Per head commit" : "Once per PR"}</span>
              </label>
            </Field>
          )}
          <Field label="Concurrency" hint="Threads of this rule running at once. Further matches queue and start as earlier ones settle. 0 is unlimited.">
            <div className="flex h-8 items-center gap-3">
              <Input type="number" min={0} className={cn("w-20", mono)} value={draft.maxConcurrent} onChange={(e) => patch({ maxConcurrent: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
              <span className="text-xs text-muted-foreground">
                {running} running{queued > 0 ? ` · ${queued} queued` : ""}
              </span>
            </div>
          </Field>

          <Field
            label="T3 project"
            hint={
              draft.projectId
                ? undefined
                : inboxLinear
                  ? "Linear issues have no repository: pick a project."
                  : isSlack
                    ? "Matched by comparing the PR linked in the message to each project's git remote."
                    : "Matched by comparing the repository to each project's git remote."
            }
          >
            <Select value={draft.projectId ?? AUTO_PROJECT} onValueChange={(v) => patch({ projectId: v === AUTO_PROJECT ? null : v })}>
              <SelectTrigger size="sm" className={cn("w-full", inboxLinear && !draft.projectId && "border-warn")}><SelectValue /></SelectTrigger>
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
          <Field label="Workspace">
            <Select value={draft.workspace} onValueChange={(v) => patch({ workspace: v as RuleInput["workspace"] })}>
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
          <Field label="Model" className="md:col-span-2">
            <div className="flex flex-wrap gap-2">
              <Select
                value={draft.model ? "override" : "default"}
                onValueChange={(v) => patch({ model: v === "override" ? firstAvailableModel(providers) ?? { instanceId: "claudeAgent", model: "claude-fable-5-1" } : null })}
              >
                <SelectTrigger size="sm" className="w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">
                    {project?.defaultModelSelection ? `Project default (${project.defaultModelSelection.model})` : "Project default, else global"}
                  </SelectItem>
                  <SelectItem value="override">Override for this rule</SelectItem>
                </SelectContent>
              </Select>
              {draft.model && <ModelPicker value={draft.model} providers={providers} onChange={(model) => patch({ model })} />}
            </div>
          </Field>
        </div>

        {isInbox && (
          <Field
            label={inbox.data ? `Matches now · ${matched.length} of ${candidates.length} in the inbox` : "Matches now"}
            hint={!draft.enabled ? "This rule is off; matches are shown as if it were on." : undefined}
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

        <Field label="Prompt" hint={`First message of the thread. Click a variable to insert it at the cursor.${isSlack ? " The final reply is posted back to the Slack thread." : ""}`}>
          <Textarea ref={promptRef} className={cn("min-h-52 leading-relaxed", mono)} value={draft.prompt} onChange={(e) => patch({ prompt: e.target.value })} />
          <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5">
            {vars.map((name) => (
              <Button key={name} type="button" variant="ghost" size="xs" className={cn("h-5 px-1 text-primary", mono)} onClick={() => insertText(`{{${name}}}`)}>
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
                    <button key={prompt.id} type="button" className="block w-full rounded px-2 py-1 text-left text-[13px] hover:bg-muted/60" onClick={() => insertText((draft.prompt && !draft.prompt.endsWith("\n") ? "\n\n" : "") + prompt.body)}>
                      {prompt.name}
                    </button>
                  ))}
                  <p className="px-2 pt-1 text-[11px] text-muted-foreground">
                    Presets are managed in <Link to="/settings" hash="presets" className="link text-primary">Settings</Link>.
                  </p>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </Field>

        <Field label={previewLabel}>
          {preview ? (
            <pre className={cn("max-h-48 overflow-auto rounded-md border bg-input/20 p-3 whitespace-pre-wrap text-muted-foreground", mono)}>{preview}</pre>
          ) : (
            <span className="text-xs text-muted-foreground">{isInbox ? "Appears once an inbox item matches." : "Appears after the first delivery matching this event."}</span>
          )}
        </Field>
      </div>
    </div>
  );
}

type Match = { item: InboxItem; why: string | null; run: Run | null };

const MATCH_ROWS = 20;

/** Matching items first with what this rule did for them, then the misses with the matcher's reason. */
function MatchesTable({ matches }: { matches: Match[] }) {
  const [all, setAll] = useState(false);
  const rows = all ? matches : matches.slice(0, MATCH_ROWS);
  const linear = matches.some((match) => match.item.source === "linear");
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
            {linear && <TableHead>Team</TableHead>}
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
              {linear && <TableCell className={cell}>{item.team}</TableCell>}
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

/** Distinct values with how often they occur, most common first. */
function countOptions(values: string[]): TokenOption[] {
  const counts = new Map<string, { value: string; count: number }>();
  for (const value of values) {
    const key = value.toLowerCase();
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { value, count: 1 });
  }
  return [...counts.values()].toSorted((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

const EVENT_GROUPS = [
  { label: "GitHub webhook", events: SUGGESTED_EVENTS.filter((e) => !e.key.startsWith(SLACK_EVENT_PREFIX) && !e.key.startsWith(INBOX_EVENT_PREFIX)) },
  { label: "Slack", events: SUGGESTED_EVENTS.filter((e) => e.key.startsWith(SLACK_EVENT_PREFIX)) },
  { label: "Inbox (polled)", events: SUGGESTED_EVENTS.filter((e) => e.key.startsWith(INBOX_EVENT_PREFIX)) },
];

/** Multi-select of event keys. Keys saved via the API that are not in the list stay selected and show under "Custom". */
function EventPicker({ value, onChange }: { value: string[]; onChange: (events: string[]) => void }) {
  const known = new Set<string>(SUGGESTED_EVENTS.map((e) => e.key));
  const custom = value.filter((key) => !known.has(key)).map((key) => ({ key, label: key }));
  const groups = custom.length > 0 ? [...EVENT_GROUPS, { label: "Custom", events: custom }] : EVENT_GROUPS;
  const toggle = (key: string, checked: boolean) => {
    const next = checked ? [...value, key] : value.filter((k) => k !== key);
    if (next.length > 0) onChange(next);
  };
  const labelOf = (key: string) => SUGGESTED_EVENTS.find((e) => e.key === key)?.label ?? key;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-start truncate font-normal">
          <span className="truncate">{value.map(labelOf).join(", ") || "Pick events"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-2">
        {groups.map((group) => (
          <div key={group.label} className="mb-2 last:mb-0">
            <GroupLabel className="px-2 py-1">{group.label}</GroupLabel>
            {group.events.map((event) => {
              const checked = value.includes(event.key);
              return (
                <label key={event.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] hover:bg-muted/60">
                  <Checkbox checked={checked} disabled={checked && value.length === 1} onCheckedChange={(v) => toggle(event.key, v === true)} />
                  <span>{event.label}</span>
                  <span className={cn("ml-auto text-muted-foreground", mono)}>{event.key}</span>
                </label>
              );
            })}
          </div>
        ))}
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
