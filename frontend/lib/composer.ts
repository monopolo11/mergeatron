import { inboxSource, SLACK_EVENT_PREFIX, type InboxSource, type TemplateVar } from "../../src/shared.ts";
import type { T3Provider, T3Skill } from "../../src/t3.ts";

/**
 * Text logic behind the prompt editor, ported from T3 Code's composer
 * (`composer-logic.ts`, `inlineSkills.ts`, `providerSkillSearch.ts`). A prompt
 * is plain text; a skill in it is the token `$name`, which T3 dispatches in
 * each provider's native form, and a template variable is `{{name}}`.
 */

/** What the caret is typing: `/query` at the start of a line, or a `$query` token. */
export type ComposerTrigger = { kind: "slash" | "skill"; query: string; start: number };

/**
 * The trigger ending at the caret, from the caret's line up to the caret. A
 * skill chip in the line reads as one non-space character, so `/` must start
 * the line and `$` must start a token. `start` is the trigger's offset in the line.
 */
export function detectTrigger(linePrefix: string): ComposerTrigger | null {
  const slash = /^\/(\S*)$/.exec(linePrefix);
  if (slash) return { kind: "slash", query: slash[1] ?? "", start: 0 };
  const start = Math.max(linePrefix.lastIndexOf(" "), linePrefix.lastIndexOf("\t")) + 1;
  const skill = /^\p{Sc}(\S*)$/u.exec(linePrefix.slice(start));
  return skill ? { kind: "skill", query: skill[1] ?? "", start } : null;
}

/** `$name` tokens, skipping amounts like `$5` or `$10k` (T3 Code's `SKILL_TOKEN_REGEX`). */
const SKILL_TOKEN = /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

/** A line split into text and the known skills it names, in order. */
export function splitSkills(line: string, skills: readonly T3Skill[]): Array<string | T3Skill> {
  const parts: Array<string | T3Skill> = [];
  let cursor = 0;
  for (const match of line.matchAll(SKILL_TOKEN)) {
    const skill = skills.find((candidate) => candidate.name === match[2]);
    if (!skill) continue;
    const start = match.index + (match[1]?.length ?? 0);
    if (start > cursor) parts.push(line.slice(cursor, start));
    parts.push(skill);
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) parts.push(line.slice(cursor));
  return parts;
}

/** `{{name}}` with no inner spaces, so a chip writes back exactly the text it replaced. */
const VARIABLE_TOKEN = /\{\{([a-zA-Z0-9_]+)\}\}/g;

