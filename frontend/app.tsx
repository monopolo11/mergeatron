import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Analytics } from "@/components/Analytics";
import { Header, type View } from "@/components/Header";
import { RuleEditor } from "@/components/RuleEditor";
import { RunLog } from "@/components/RunLog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api, type Status } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Rule, RuleInput, Run, Settings } from "../src/rules.ts";
import type { T3Project, T3Provider } from "../src/t3.ts";

const DEFAULT_PROMPT = `Review pull request {{pr_url}} ("{{pr_title}}" by {{pr_author}}, {{pr_head}} -> {{pr_base}}).

You are checked out on the PR head. Read the diff against {{pr_base}}, then look for correctness bugs, missing tests and unclear code. Keep findings concrete, one line each with file:line. Post nothing to GitHub; report here.`;

const NEW_RULE: RuleInput = {
  name: "New rule",
  enabled: true,
  events: ["pull_request.review_requested"],
  repos: [],
  reviewer: null,
  channel: null,
  projectId: null,
  workspace: "worktree",
  model: null,
  prompt: DEFAULT_PROMPT,
};

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [projects, setProjects] = useState<T3Project[]>([]);
  const [providers, setProviders] = useState<T3Provider[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>("rules");
  // Bumped on every run refresh so the analytics view refetches on the same cadence.
  const [runsVersion, setRunsVersion] = useState(0);

  const refreshRuns = () =>
    api<Run[]>("/api/runs")
      .then((all) => { setRuns(all); setRunsVersion((v) => v + 1); })
      .catch(() => {});

  useEffect(() => {
    api<Status>("/api/status").then(setStatus).catch(() => {});
    api<T3Project[]>("/api/t3/projects").then(setProjects).catch(() => setProjects([]));
    api<T3Provider[]>("/api/t3/providers").then(setProviders).catch(() => setProviders(null));
    api<Settings>("/api/settings").then(setSettings).catch(() => {});
    api<Rule[]>("/api/rules").then((all) => { setRules(all); setSelectedId(all[0]?.id ?? null); }).catch(() => setRules([]));
    void refreshRuns();
    const timer = setInterval(refreshRuns, 5000);
    return () => clearInterval(timer);
  }, []);

  const replaceRule = (updated: Rule) => setRules((all) => (all ?? []).map((rule) => (rule.id === updated.id ? updated : rule)));

  const createRule = async () => {
    const created = await api<Rule>("/api/rules", { method: "POST", body: JSON.stringify(NEW_RULE) });
    setRules((all) => [...(all ?? []), created]);
    setSelectedId(created.id);
  };

  const saveRule = async (id: string, input: RuleInput) => {
    replaceRule(await api<Rule>(`/api/rules/${id}`, { method: "PUT", body: JSON.stringify(input) }));
  };

  const toggleRule = (rule: Rule) => {
    const { id, createdAt, updatedAt, ...input } = rule;
    return saveRule(id, { ...input, enabled: !rule.enabled });
  };

  const deleteRule = async (rule: Rule) => {
    await api(`/api/rules/${rule.id}`, { method: "DELETE" });
    setRules((all) => {
      const next = (all ?? []).filter((r) => r.id !== rule.id);
      setSelectedId((current) => (current === rule.id ? next[0]?.id ?? null : current));
      return next;
    });
  };

  const selected = rules?.find((rule) => rule.id === selectedId) ?? null;
  const webhookUrl = `${location.origin}/webhooks/github`;
  const startedCount = (ruleId: string) => runs.filter((run) => run.ruleId === ruleId && (run.status === "started" || run.status === "done")).length;

  return (
    <div className="grid h-screen grid-rows-[44px_1fr] overflow-hidden">
      <Header status={status} projects={projects} providers={providers} settings={settings} view={view} onViewChange={setView} onSettingsSaved={setSettings} onThreadStarted={refreshRuns} />

      <div className="grid grid-cols-[280px_1fr] overflow-hidden xl:grid-cols-[300px_1fr_380px]">
        <aside className="overflow-auto border-r">
          <div className="sticky top-0 z-10 flex h-9 items-center justify-between border-b bg-background px-3 text-[11px] tracking-wide text-muted-foreground uppercase">
            <span>Rules{rules && rules.length > 0 ? ` · ${rules.length}` : ""}</span>
            <Button size="xs" variant="ghost" className="text-primary normal-case tracking-normal" onClick={() => void createRule()}>+ New</Button>
          </div>
          {rules && rules.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">No rules yet. A rule maps GitHub or Slack events to a T3 thread with your prompt.</p>
          )}
          <ul>
            {rules?.map((rule) => (
              <li
                key={rule.id}
                className={cn(
                  "grid cursor-pointer grid-cols-[auto_1fr_auto] items-start gap-x-2 border-b px-3 py-2 text-[13px] hover:bg-muted/40",
                  rule.id === selectedId && "bg-muted/60",
                  !rule.enabled && "text-muted-foreground",
                )}
                onClick={() => setSelectedId(rule.id)}
              >
                <span className="pt-0.5" onClick={(e) => e.stopPropagation()}>
                  <Switch className="scale-75" checked={rule.enabled} onCheckedChange={() => void toggleRule(rule)} />
                </span>
                <span className="truncate">{rule.name || "Untitled rule"}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{startedCount(rule.id) || ""}</span>
                <span className="col-start-2 col-end-4 truncate font-mono text-[11px] text-muted-foreground">
                  {rule.events.join(", ") || "no events"} · {rule.repos.length ? rule.repos.join(", ") : "any repo"}
                </span>
              </li>
            ))}
          </ul>
        </aside>

        <main className="overflow-auto">
          {view === "analytics" ? (
            <Analytics refreshKey={runsVersion} />
          ) : selected ? (
            <RuleEditor key={selected.id} rule={selected} projects={projects} providers={providers} runs={runs} onSave={saveRule} onDelete={deleteRule} />
          ) : rules && rules.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
              <p className="max-w-sm text-muted-foreground">
                Create a rule, point a GitHub webhook at <code className="font-mono text-xs">{webhookUrl}</code> or connect a Slack app, and matching events open threads in T3 Code.
              </p>
              <Button size="sm" onClick={() => void createRule()}>Create first rule</Button>
            </div>
          ) : (
            <p className="p-4 text-muted-foreground">Select a rule.</p>
          )}
        </main>

        <section className="hidden overflow-auto border-l xl:block">
          <RunLog runs={runs} rules={rules ?? []} webhookUrl={webhookUrl} />
        </section>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
