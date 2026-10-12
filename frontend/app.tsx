import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet, retainSearchParams, RouterProvider, useNavigate, useRouterState } from "@tanstack/react-router";
import { use, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Analytics, validateAnalyticsSearch } from "@/components/Analytics";
import { Empty } from "@/components/Field";
import { Inbox, validateInboxSearch } from "@/components/Inbox";
import { Reviews, STATUS_FILTERS } from "@/components/Reviews";
import { RuleEditor } from "@/components/RuleEditor";
import { RulesList } from "@/components/RulesList";
import { RunLog } from "@/components/RunLog";
import { Runs, validateRunsSearch } from "@/components/Runs";
import { SettingsPage } from "@/components/Settings";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, type Status } from "@/lib/api";
import { useRunFacets } from "@/lib/runFacets";
import { SCOPE_KEYS, validateScope } from "@/lib/scope";
import { ShellContext, type RuleDraft } from "@/lib/shell";
import { confirmDiscard } from "@/lib/unsaved";
import { cn } from "@/lib/utils";
import type { Rule, RuleInput, RuleUpdate, Run, Settings } from "../src/rules.ts";
import type { T3Project, T3Provider } from "../src/t3.ts";
import { DEFAULT_MAX_CONCURRENT, EMPTY_FILTERS } from "../src/shared.ts";
import type { UpdateStatus } from "../src/update.ts";

const DEFAULT_PROMPT = `Review pull request {{pr_url}} ("{{pr_title}}" by {{pr_author}}, {{pr_head}} -> {{pr_base}}).

You are checked out on the PR head. Read the diff against {{pr_base}}, then look for correctness bugs, missing tests and unclear code. Keep findings concrete, one line each with file:line. Post nothing to GitHub; report here.`;

/** New rules start off, so a half-filled rule never fires before it is saved and reviewed. */
const NEW_RULE: RuleInput = {
  name: "New rule",
  enabled: false,
  events: ["pull_request.review_requested"],
  repos: [],
  reviewer: null,
  channel: null,
  allowBots: true,
  skipSelfReview: true,
  filters: EMPTY_FILTERS,
  maxConcurrent: DEFAULT_MAX_CONCURRENT,
  projectId: null,
  workspace: "worktree",
  model: null,
  prompt: DEFAULT_PROMPT,
  presetId: null,
};

const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;
/** Remembers whether the run panel is open across reloads. */
const RUNS_PANEL_KEY = "mergeatron.runs-panel";

