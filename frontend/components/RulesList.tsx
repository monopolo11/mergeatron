import { Empty } from "@/components/Field";
import { Toolbar } from "@/components/Toolbar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { Rule, Run } from "../../src/rules.ts";

/** The rules as a list: switch, name, how many runs it started, events and repos. */
export function RulesList({
  rules,
  selectedId,
  runs,
  onSelect,
  onToggle,
  onCreate,
}: {
  rules: Rule[] | null;
  selectedId: string | null;
  runs: Run[];
  onSelect: (id: string) => void;
  onToggle: (rule: Rule) => void;
  onCreate: () => void;
}) {
  const startedCount = (ruleId: string) => runs.filter((run) => run.ruleId === ruleId && run.status !== "skipped" && run.status !== "failed").length;
  return (
    <aside className="overflow-auto border-r">
      <Toolbar title={<>Rules{rules && rules.length > 0 && <span className="text-muted-foreground"> · {rules.length}</span>}</>}>
        <Button size="xs" variant="ghost" className="ml-auto text-primary" onClick={onCreate}>+ New</Button>
      </Toolbar>
      {rules && rules.length === 0 && <Empty>No rules yet. A rule maps GitHub, Slack or inbox events to a T3 thread with your prompt.</Empty>}
      <ul>
        {rules?.map((rule) => {
          const scope = `${rule.events.join(", ") || "no events"} · ${rule.repos.length ? rule.repos.join(", ") : "any repo"}`;
          return (
            <li
              key={rule.id}
              className={cn(
                "grid cursor-pointer grid-cols-[auto_1fr_auto] items-start gap-x-2 border-b px-3 py-2 text-[13px] hover:bg-muted/40",
                rule.id === selectedId && "bg-muted/60",
                !rule.enabled && "text-muted-foreground",
              )}
              onClick={() => onSelect(rule.id)}
            >
              <span className="pt-1" onClick={(e) => e.stopPropagation()}>
                <Switch size="sm" checked={rule.enabled} onCheckedChange={() => onToggle(rule)} />
              </span>
              <span className="truncate">{rule.name || "Untitled rule"}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{startedCount(rule.id) || ""}</span>
              <span className="col-start-2 col-end-4 truncate font-mono text-[11px] text-muted-foreground" title={scope}>{scope}</span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
