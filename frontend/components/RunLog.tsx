import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { timeAgo } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Rule, Run } from "../../src/rules.ts";

const ALL = "__all__";

/** Live list of deliveries that matched a rule, newest first. Settled runs show the thread's final reply. */
export function RunLog({ runs, rules, webhookUrl }: { runs: Run[]; rules: Rule[]; webhookUrl: string }) {
  const [filter, setFilter] = useState(ALL);
  const visible = filter === ALL ? runs : runs.filter((run) => run.ruleId === filter);
  const ruleNames = new Map(rules.map((rule) => [rule.id, rule.name]));

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 flex h-9 items-center justify-between border-b bg-background px-3 text-[11px] tracking-wide text-muted-foreground uppercase">
        <span>Runs</span>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger size="sm" className="h-6 border-0 bg-transparent px-1 text-[11px] normal-case tracking-normal shadow-none dark:bg-transparent"><SelectValue /></SelectTrigger>
          <SelectContent align="end">
            <SelectItem value={ALL}>All rules</SelectItem>
            {rules.map((rule) => <SelectItem key={rule.id} value={rule.id}>{rule.name}</SelectItem>)}
            {runs.some((run) => run.ruleId === "manual") && <SelectItem value="manual">Connection tests</SelectItem>}
          </SelectContent>
        </Select>
      </div>

      {visible.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">
          Nothing yet. Point a GitHub webhook at <code className="font-mono">{webhookUrl}</code> or post a PR link in a connected Slack channel and matching deliveries show up here.
        </p>
      ) : (
        <ul className="text-xs">
          {visible.map((run) => {
            const pr = run.context?.pr_number ?? run.context?.issue_number;
            return (
              <li key={run.id} className="grid gap-0.5 border-b px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium text-foreground">{ruleNames.get(run.ruleId) ?? run.ruleName}</span>
                  <span className={cn("ml-auto", run.status === "started" && "text-primary", run.status === "done" && "text-ok", run.status === "skipped" && "text-warn", run.status === "failed" && "text-destructive")}>
                    {run.status === "started" ? "running" : run.status}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  <span title={new Date(run.createdAt).toLocaleString()}>{timeAgo(run.createdAt)}</span>
                  <span className="font-mono"> · {run.repo || run.context?.slack_channel || run.event}{pr ? ` #${pr}` : ""}</span>
                </div>
                <div className={cn("break-words text-muted-foreground", run.status === "failed" && "text-destructive/90")}>
                  {run.detail}
                  {run.threadUrl && (
                    <>
                      {" · "}
                      <a href={run.threadUrl} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">open thread</a>
                    </>
                  )}
                </div>
                {run.result && <p className="line-clamp-3 break-words text-muted-foreground/80" title={run.result}>{run.result}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
