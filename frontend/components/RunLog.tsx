import { useState } from "react";
import { Empty, ExternalLink, RunStatus } from "@/components/Field";
import { Toolbar } from "@/components/Toolbar";
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
      <Toolbar title="Runs">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger size="sm" className="ml-auto h-6 border-0 bg-transparent px-1 text-xs shadow-none dark:bg-transparent"><SelectValue /></SelectTrigger>
          <SelectContent align="end">
            <SelectItem value={ALL}>All rules</SelectItem>
            {rules.map((rule) => <SelectItem key={rule.id} value={rule.id}>{rule.name}</SelectItem>)}
            {runs.some((run) => run.ruleId === "dispatch") && <SelectItem value="dispatch">Inbox dispatches</SelectItem>}
            {runs.some((run) => run.ruleId === "manual") && <SelectItem value="manual">Connection tests</SelectItem>}
          </SelectContent>
        </Select>
      </Toolbar>

      {visible.length === 0 ? (
        <Empty className="p-3">
          Nothing yet. Point a GitHub webhook at <code className="font-mono">{webhookUrl}</code> or post a PR link in a connected Slack channel and matching deliveries show up here.
        </Empty>
      ) : (
        <ul className="text-xs">
          {visible.map((run) => {
            const pr = run.context?.pr_number ?? run.context?.issue_number;
            return (
              <li key={run.id} className="grid grid-cols-[minmax(0,1fr)] gap-0.5 border-b px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium text-foreground">{ruleNames.get(run.ruleId) ?? run.ruleName}</span>
                  <span className="ml-auto"><RunStatus run={run} /></span>
                </div>
                <div className="text-muted-foreground">
                  <span title={new Date(run.createdAt).toLocaleString()}>{timeAgo(run.createdAt)}</span>
                  <span className="font-mono"> · {run.repo || run.context?.slack_channel || run.event}{pr ? ` #${pr}` : ""}</span>
                </div>
                <div className={cn("wrap-anywhere text-muted-foreground", run.status === "failed" && "text-destructive/90")}>
                  {run.detail}
                  {run.threadUrl && (
                    <>
                      {" · "}
                      <ExternalLink href={run.threadUrl}>open thread</ExternalLink>
                    </>
                  )}
                </div>
                {run.result && <p className="line-clamp-3 wrap-anywhere text-muted-foreground/80" title={run.result}>{run.result}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
