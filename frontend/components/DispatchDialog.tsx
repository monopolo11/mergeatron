import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field, RunStatus } from "@/components/Field";
import { ModelPicker } from "@/components/ModelPicker";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { itemContext, type InboxItem } from "../../src/inbox.ts";
import type { DispatchInput, ModelSelection, Prompt, Run } from "../../src/rules.ts";
import { DEFAULT_MAX_CONCURRENT, WORKSPACE_MODES, type WorkspaceMode } from "../../src/shared.ts";
import type { T3Project, T3Provider } from "../../src/t3.ts";
import { renderTemplate } from "../../src/template.ts";

/** Radix Select cannot hold an empty string, so "auto" gets a sentinel. */
const AUTO_PROJECT = "__auto__";
const mono = "font-mono text-xs";

/**
 * Composes a prompt from stacked presets and starts one thread per item.
 * The text sent is a template: the server renders it per item, so one
 * dispatch can cover several PRs. Editing the text keeps your edits until the
 * stack changes again.
 */
export function DispatchDialog({ items, onClose, onDispatched }: { items: InboxItem[]; onClose: () => void; onDispatched: () => void }) {
  const prompts = useQuery({ queryKey: ["prompts"], queryFn: () => api<Prompt[]>("/api/prompts") });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api<T3Project[]>("/api/t3/projects") });
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => api<T3Provider[]>("/api/t3/providers") });

  const [stack, setStack] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceMode>("worktree");
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [maxConcurrent, setMaxConcurrent] = useState(DEFAULT_MAX_CONCURRENT);
  const [result, setResult] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const stacked = stack.flatMap((id) => prompts.data?.find((prompt) => prompt.id === id) ?? []);
  useEffect(() => {
    if (!dirty) setText(stacked.map((prompt) => prompt.body).join("\n\n"));
  }, [stack, prompts.data]);

  const toggle = (id: string) => {
    setStack((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
    setDirty(false);
  };

  const first = items[0];
  const preview = first ? renderTemplate(text, itemContext(first)) : "";
  const needsProject = items.some((item) => !item.repo) && !projectId;
  const name = stacked.map((prompt) => prompt.name).join(" + ") || "dispatch";

  const start = () => {
    setBusy(true);
    setError(null);
    const body: DispatchInput = { keys: items.map((item) => item.key), name, prompt: text, projectId, workspace, model, maxConcurrent };
    api<Run[]>("/api/inbox/dispatch", { method: "POST", body: JSON.stringify(body) })
      .then((runs) => { setResult(runs); onDispatched(); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{items.length === 1 && first ? `Dispatch ${first.repo ?? ""}${first.repo ? " " : ""}${first.identifier}` : `Dispatch ${items.length} items`}</DialogTitle>
          <DialogDescription className={cn("truncate", mono)}>{items.map((item) => (item.repo ? `${item.repo} ${item.identifier}` : item.identifier)).join(" · ")}</DialogDescription>
        </DialogHeader>

        {result ? (
          <DispatchResult runs={result} onClose={onClose} />
        ) : (
          <>
            <Field label="Presets" hint="Click to stack in order. The stacked bodies become the message; edit it freely.">
              <div className="flex flex-wrap items-center gap-1">
                {prompts.data?.map((prompt) => {
                  const index = stack.indexOf(prompt.id);
                  return (
                    <Button key={prompt.id} type="button" size="xs" variant={index >= 0 ? "default" : "outline"} onClick={() => toggle(prompt.id)}>
                      {index >= 0 && <span className="font-mono opacity-70">{index + 1}</span>}
                      {prompt.name}
                    </Button>
                  );
                })}
                <Button asChild type="button" size="xs" variant="ghost" className="text-primary">
                  <Link to="/settings" hash="presets">{prompts.data?.length ? "Manage presets" : "Add presets in Settings"}</Link>
                </Button>
              </div>
            </Field>

            <Field label="Message" hint="Template: variables render per item on the server.">
              <Textarea className={cn("min-h-36 leading-relaxed", mono)} value={text} onChange={(e) => { setText(e.target.value); setDirty(true); }} />
              {first && text && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Preview for {first.identifier}</summary>
                  <pre className={cn("mt-1 max-h-40 overflow-auto rounded-md border bg-input/20 p-2 whitespace-pre-wrap text-muted-foreground", mono)}>{preview}</pre>
                </details>
              )}
            </Field>

            <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
              <Field label="T3 project" hint={needsProject ? "Linear and Sentry issues have no repository: pick a project." : undefined}>
                <Select value={projectId ?? AUTO_PROJECT} onValueChange={(v) => setProjectId(v === AUTO_PROJECT ? null : v)}>
                  <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO_PROJECT}>Auto by git remote</SelectItem>
                    {projects.data?.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.title}
                        {p.repositoryIdentity?.owner && <span className="ml-1 text-muted-foreground">{p.repositoryIdentity.owner}/{p.repositoryIdentity.name}</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Workspace">
                <Select value={workspace} onValueChange={(v) => setWorkspace(v as WorkspaceMode)}>
                  <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WORKSPACE_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>{mode === "worktree" ? "Worktree (PR head, or default branch)" : "Local project checkout"}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Model" className="md:col-span-2">
                <div className="flex flex-wrap gap-2">
                  <Select value={model ? "override" : "default"} onValueChange={(v) => setModel(v === "override" ? firstAvailableModel(providers.data ?? null) : null)}>
                    <SelectTrigger size="sm" className="w-56"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Project default, else global</SelectItem>
                      <SelectItem value="override">Override</SelectItem>
                    </SelectContent>
                  </Select>
                  {model && <ModelPicker value={model} providers={providers.data ?? null} onChange={setModel} />}
                </div>
              </Field>
              <Field label="At a time" hint="Threads running at once across inbox dispatches; the rest queue. 0 starts all.">
                <Input type="number" min={0} className={cn("w-20", mono)} value={maxConcurrent} onChange={(e) => setMaxConcurrent(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
              </Field>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-xs text-muted-foreground">One thread per item. A PR with a thread already running is skipped.</span>
              <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button size="sm" onClick={start} disabled={busy || !text.trim() || needsProject}>
                {busy ? "Starting…" : items.length === 1 ? "Start thread" : `Start ${items.length} threads`}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** What the dispatch recorded for each item, before the threads have even opened. */
function DispatchResult({ runs, onClose }: { runs: Run[]; onClose: () => void }) {
  const counts = Map.groupBy(runs, (run) => run.status);
  const summary = [...counts.entries()].map(([status, group]) => `${group.length} ${status === "started" ? "starting" : status}`).join(" · ");
  return (
    <div className="grid gap-2 text-xs">
      <p>{summary}. Progress shows in the inbox and the run log.</p>
      <ul className="grid gap-1">
        {runs.map((run) => (
          <li key={run.id} className="grid grid-cols-[auto_1fr] gap-x-2">
            <RunStatus run={run} />
            <span className="truncate text-muted-foreground" title={run.detail}>{run.context?.pr_url ?? run.context?.issue_url} {run.status !== "started" && `· ${run.detail}`}</span>
          </li>
        ))}
      </ul>
      <div className="flex justify-end"><Button size="sm" onClick={onClose}>Close</Button></div>
    </div>
  );
}

/** Default model of the first ready provider instance, for a fresh override. */
export function firstAvailableModel(providers: T3Provider[] | null): ModelSelection | null {
  const provider = providers?.find((p) => p.enabled && p.models.length > 0);
  if (!provider) return null;
  const model = provider.models.find((m) => m.isDefault) ?? provider.models.find((m) => !m.isLegacy) ?? provider.models[0]!;
  return { instanceId: provider.instanceId, model: model.slug };
}
