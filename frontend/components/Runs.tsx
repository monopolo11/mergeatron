import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { use, useState, type ReactNode } from "react";
import { Dot, Empty, ExternalLink, GroupLabel, RunStatus } from "@/components/Field";
import { Count, Figure, Toolbar, ToolbarDivider } from "@/components/Toolbar";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, timeAgo } from "@/lib/api";
import { tokenCount, usd } from "@/lib/format";
import { ShellContext } from "@/lib/shell";
import { runStatus, scoreTone, TONE_BG, TONE_TEXT, type Tone } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { PromptRef, Run, RunRatingInput, RunUsage } from "../../src/rules.ts";
import type { RunDetail, RunSummary } from "../../src/runHistory.ts";
import { HANDOFF_EVENT, RUN_SOURCES, RUN_STATUSES, type RunSource } from "../../src/shared.ts";
import type { Analytics } from "../../src/store.ts";
import { reviewVerdict } from "../../src/verdict.ts";

const ALL = "__all__";
/** Runs fetched per filter; the status and unrated counts are within these. */
const LIMIT = 500;
const DAY = 24 * 60 * 60 * 1000;
const SINCE_KEYS = ["1d", "7d", "30d"] as const;
type Since = (typeof SINCE_KEYS)[number];
const SINCE: Record<Since, { days: number; label: string }> = {
  "1d": { days: 1, label: "Last 24 hours" },
  "7d": { days: 7, label: "Last 7 days" },
  "30d": { days: 30, label: "Last 30 days" },
};
const SOURCE_LABELS: Record<RunSource, string> = { github: "GitHub webhook", slack: "Slack", poll: "Inbox automation", manual: "Manual" };
/** Runs without a stored rule, by the id they are recorded under. */
const PSEUDO_RULES = { dispatch: "Inbox dispatches", handoff: "Handoffs", manual: "Connection tests" };
/** Runs worth rating: their thread replied, or should have. "Next unrated" skips the rest. */
const RATABLE = new Set<Run["status"]>(["done", "failed"]);
const UNSETTLED = new Set<Run["status"]>(["queued", "started"]);
const SCORES = Array.from({ length: 11 }, (_, score) => score);
/** Token kinds in the order the usage bar stacks them, each with its tone. */
const TOKEN_KINDS = [
  { key: "inputTokens", label: "input", tone: "active" },
  { key: "outputTokens", label: "output", tone: "ok" },
  { key: "cacheCreationTokens", label: "cache write", tone: "warn" },
  { key: "cacheReadTokens", label: "cache read", tone: "idle" },
] as const satisfies ReadonlyArray<{ key: keyof RunUsage; label: string; tone: Tone }>;

/**
 * The page's state, all in the URL so a filtered view can be linked. The
 * selects filter on the server; the status and unrated counts toggle within
 * what came back. `run` is the run open beside the table.
 */
export type RunsSearch = {
  ruleId?: string;
  source?: RunSource;
  model?: string;
  /** `owner:id` for every version of a prompt, `owner:id:version` for one. */
  prompt?: string;
  since?: Since;
  status?: Run["status"];
  unrated?: true;
  run?: string;
};

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
const oneOf = <T extends string>(options: readonly T[], value: unknown) => options.find((option) => option === value);

/** Validates the `/runs` search params; unknown values are dropped. */
export function validateRunsSearch(search: Record<string, unknown>): RunsSearch {
  return {
    ruleId: text(search.ruleId),
    source: oneOf(RUN_SOURCES, search.source),
    model: text(search.model),
    prompt: text(search.prompt),
    since: oneOf(SINCE_KEYS, search.since),
    status: oneOf(RUN_STATUSES, search.status),
    unrated: search.unrated === true ? true : undefined,
    run: text(search.run),
  };
}

/** Query string for `/api/runs/history`. `since` becomes a timestamp now, so the window moves with each refetch. */
function historyQuery({ ruleId, source, model, prompt, since }: RunsSearch): string {
  const [promptOwner, promptId, promptVersion] = prompt?.split(":") ?? [];
  const params = {
    ruleId,
    source,
    model,
    promptOwner,
    promptId,
    promptVersion,
    since: since && new Date(Date.now() - SINCE[since].days * DAY).toISOString(),
    limit: String(LIMIT),
  };
  return new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString();
}

