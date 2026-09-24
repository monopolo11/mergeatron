import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { createContext, use, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Analytics } from "@/components/Analytics";
import { Header } from "@/components/Header";
import { Reviews, STATUS_FILTERS } from "@/components/Reviews";
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
  skipSelfReview: true,
  projectId: null,
  workspace: "worktree",
  model: null,
  prompt: DEFAULT_PROMPT,
};

/** What the rules route needs from the shell, which owns rules and runs for the sidebar and run log. */
type RulesPane = {
  rules: Rule[] | null;
  selected: Rule | null;
  projects: T3Project[];
  providers: T3Provider[] | null;
  runs: Run[];
  githubLogin: string | null;
  webhookUrl: string;
  createRule: () => Promise<void>;
  saveRule: (id: string, input: RuleInput) => Promise<void>;
  deleteRule: (rule: Rule) => Promise<void>;
};
const RulesPaneContext = createContext<RulesPane | null>(null);

/** App shell: header, rules sidebar and run log around the active route. */
function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [projects, setProjects] = useState<T3Project[]>([]);
  const [providers, setProviders] = useState<T3Provider[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const navigate = useNavigate();
  // The per-PR table needs the width, so /reviews drops the rules sidebar and run log.
  const fullWidth = Boolean(useMatchRoute()({ to: "/reviews" }));
  // Picking or creating a rule opens its editor, whichever view is showing.
  const selectRule = (id: string) => {
    setSelectedId(id);
    void navigate({ to: "/" });
  };

  const refreshRuns = () => api<Run[]>("/api/runs").then(setRuns).catch(() => {});

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
    selectRule(created.id);
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
      <Header status={status} projects={projects} providers={providers} settings={settings} onSettingsSaved={setSettings} onThreadStarted={refreshRuns} />

      <div className={cn("grid overflow-hidden", fullWidth ? "grid-cols-1" : "grid-cols-[280px_1fr] xl:grid-cols-[300px_1fr_380px]")}>
        <aside className={cn("overflow-auto border-r", fullWidth && "hidden")}>
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
                onClick={() => selectRule(rule.id)}
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
          <RulesPaneContext value={{ rules, selected, projects, providers, runs, githubLogin: settings?.githubLogin ?? null, webhookUrl, createRule, saveRule, deleteRule }}>
            <Outlet />
          </RulesPaneContext>
        </main>

        <section className={cn("hidden overflow-auto border-l", !fullWidth && "xl:block")}>
          <RunLog runs={runs} rules={rules ?? []} webhookUrl={webhookUrl} />
        </section>
      </div>
    </div>
  );
}

/** Index route: the selected rule's editor, or onboarding when there are no rules. */
function RulesMain() {
  const { rules, selected, projects, providers, runs, githubLogin, webhookUrl, createRule, saveRule, deleteRule } = use(RulesPaneContext)!;
  if (selected) {
    return <RuleEditor key={selected.id} rule={selected} projects={projects} providers={providers} runs={runs} githubLogin={githubLogin} onSave={saveRule} onDelete={deleteRule} />;
  }
  if (rules && rules.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="max-w-sm text-muted-foreground">
          Create a rule, point a GitHub webhook at <code className="font-mono text-xs">{webhookUrl}</code> or connect a Slack app, and matching events open threads in T3 Code.
        </p>
        <Button size="sm" onClick={() => void createRule()}>Create first rule</Button>
      </div>
    );
  }
  return <p className="p-4 text-muted-foreground">Select a rule.</p>;
}

type StatusFilter = (typeof STATUS_FILTERS)[number];

const rootRoute = createRootRoute({ component: App });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: RulesMain }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/reviews",
    validateSearch: (search: Record<string, unknown>): { status?: StatusFilter } => ({
      status: STATUS_FILTERS.find((status) => status === search.status),
    }),
    component: Reviews,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/analytics", component: Analytics }),
]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
