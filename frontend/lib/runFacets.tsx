import { useQuery } from "@tanstack/react-query";
import { use } from "react";
import { useScope, type Facet } from "@/components/FilterBar";
import { api } from "@/lib/api";
import { runStatus } from "@/lib/status";
import { resolveWindow, scopeKey, scopeQuery, validateScope, type RunFacet } from "@/lib/scope";
import { ShellContext } from "@/lib/shell";
import type { PromptRef } from "../../src/rules.ts";
import type { RunSource } from "../../src/shared.ts";
import type { RunFacets } from "../../src/store.ts";

export const SOURCE_LABELS: Record<RunSource, string> = { github: "GitHub webhook", slack: "Slack", poll: "Inbox automation", webhook: "Custom webhook", manual: "Manual" };
/** Runs without a stored rule, by the id they are recorded under. */
export const PSEUDO_RULES: Record<string, string> = { dispatch: "Inbox dispatches", handoff: "Handoffs", manual: "Connection tests" };

const LABELS: Record<RunFacet, string> = { runStatus: "Status", rule: "Rule", source: "Source", model: "Model", prompt: "Prompt", author: "Author", repo: "Repo" };

/** `owner:id:version`, the prompt facet's value for one version. */
export const promptKey = ({ owner, id, version }: PromptRef) => `${owner}:${id}:${version}`;

/**
 * The run facets in the window the URL names, with counts, as FilterBar
 * facets that read and write the URL. Also returns the facet data, for
 * naming prompts and rules elsewhere on the page.
 */
export function useRunFacets(keys: readonly RunFacet[]) {
  const { search, setScope } = useScope();
  const { rules } = use(ShellContext)!;
  const { data } = useQuery({
    queryKey: ["facets", scopeKey({ range: search.range, from: search.from, to: search.to })],
    queryFn: () => {
      const { from, to } = resolveWindow(search);
      return api<RunFacets>(`/api/runs/facets?${scopeQuery({}, { from, to, label: "", detail: null })}`);
    },
    refetchInterval: 30_000,
  });
  const ruleNames = new Map(rules?.map((rule) => [rule.id, rule.name]));
  // Per version: each dispatch version is named by its own note.
  const promptNames = new Map(data?.prompts.map((row) => [promptKey(row), row.name ?? row.owner]));
  const promptLabel = (ref: PromptRef) => `${promptNames.get(promptKey(ref)) ?? ref.owner} v${ref.version}`;

  const options: Record<RunFacet, Facet["options"]> = {
    runStatus: (data?.statuses ?? []).map(({ value, count }) => ({ value, count, text: runStatus({ status: value }).label })),
    rule: (data?.rules ?? []).map(({ value, label, count }) => ({ value, count, text: ruleNames.get(value) ?? PSEUDO_RULES[value] ?? label ?? value })),
    source: (data?.sources ?? []).map(({ value, count }) => ({ value, count, text: SOURCE_LABELS[value] })),
    model: (data?.models ?? []).map(({ value, count }) => ({ value, count, text: value })),
    prompt: (data?.prompts ?? []).map((row) => ({
      value: promptKey(row),
      count: row.count,
      text: promptLabel(row),
      label: (
        <>
          {promptLabel(row)}
          {row.live && <span className="text-muted-foreground"> live</span>}
        </>
      ),
    })),
    author: (data?.authors ?? []).map(({ value, count }) => ({ value, count, text: value })),
    repo: (data?.repos ?? []).map(({ value, count }) => ({ value, count, text: value })),
  };

  const facets = keys.map(
    (key): Facet => ({
      key,
      label: LABELS[key],
      options: options[key],
      selected: search[key] ?? [],
      onChange: (values) => setScope(validateScope({ ...search, [key]: values })),
      toggle:
        key === "prompt"
          ? { label: "Live versions only", token: "live versions", on: !!search.live, count: data?.liveRuns, onChange: (on) => setScope({ live: on || undefined }) }
          : undefined,
      negate: key === "runStatus" ? { on: !!search.notRunStatus, onChange: (on) => setScope(validateScope({ ...search, notRunStatus: on || undefined })) } : undefined,
      // One navigation for the values and the live switch together.
      onClear: () => setScope(validateScope({ ...search, [key]: undefined, live: key === "prompt" ? undefined : search.live })),
    }),
  );
  return { facets, data, promptLabel };
}