/** Text split into plain runs and the `{{name}}` template variables it holds, in order. */
export function splitVariables(text: string): Array<string | { variable: string }> {
  const parts: Array<string | { variable: string }> = [];
  let cursor = 0;
  for (const match of text.matchAll(VARIABLE_TOKEN)) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push({ variable: match[1]! });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** A service whose logo a variable chip can show. */
export type VariableService = InboxSource | "slack";

/** Variables only GitHub fills, besides the `pr_` and `comment_` families. */
const GITHUB_VARIABLES: ReadonlySet<string> = new Set([
  "repo",
  "repo_url",
  "default_branch",
  "action",
  "requested_reviewer",
  "issue_number",
  "label",
  "review_state",
  "review_body",
  "review_author",
  "review_decision",
] satisfies TemplateVar[]);

/** Variables several sources fill: they take the logo of the source the prompt runs for. */
const SHARED_VARIABLES: ReadonlySet<string> = new Set([
  "sender",
  "issue_identifier",
  "issue_title",
  "issue_url",
  "issue_body",
  "issue_author",
  "labels",
  "state",
  "state_type",
  "team",
  "priority",
  "branch",
] satisfies TemplateVar[]);

/**
 * The service a variable comes from, for its chip's logo. A shared variable
 * takes `source`, the one service the prompt runs for; the orchestrator's own
 * variables and unknown names have none.
 */
export function variableService(name: string, source: VariableService | null = null): VariableService | null {
  if (name.startsWith("slack_")) return "slack";
  if (name.startsWith("pr_") || name.startsWith("comment_") || GITHUB_VARIABLES.has(name)) return "github";
  return SHARED_VARIABLES.has(name) ? source : null;
}

/** The one service a set of events comes from (its inbox source, Slack, else a GitHub webhook); null when they mix. */
export function eventsService(events: readonly string[]): VariableService | null {
  const services = new Set(events.map((event) => inboxSource(event) ?? (event.startsWith(SLACK_EVENT_PREFIX) ? "slack" : "github")));
  return services.size === 1 ? [...services][0]! : null;
}

/** Every provider's skills, once per name: the prompt does not pick a provider until it runs. */
export function providerSkills(providers: readonly T3Provider[]): T3Skill[] {
  const seen = new Set<string>();
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) => provider.skills)
    .filter((skill) => {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** `displayName`, else the name title-cased: `code-review` reads "Code Review". */
export function skillLabel(skill: Pick<T3Skill, "name" | "displayName">): string {
  return skill.displayName?.trim() || skill.name.split(/[\s:_-]+/).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

/** The badge naming where a skill comes from. */
export function skillSource(skill: Pick<T3Skill, "path" | "scope">): "App" | "Repo" | "Project" | "Personal" | "System" | "Provider" {
  const path = skill.path.replaceAll("\\", "/");
  if (path.includes("/.codex/plugins/") || path.includes("/.agents/plugins/")) return "App";
  switch (skill.scope?.trim().toLowerCase()) {
    case "repo":
    case "repository":
      return "Repo";
    case "project":
    case "workspace":
    case "local":
      return "Project";
    case "user":
    case "personal":
      return "Personal";
    case "system":
      return "System";
    default:
      return "Provider";
  }
}

/**
 * Skills matching a trigger's query, best first. Under `/` a skill also
 * answers to `skill` and `skill:<query>`, as it lists as `/skill:<name>`.
 */
export function searchSkills(skills: readonly T3Skill[], trigger: Pick<ComposerTrigger, "kind" | "query">): T3Skill[] {
  const query = trigger.query.trim().toLowerCase();
  if (!query || (trigger.kind === "slash" && query === "skill")) return [...skills];
  const skillQuery = trigger.kind === "slash" && query.startsWith("skill:") ? query.slice("skill:".length) : query;
  return skills
    .map((skill) => {
      const score = skillQuery ? scoreSkill(skill, skillQuery) : 0;
      const fallback = trigger.kind === "slash" && "skill".startsWith(query) ? Number.MAX_SAFE_INTEGER : null;
      return { skill, score: score ?? fallback, tieBreaker: `${skillLabel(skill).toLowerCase()}\u0000${skill.name}` };
    })
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.tieBreaker.localeCompare(b.tieBreaker))
    .map((entry) => entry.skill);
}

/** Lower is better: name beats label beats description beats scope; exact beats prefix beats word start beats substring beats fuzzy. */
function scoreSkill(skill: T3Skill, query: string): number | null {
  const scores = [
    scoreMatch(skill.name.toLowerCase(), query, [0, 2, 4, 6, 100], ["-", "_", "/"]),
    scoreMatch(skillLabel(skill).toLowerCase(), query, [1, 3, 5, 7, 110]),
    scoreMatch(skill.description?.toLowerCase() ?? "", query, [20, 22, 24, 26]),
    scoreMatch(skill.scope?.toLowerCase() ?? "", query, [40, 42, undefined, 44]),
  ].filter((score) => score !== null);
  return scores.length ? Math.min(...scores) : null;
}

/** T3 Code's `scoreQueryMatch`: `bases` are [exact, prefix, word start, substring, fuzzy]; a missing base skips that tier. */
function scoreMatch(value: string, query: string, bases: Array<number | undefined>, boundaries = [" ", "-", "_", "/"]): number | null {
  if (!value) return null;
  const [exact, prefix, boundary, includes, fuzzy] = bases;
  const penalty = Math.min(64, Math.max(0, value.length - query.length));
  if (value === query) return exact!;
  if (prefix !== undefined && value.startsWith(query)) return prefix + penalty;
  if (boundary !== undefined) {
    const indexes = boundaries.map((marker) => value.indexOf(marker + query)).filter((index) => index !== -1);
    if (indexes.length) return boundary + (Math.min(...indexes) + 1) * 2 + penalty;
  }
  const index = value.indexOf(query);
  if (includes !== undefined && index !== -1) return includes + index * 2 + penalty;
  if (fuzzy === undefined) return null;
  const subsequence = scoreSubsequence(value, query);
  return subsequence === null ? null : fuzzy + subsequence;
}

/** Characters of `query` in order within `value`, penalising late starts and gaps. */
function scoreSubsequence(value: string, query: string): number | null {
  let matched = 0;
  let first = -1;
  let previous = -1;
  let gaps = 0;
  for (let index = 0; index < value.length && matched < query.length; index++) {
    if (value[index] !== query[matched]) continue;
    if (first === -1) first = index;
    if (previous !== -1) gaps += index - previous - 1;
    previous = index;
    matched++;
  }
  if (matched < query.length) return null;
  return first * 2 + gaps * 3 + (previous - first + 1 - query.length) + Math.min(64, value.length - query.length);
}