/**
 * Every run with the trigger, model and prompt versions it started with, and
 * what its thread cost. Picking a row opens it beside the table to read its
 * reply and rate it. The toolbar's summary (scored runs, average score,
 * average work time, cost of the measured runs) is over the listed runs, so
 * filtering by one prompt version and then another compares them.
 */
export function Runs() {
  const search = useSearch({ from: "/runs" });
  const navigate = useNavigate();
  const { rules } = use(ShellContext)!;
  const { ruleId, source, model, prompt, since, status, unrated, run: openId } = search;

  const list = useQuery({
    queryKey: ["runs", "history", { ruleId, source, model, prompt, since }],
    queryFn: () => api<RunSummary[]>(`/api/runs/history?${historyQuery(search)}`),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
  // Prompt versions and models that have runs, for the filters and prompt names.
  const { data: analytics } = useQuery({ queryKey: ["analytics"], queryFn: () => api<Analytics>("/api/analytics"), refetchInterval: 30_000 });

  const setSearch = (patch: Partial<RunsSearch>, replace = false) => void navigate({ to: "/runs", search: { ...search, ...patch }, replace });
  const open = (id: string) => setSearch({ run: id }, true);

  // Versions per prompt, keyed `owner:id`; a deleted preset or rule has no name left, so its owner stands in.
  const prompts = Map.groupBy(analytics?.byPrompt ?? [], (row) => `${row.owner}:${row.id}`);
  const promptNames = new Map(analytics?.byPrompt.map((row) => [`${row.owner}:${row.id}`, row.name ?? row.owner]));
  const promptLabel = ({ owner, id, version }: PromptRef) => `${promptNames.get(`${owner}:${id}`) ?? owner} v${version}`;
  const models = [...new Set(analytics?.byModel.map((row) => row.modelId))];
  const ruleNames = new Map(rules?.map((rule) => [rule.id, rule.name]));

  const runs = list.data ?? [];
  const visible = runs.filter((run) => (!status || run.status === status) && (!unrated || run.ratedAt === null));
  const count = (predicate: (run: RunSummary) => boolean) => runs.filter(predicate).length;
  const scores = visible.flatMap((run) => (run.rating === null ? [] : [run.rating]));
  const worked = visible.flatMap((run) => (run.elapsedMs === null ? [] : [run.elapsedMs]));
  const costs = visible.flatMap((run) => (run.usage ? [run.usage.costUsd] : []));

  // The next ratable, unrated run below the open one, wrapping to the top.
  const index = visible.findIndex((run) => run.id === openId);
  const next = [...visible.slice(index + 1), ...visible.slice(0, Math.max(index, 0))].find((run) => run.ratedAt === null && RATABLE.has(run.status));

  return (
    <div className={cn("grid h-full overflow-hidden", openId && "grid-cols-[minmax(0,1fr)_420px]")}>
      <div className="min-w-0 overflow-auto">
        <Toolbar title="Runs">
          <Count
            value={runs.length}
            label="runs"
            active={!status && !unrated}
            onClick={() => setSearch({ status: undefined, unrated: undefined })}
            title={runs.length === LIMIT ? `The latest ${LIMIT}. Narrow the filters to reach older runs.` : undefined}
          />
          {RUN_STATUSES.map((value) => {
            const { label, tone } = runStatus({ status: value });
            return <Count key={value} value={count((run) => run.status === value)} label={label} tone={tone} active={status === value} onClick={() => setSearch({ status: status === value ? undefined : value })} />;
          })}
          <ToolbarDivider />
          <Count value={count((run) => run.ratedAt === null)} label="unrated" active={!!unrated} onClick={() => setSearch({ unrated: unrated ? undefined : true })} />
          <ToolbarDivider />
          <FilterSelect value={ruleId} all="All rules" onChange={(value) => setSearch({ ruleId: value })}>
            {rules?.map((rule) => <SelectItem key={rule.id} value={rule.id}>{rule.name}</SelectItem>)}
            {Object.entries(PSEUDO_RULES).map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
          </FilterSelect>
          <FilterSelect value={source} all="All sources" onChange={(value) => setSearch({ source: oneOf(RUN_SOURCES, value) })}>
            {RUN_SOURCES.map((value) => <SelectItem key={value} value={value}>{SOURCE_LABELS[value]}</SelectItem>)}
          </FilterSelect>
          <FilterSelect value={model} all="All models" onChange={(value) => setSearch({ model: value })}>
            {models.map((value) => <SelectItem key={value} value={value} className="font-mono text-xs">{value}</SelectItem>)}
          </FilterSelect>
          <FilterSelect value={prompt} all="All prompts" onChange={(value) => setSearch({ prompt: value })}>
            {[...prompts].flatMap(([key, versions]) => [
              // A prompt with one version (a hand-edited dispatch) needs no "all versions" entry.
              ...(versions.length > 1 ? [<SelectItem key={key} value={key}>{promptNames.get(key)}, all versions</SelectItem>] : []),
              ...versions.map((row) => <SelectItem key={`${key}:${row.version}`} value={`${key}:${row.version}`}>{promptLabel(row)}</SelectItem>),
            ])}
          </FilterSelect>
          <FilterSelect value={since} all="Any time" onChange={(value) => setSearch({ since: oneOf(SINCE_KEYS, value) })}>
            {Object.entries(SINCE).map(([key, { label }]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
          </FilterSelect>
          <span className="ml-auto font-mono whitespace-nowrap text-muted-foreground" title="Over the runs listed">
            <Figure>{scores.length}</Figure> scored · avg <Figure>{average(scores)?.toFixed(1) ?? "-"}</Figure> · worked <Figure>{duration(average(worked))}</Figure> ·{" "}
            <Figure>{costs.length > 0 ? usd(costs.reduce((sum, cost) => sum + cost, 0)) : "-"}</Figure> on {costs.length} measured
          </span>
        </Toolbar>

        {!list.data ? (
          <Empty>{list.error ? list.error.message : "Loading…"}</Empty>
        ) : visible.length === 0 ? (
          <Empty>{runs.length === 0 && !ruleId && !source && !model && !prompt && !since ? "No runs yet. Runs show up here once a rule, dispatch or connection test starts one." : "No runs match these filters."}</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead className="w-full">Target</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Prompt</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Worked</TableHead>
                <TableHead className="text-right">Score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((run) => (
                <TableRow key={run.id} data-state={run.id === openId ? "selected" : undefined} className="cursor-pointer" onClick={() => open(run.id)}>
                  <TableCell className="text-muted-foreground" title={new Date(run.createdAt).toLocaleString()}>{timeAgo(run.createdAt)}</TableCell>
                  <TableCell className="max-w-0 truncate" title={run.title ?? undefined}>
                    <Link to="/runs" search={{ ...search, run: run.id }} replace className="link">
                      <span className="font-mono text-muted-foreground">{target(run)}</span> {run.title}
                    </Link>
                  </TableCell>
                  <TableCell>{ruleNames.get(run.ruleId) ?? run.ruleName}</TableCell>
                  <TableCell className="font-mono">{run.modelId}</TableCell>
                  <TableCell className="font-mono text-muted-foreground" title={run.promptRefs.map(promptLabel).join(" + ")}>
                    {run.promptRefs[0] && promptLabel(run.promptRefs[0])}
                    {run.promptRefs.length > 1 && ` +${run.promptRefs.length - 1}`}
                  </TableCell>
                  <TableCell><RunStatus run={run} /></TableCell>
                  <TableCell className={cn("text-right font-mono", !run.usage && "text-muted-foreground")} title={run.usage ? usd(run.usage.costUsd, true) : undefined}>
                    {run.usage ? usd(run.usage.costUsd) : "-"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">{run.usage ? tokenCount(run.usage.totalTokens) : "-"}</TableCell>
                  <TableCell className="text-right font-mono">{duration(run.elapsedMs)}</TableCell>
                  <TableCell className="text-right font-mono"><Score run={run} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {openId && (
        <aside className="overflow-auto border-l">
          <RunPanel key={openId} id={openId} promptLabel={promptLabel} onClose={() => setSearch({ run: undefined }, true)} onNext={next ? () => open(next.id) : null} />
        </aside>
      )}
    </div>
  );
}

/** A toolbar select over one search param; the `all` entry clears it. */
function FilterSelect({ value, all, onChange, children }: { value: string | undefined; all: string; onChange: (value: string | undefined) => void; children: ReactNode }) {
  return (
    <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? undefined : next)}>
      <SelectTrigger size="sm" className={cn("h-6 px-2 text-xs", value === undefined && "text-muted-foreground")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{all}</SelectItem>
        {children}
      </SelectContent>
    </Select>
  );
}

/** One run beside the table: what started it, what it spent, its reply (folded), and the rating form. */
function RunPanel({ id, promptLabel, onClose, onNext }: { id: string; promptLabel: (ref: PromptRef) => string; onClose: () => void; onNext: (() => void) | null }) {
  const { data: run, error } = useQuery({
    queryKey: ["run", id],
    queryFn: () => api<RunDetail>(`/api/runs/${id}`),
    // A settled run only changes when rated, and the form refetches it then.
    refetchInterval: (query) => (query.state.data && !UNSETTLED.has(query.state.data.status) ? false : 5000),
  });
  const [showPrompt, setShowPrompt] = useState(false);
  const [showReply, setShowReply] = useState(false);

  if (!run) {
    return (
      <>
        <Toolbar title="Run">
          <CloseButton onClose={onClose} />
        </Toolbar>
        <Empty>{error ? error.message : "Loading…"}</Empty>
      </>
    );
  }

  const title = run.title ?? target(run);
  return (
    <div className="flex min-h-full flex-col">
      <Toolbar title={<span title={title}>{title}</span>} className="flex-nowrap">
        <span className="ml-auto flex items-center gap-3 font-mono whitespace-nowrap text-muted-foreground">
          {run.url && <ExternalLink href={run.url}>{run.ref ?? "link"}</ExternalLink>}
          {run.threadUrl && <ExternalLink href={run.threadUrl}>thread</ExternalLink>}
        </span>
        {!UNSETTLED.has(run.status) && <DeleteRun id={run.id} onDeleted={onClose} />}
        <CloseButton onClose={onClose} />
      </Toolbar>

      <div className="grid gap-4 p-3 text-xs">
        <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 [&_dt]:text-muted-foreground">
          <dt>Run</dt>
          <dd className="font-mono wrap-anywhere select-all">{run.id}</dd>
          {run.followUpOf && (
            <>
              <dt>Follows up</dt>
              <dd className="min-w-0"><FollowedRun id={run.followUpOf} /></dd>
            </>
          )}
          <dt>Status</dt>
          <dd className="wrap-anywhere"><RunStatus run={run}>{run.detail || null}</RunStatus></dd>
          <dt>Rule</dt>
          <dd>
            {run.ruleName} <span className="font-mono text-muted-foreground">· {run.event} · {run.source}</span>
          </dd>
          <dt>Model</dt>
          <dd className="font-mono">{run.modelId ? `${run.modelInstanceId} / ${run.modelId}` : <span className="text-muted-foreground">no thread</span>}</dd>
          <dt>Prompt</dt>
          <dd className="font-mono">
            {run.promptRefs.map(promptLabel).join(" + ") || <span className="text-muted-foreground">none</span>}
            {run.prompt && (
              <button type="button" className="ml-2 text-muted-foreground hover:text-foreground" onClick={() => setShowPrompt((shown) => !shown)}>
                {showPrompt ? "hide" : "show"}
              </button>
            )}
          </dd>
          <dt>When</dt>
          <dd className="font-mono">{new Date(run.createdAt).toLocaleString()}</dd>
          <dt>Timing</dt>
          <dd className="font-mono">{timing(run)}</dd>
        </dl>

        {showPrompt && run.prompt && <pre className="max-h-64 overflow-auto rounded-md border bg-input/20 p-2 font-mono whitespace-pre-wrap text-muted-foreground">{run.prompt}</pre>}

        <UsageSection run={run} />

        <section className="grid gap-1">
          {run.result ? (
            <>
              <button type="button" aria-expanded={showReply} className="group flex items-baseline justify-between gap-2 text-left" onClick={() => setShowReply((shown) => !shown)}>
                <GroupLabel>Reply</GroupLabel>
                <span className="text-muted-foreground group-hover:text-foreground">
                  <ReplyVerdict run={run} />
                  {run.result.split("\n").length} lines · {showReply ? "collapse" : "expand"}
                </span>
              </button>
              {showReply && <pre className="font-mono leading-relaxed whitespace-pre-wrap wrap-anywhere">{run.result}</pre>}
            </>
          ) : (
            <>
              <GroupLabel>Reply</GroupLabel>
              <p className="text-muted-foreground">{UNSETTLED.has(run.status) ? "Not replied yet." : "No reply."}</p>
            </>
          )}
        </section>

        <RatingForm key={run.id} run={run} onNext={onNext} />
      </div>
    </div>
  );
}

/** The earlier run a run follows up, as a link that opens it beside the table. Falls back to the id while it loads. */
function FollowedRun({ id }: { id: string }) {
  const search = useSearch({ from: "/runs" });
  const { data: run } = useQuery({ queryKey: ["run", id], queryFn: () => api<RunDetail>(`/api/runs/${id}`) });
  return (
    <Link to="/runs" search={{ ...search, run: id }} replace className="link block truncate" title={run?.title ?? id}>
      {run ? <><span className="font-mono text-muted-foreground">{target(run)}</span> {run.title}</> : <span className="font-mono">{id}</span>}
    </Link>
  );
}

/**
 * What the run's thread spent: cost and tokens, a bar split by token kind,
 * and the models that answered. A settled run with a thread but no usage yet
 * says so; other runs have nothing to show.
 */
function UsageSection({ run }: { run: RunDetail }) {
  const { usage } = run;
  if (!usage) {
    if (!run.threadId || UNSETTLED.has(run.status)) return null;
    return (
      <section className="grid gap-1">
        <GroupLabel>Usage</GroupLabel>
        <p className="text-muted-foreground">Not measured yet.</p>
      </section>
    );
  }
  const sessions = usage.sessionIds.length;
  return (
    <section className="grid gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <GroupLabel>Usage</GroupLabel>
        <span className="font-mono">{usd(usage.costUsd, true)} · {usage.totalTokens.toLocaleString()} tokens</span>
      </div>
      <div aria-hidden className="flex h-1.5 overflow-hidden rounded-sm bg-muted">
        {TOKEN_KINDS.map((kind) => <i key={kind.key} className={TONE_BG[kind.tone]} style={{ width: `${(usage[kind.key] / Math.max(usage.totalTokens, 1)) * 100}%` }} />)}
      </div>
      <dl className="grid grid-cols-4 gap-2 font-mono">
        {TOKEN_KINDS.map((kind) => (
          <div key={kind.key}>
            <dt className="text-muted-foreground"><Dot tone={kind.tone} />{kind.label}</dt>
            <dd>{usage[kind.key].toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      <p className="font-mono text-muted-foreground">{usage.models.join(", ")} · {sessions} {sessions === 1 ? "session" : "sessions"}</p>
    </section>
  );
}

/** A finished PR review's verdict, ahead of the reply's length; nothing for other runs or a reply without one. */
function ReplyVerdict({ run }: { run: RunDetail }) {
  if (run.status !== "done" || run.event === HANDOFF_EVENT || !run.context?.pr_number) return null;
  const verdict = reviewVerdict(run.result);
  if (verdict === "commented") return null;
  const { label, tone } = runStatus({ status: run.status, verdict });
  return <><span className={TONE_TEXT[tone]}>{label}</span> · </>;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button size="icon-xs" variant="ghost" className="text-muted-foreground" onClick={onClose} aria-label="Close run">
      <XIcon />
    </Button>
  );
}

/**
 * Deletes a settled run after a confirmation; the server refuses queued and
 * working runs. The dialog stays open while deleting and shows a failure.
 */
function DeleteRun({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api<void>(`/api/runs/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["run", id] });
      void queryClient.invalidateQueries({ queryKey: ["runs", "history"] });
      void queryClient.invalidateQueries({ queryKey: ["analytics"] });
      onDeleted();
    },
  });

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="xs" variant="ghost" className="text-destructive">Delete</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this run?</AlertDialogTitle>
          <AlertDialogDescription className={cn(remove.error && "text-destructive")}>
            {remove.error ? remove.error.message : "Its reply, score and feedback go with it. The T3 thread is not affected."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={remove.isPending}
            onClick={(e) => {
              e.preventDefault();
              remove.mutate();
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The rule the run being followed up was started by, as a chip under the id field; says so when the id matches no run. */
function FollowUpRule({ id }: { id: string }) {
  const { data: run, error, isPending } = useQuery({ queryKey: ["run", id], queryFn: () => api<RunDetail>(`/api/runs/${id}`), retry: false });
  if (isPending) return null;
  if (error) return <p className="text-muted-foreground">No run with this id.</p>;
  return (
    <span className="w-fit max-w-full truncate rounded-md border bg-input/30 px-2 py-0.5" title={`Rule of ${target(run)}`}>
      {run.ruleName}
    </span>
  );
}

/**
 * A 0 to 10 score and written feedback, and the id of the earlier run this one
 * follows up (a run that fixes a previous implementation); a score or feedback
 * alone saves, and saving again replaces the rating. ⌘⏎ saves and opens the next unrated run.
 */
function RatingForm({ run, onNext }: { run: RunDetail; onNext: (() => void) | null }) {
  const queryClient = useQueryClient();
  const [rating, setRating] = useState(run.rating);
  const [feedback, setFeedback] = useState(run.feedback ?? "");
  const [followUpOf, setFollowUpOf] = useState(run.followUpOf ?? "");
  const save = useMutation({
    mutationFn: (input: RunRatingInput) => api<RunSummary>(`/api/runs/${run.id}/rating`, { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["runs", "history"] });
      void queryClient.invalidateQueries({ queryKey: ["run", run.id] });
    },
  });

  const written = feedback.trim();
  const followed = followUpOf.trim();
  const changed = rating !== run.rating || written !== (run.feedback ?? "") || followed !== (run.followUpOf ?? "");
  const canSave = changed && (rating !== null || written !== "") && !save.isPending;
  /** Saves when there is something new, then moves on when asked; with nothing to save, just moves on. */
  const submit = (thenNext: boolean) => {
    if (canSave) save.mutate({ rating, feedback: written || null, followUpOf: followed || null }, { onSuccess: () => thenNext && onNext?.() });
    else if (thenNext && !changed) onNext?.();
  };

  return (
    <section className="grid gap-2 border-t pt-3">
      <GroupLabel>Feedback</GroupLabel>
      <div role="group" aria-label="Score" className="flex w-fit overflow-hidden rounded-md border border-input">
        {SCORES.map((score) => (
          <button
            key={score}
            type="button"
            aria-pressed={rating === score}
            onClick={() => setRating(rating === score ? null : score)}
            className={cn(
              "size-6.5 border-r border-input font-mono text-muted-foreground last:border-r-0 hover:bg-muted hover:text-foreground",
              rating === score && "bg-foreground text-background hover:bg-foreground hover:text-background",
            )}
          >
            {score}
          </button>
        ))}
      </div>
      <Textarea
        value={feedback}
        placeholder="What was good or bad about this run"
        className="text-xs"
        onChange={(e) => setFeedback(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit(true);
          }
        }}
      />
      <Input
        value={followUpOf}
        placeholder="Follows up run (id of the run it fixes)"
        className="h-7 font-mono text-xs"
        aria-label="Run this one follows up"
        onChange={(e) => setFollowUpOf(e.target.value)}
      />
      {followed && <FollowUpRule id={followed} />}
      <div className="flex items-center gap-2">
        <Button size="xs" disabled={!canSave} onClick={() => submit(false)}>Save</Button>
        <Button size="xs" variant="ghost" disabled={!onNext || (changed && !canSave)} onClick={() => submit(true)} title="⌘⏎">
          {changed ? "Save and next" : "Next unrated"}
        </Button>
        <span className="ml-auto truncate text-muted-foreground">
          {save.error ? <span className="text-destructive">{save.error.message}</span> : run.ratedAt && `rated ${timeAgo(run.ratedAt)}`}
        </span>
      </div>
    </section>
  );
}

/** The run's score in a tone, `note` for feedback without one, nothing when unrated. */
function Score({ run }: { run: Pick<RunSummary, "rating" | "feedback"> }) {
  if (run.rating !== null) return <span className={TONE_TEXT[scoreTone(run.rating)]}>{run.rating}</span>;
  return run.feedback ? <span className="text-muted-foreground" title={run.feedback}>note</span> : null;
}


/** `owner/repo#12`, `FOU-12`, or the repo or event when the run is not about a PR or issue. */
function target({ repo, ref, event }: Pick<RunSummary, "repo" | "ref" | "event">): string {
  if (ref?.startsWith("#")) return `${repo}${ref}`;
  return ref ?? (repo || event);
}

/** How long it waited for its rule's limit, then how long its thread worked. */
function timing({ createdAt, startedAt, elapsedMs }: RunDetail): string {
  if (!startedAt) return "no thread";
  const waited = `waited ${duration(Date.parse(startedAt) - Date.parse(createdAt))}`;
  return elapsedMs === null ? waited : `${waited} · worked ${duration(elapsedMs)}`;
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** `42s`, `6m 12s`, `1h 05m`; `-` for none. */
function duration(ms: number | null): string {
  if (ms === null) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