/** App shell: sidebar, the active route, and the live run log beside it on every page but Runs. */
function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [projects, setProjects] = useState<T3Project[]>([]);
  const [providers, setProviders] = useState<T3Provider[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runsOpen, setRunsOpen] = useState(() => localStorage.getItem(RUNS_PANEL_KEY) !== "closed");
  const navigate = useNavigate();
  // The Runs page lists the same runs, so the live panel and its toggle step aside there.
  const onRunsPage = useRouterState({ select: (state) => state.location.pathname === "/runs" });
  const liveOpen = runsOpen && !onRunsPage;

  const toggleRuns = () => {
    const next = !runsOpen;
    localStorage.setItem(RUNS_PANEL_KEY, next ? "open" : "closed");
    setRunsOpen(next);
  };
  // Picking or creating a rule opens its editor, whichever view is showing; the open editor's unsaved changes are dropped only on confirm.
  const openRule = (id: string) => {
    setSelectedId(id);
    // Navigating runs the open editor's route blocker; switching rules has already asked.
    if (location.pathname !== "/") void navigate({ to: "/" });
  };
  const selectRule = (id: string) => {
    if (id === selectedId || confirmDiscard()) openRule(id);
  };

  const refreshRuns = () => void api<Run[]>("/api/runs").then(setRuns).catch(() => {});
  const recheckUpdate = () =>
    api<UpdateStatus>("/api/update")
      .then((next) => { setUpdate(next); setUpdateError(null); })
      .catch((error: Error) => { setUpdate(null); setUpdateError(error.message); });
  const saveSettings = (next: Settings) => api<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(next) }).then(setSettings);

  useEffect(() => {
    api<Status>("/api/status").then(setStatus).catch(() => {});
    api<T3Project[]>("/api/t3/projects").then(setProjects).catch(() => setProjects([]));
    api<T3Provider[]>("/api/t3/providers").then(setProviders).catch(() => setProviders(null));
    api<Settings>("/api/settings").then(setSettings).catch(() => {});
    api<Rule[]>("/api/rules").then((all) => { setRules(all); setSelectedId(all[0]?.id ?? null); }).catch(() => setRules([]));
    void refreshRuns();
    void recheckUpdate();
    const runsTimer = setInterval(refreshRuns, 5000);
    const updateTimer = setInterval(() => void recheckUpdate(), UPDATE_CHECK_INTERVAL);
    return () => { clearInterval(runsTimer); clearInterval(updateTimer); };
  }, []);

  const replaceRule = (updated: Rule) => setRules((all) => (all ?? []).map((rule) => (rule.id === updated.id ? updated : rule)));

  const createRule = async () => {
    if (!confirmDiscard()) return;
    const created = await api<Rule>("/api/rules", { method: "POST", body: JSON.stringify(NEW_RULE) });
    setRules((all) => [...(all ?? []), created]);
    openRule(created.id);
  };

  const putRule = async (id: string, input: RuleUpdate) => {
    replaceRule(await api<Rule>(`/api/rules/${id}`, { method: "PUT", body: JSON.stringify(input) }));
  };

  // Editor saves carry the rule's current switch, read at save time: the editor's copy of the rule can be older than a toggle in the list.
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const saveRule = async (id: string, draft: RuleDraft) => {
    const current = rulesRef.current?.find((rule) => rule.id === id);
    if (current) await putRule(id, { ...draft, enabled: current.enabled });
  };

  const toggleRule = (rule: Rule) => {
    const { id, createdAt, updatedAt, ...input } = rule;
    return putRule(id, { ...input, enabled: !rule.enabled });
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
  const running = runs.filter((run) => run.status === "started").length;

  return (
    <ShellContext value={{ status, projects, providers, settings, saveSettings, update, updateError, recheckUpdate, rules, selected, selectRule, runs, webhookUrl, createRule, saveRule, toggleRule, deleteRule, refreshRuns }}>
      <TooltipProvider delayDuration={200}>
        <div className={cn("grid h-screen grid-cols-[184px_minmax(0,1fr)] overflow-clip", liveOpen && "xl:grid-cols-[184px_minmax(0,1fr)_340px]")}>
          <Sidebar status={status} update={update} running={running} runsOpen={runsOpen} onToggleRuns={onRunsPage ? undefined : toggleRuns} />
          <main className="min-w-0 overflow-auto">
            <Outlet />
          </main>
          {liveOpen && (
            <aside className="hidden overflow-auto border-l xl:block">
              <RunLog runs={runs} rules={rules ?? []} webhookUrl={webhookUrl} />
            </aside>
          )}
        </div>
      </TooltipProvider>
    </ShellContext>
  );
}

/** Index route: the rules list (with run counts in the range) beside the selected rule's editor, or onboarding when there are no rules. */
function RulesMain() {
  const { rules, selected, selectRule, projects, providers, runs, settings, webhookUrl, createRule, saveRule, toggleRule, deleteRule, refreshRuns } = use(ShellContext)!;
  const { data: facets } = useRunFacets([]);
  return (
    <div className="grid h-full grid-cols-[240px_1fr] overflow-clip">
      <RulesList rules={rules} selectedId={selected?.id ?? null} runCounts={new Map(facets?.rules.map((row) => [row.value, row.count]))} onSelect={selectRule} onToggle={(rule) => void toggleRule(rule)} onCreate={() => void createRule()} />
      <div className="@container min-w-0 overflow-auto">
        {selected ? (
          <RuleEditor key={selected.id} rule={selected} projects={projects} providers={providers} runs={runs} githubLogin={settings?.githubLogin ?? null} onSave={saveRule} onDelete={deleteRule} onRunsChanged={refreshRuns} />
        ) : rules && rules.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="max-w-sm text-muted-foreground">
              Create a rule, point a GitHub webhook at <code className="font-mono text-xs">{webhookUrl}</code> or connect a Slack app, and matching events open threads in T3 Code.
            </p>
            <Button size="sm" onClick={() => void createRule()}>Create first rule</Button>
          </div>
        ) : (
          <Empty>Select a rule.</Empty>
        )}
      </div>
    </div>
  );
}

type StatusFilter = (typeof STATUS_FILTERS)[number];

/** The range and run filters are the root's search params, kept across pages (see lib/scope.ts). */
const rootRoute = createRootRoute({ component: App, validateSearch: validateScope, search: { middlewares: [retainSearchParams([...SCOPE_KEYS])] } });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: RulesMain }),
  createRoute({ getParentRoute: () => rootRoute, path: "/inbox", validateSearch: validateInboxSearch, component: Inbox }),
  createRoute({ getParentRoute: () => rootRoute, path: "/runs", validateSearch: validateRunsSearch, component: Runs }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/reviews",
    validateSearch: (search: Record<string, unknown>): { status?: StatusFilter } => ({
      status: STATUS_FILTERS.find((status) => status === search.status),
    }),
    component: Reviews,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/analytics", validateSearch: validateAnalyticsSearch, component: Analytics }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
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
