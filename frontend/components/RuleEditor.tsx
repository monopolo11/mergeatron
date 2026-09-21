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
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/Header";
import { timeAgo } from "@/lib/api";
import { saveLabel, useAutosave } from "@/lib/useAutosave";
import { cn } from "@/lib/utils";
import type { Rule, RuleInput, Run } from "../../src/rules.ts";
import { SLACK_EVENT_PREFIX, SUGGESTED_EVENTS, TEMPLATE_VARS, WORKSPACE_MODES } from "../../src/shared.ts";
import type { T3Project, T3Provider } from "../../src/t3.ts";
import { ModelPicker } from "@/components/ModelPicker";
import { renderTemplate } from "../../src/template.ts";

/** Radix Select cannot hold an empty string, so "auto" gets a sentinel. */
const AUTO_PROJECT = "__auto__";
const mono = "font-mono text-xs";

export function RuleEditor({
  rule,
  projects,
  providers,
  runs,
  onSave,
  onDelete,
}: {
  rule: Rule;
  projects: T3Project[];
  providers: T3Provider[] | null;
  runs: Run[];
  onSave: (id: string, input: RuleInput) => Promise<void>;
  onDelete: (rule: Rule) => Promise<void>;
}) {
  const { id, createdAt, updatedAt, ...initial } = rule;
  const [draft, setDraft] = useState<RuleInput>(initial);
  const [reposText, setReposText] = useState(initial.repos.join(", "));
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const value = useMemo<RuleInput>(
    () => ({
      ...draft,
      repos: reposText.split(",").map((s) => s.trim()).filter(Boolean),
      reviewer: draft.reviewer?.trim() || null,
      channel: draft.channel?.trim() || null,
    }),
    [draft, reposText],
  );
  const { state, error } = useAutosave(value, (input) => onSave(id, input));

  const patch = (partial: Partial<RuleInput>) => setDraft((d) => ({ ...d, ...partial }));
  const isSlackEvent = draft.events.some((event) => event.startsWith(SLACK_EVENT_PREFIX));
  const isGitHubEvent = draft.events.some((event) => !event.startsWith(SLACK_EVENT_PREFIX));
  // Slack messages carry PR variables once a PR link is found in the text.
  const showsPullRequestVars = draft.events.some((event) => event.startsWith("pull_request")) || isSlackEvent;
  const project = projects.find((p) => p.id === draft.projectId);

  // Preview against the freshest delivery this rule (or this event) has seen.
  const sample = runs.find((run) => run.context && (run.ruleId === id || draft.events.includes(run.event)));
  const preview = sample?.context ? renderTemplate(draft.prompt, sample.context) : null;

  const insertVar = (name: string) => {
    const textarea = promptRef.current;
    const token = `{{${name}}}`;
    if (!textarea) return patch({ prompt: draft.prompt + token });
    const { selectionStart, selectionEnd } = textarea;
    patch({ prompt: draft.prompt.slice(0, selectionStart) + token + draft.prompt.slice(selectionEnd) });
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(selectionStart + token.length, selectionStart + token.length);
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 flex h-9 items-center gap-3 border-b bg-background px-4 text-xs">
        <span className="truncate font-medium text-foreground">{draft.name || "Untitled rule"}</span>
        <span className={cn("ml-auto text-muted-foreground", state === "error" && "text-destructive")} title={error ?? undefined}>
          {saveLabel(state)}
        </span>
        <DeleteButton name={draft.name} onConfirm={() => onDelete(rule)} />
      </div>

      <div className="grid gap-4 p-4">
        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
          <Field label="Name">
            <Input className="h-8" autoFocus={rule.name === "New rule"} value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
          </Field>
          <Field
            label="Events"
            hint={
              draft.events.includes("slack.message")
                ? "slack.message fires only for channel messages that link a GitHub PR."
                : draft.events.includes("slack.second_pass")
                  ? "slack.second_pass fires when the bot is mentioned with 'second pass' inside a review thread. Use {{previous_result}} to hand the agent the first review."
                  : "Any selected event starts this rule."
            }
          >
            <EventPicker value={draft.events} onChange={(events) => patch({ events })} />
          </Field>
          <Field label="Repositories" hint={isSlackEvent ? "owner/name of the PR linked in the message, comma separated. Empty matches any." : "owner/name, comma separated. Empty matches every repository."}>
            <Input className={cn("h-8", mono)} value={reposText} onChange={(e) => setReposText(e.target.value)} placeholder="owner/name" />
          </Field>
          {isSlackEvent && (
            <Field label="Slack channel" hint="Channel id (C…), from the channel's details. Empty means any channel the bot is in.">
              <Input className={cn("h-8", mono)} value={draft.channel ?? ""} onChange={(e) => patch({ channel: e.target.value || null })} placeholder="C0123456789" />
            </Field>
          )}
          {isGitHubEvent && (
            <Field label="Requested reviewer" hint="Fire only when this user or team is requested. Empty means anyone.">
              <Input className="h-8" value={draft.reviewer ?? ""} onChange={(e) => patch({ reviewer: e.target.value || null })} placeholder="login or team slug" />
            </Field>
          )}
          <Field label="T3 project" hint={draft.projectId ? undefined : isSlackEvent ? "Matched by comparing the PR linked in the message to each project's git remote." : "Matched by comparing the webhook repository to each project's git remote."}>
            <Select value={draft.projectId ?? AUTO_PROJECT} onValueChange={(v) => patch({ projectId: v === AUTO_PROJECT ? null : v })}>
              <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
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
                    {mode === "worktree" ? "Worktree from PR head (default branch for non-PR events)" : "Local project checkout"}
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

        <Field label="Prompt" hint={`First message of the thread. Click a variable to insert it at the cursor.${isSlackEvent ? " The final reply is posted back to the Slack thread." : ""}`}>
          <Textarea ref={promptRef} className={cn("min-h-52 leading-relaxed", mono)} value={draft.prompt} onChange={(e) => patch({ prompt: e.target.value })} />
          <div className="mt-1 flex flex-wrap gap-x-1 gap-y-0.5">
            {TEMPLATE_VARS.filter((name) => (showsPullRequestVars || !name.startsWith("pr_")) && (isSlackEvent || !name.startsWith("slack_"))).map((name) => (
              <Button key={name} type="button" variant="ghost" size="xs" className={cn("h-5 px-1 text-primary", mono)} onClick={() => insertVar(name)}>
                {`{{${name}}}`}
              </Button>
            ))}
          </div>
        </Field>

        <Field label={sample ? `Preview with delivery from ${timeAgo(sample.createdAt)}` : "Preview"}>
          {preview ? (
            <pre className={cn("max-h-48 overflow-auto rounded-md border bg-input/20 p-3 whitespace-pre-wrap text-muted-foreground", mono)}>{preview}</pre>
          ) : (
            <span className="text-xs text-muted-foreground">Appears after the first delivery matching this event.</span>
          )}
        </Field>
      </div>
    </div>
  );
}

const EVENT_GROUPS = [
  { label: "GitHub", events: SUGGESTED_EVENTS.filter((e) => !e.key.startsWith(SLACK_EVENT_PREFIX)) },
  { label: "Slack", events: SUGGESTED_EVENTS.filter((e) => e.key.startsWith(SLACK_EVENT_PREFIX)) },
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
        <Button variant="outline" size="sm" className="h-8 w-full justify-start truncate font-normal">
          <span className="truncate">{value.map(labelOf).join(", ") || "Pick events"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-2">
        {groups.map((group) => (
          <div key={group.label} className="mb-2 last:mb-0">
            <div className="px-2 py-1 text-[11px] tracking-wide text-muted-foreground uppercase">{group.label}</div>
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

/** Default model of the first ready provider instance, for a fresh override. */
function firstAvailableModel(providers: T3Provider[] | null): RuleInput["model"] {
  const provider = providers?.find((p) => p.enabled && p.models.length > 0);
  if (!provider) return null;
  const model = provider.models.find((m) => m.isDefault) ?? provider.models.find((m) => !m.isLegacy) ?? provider.models[0]!;
  return { instanceId: provider.instanceId, model: model.slug };
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
