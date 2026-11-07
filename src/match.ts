import type { WebhookContext } from "./github.ts";
import { formatQuery, matchesQuery, parseQuery, termValues, type QueryKey, type QuerySubject } from "./filterQuery.ts";
import type { Rule } from "./rules.ts";

/**
 * Rule matching, free of server dependencies so the UI can run it too (the
 * rule editor counts the inbox items a rule would fire on).
 */

/** Rules that apply to this delivery: event, reviewer, channel and filter all pass. */
export function matchRules(rules: Rule[], key: string, ctx: WebhookContext): Rule[] {
  return rules.filter((rule) => ruleMismatch(rule, key, ctx) === null);
}

/** Why a rule does not apply to this delivery, or null when it does. Logged for deliveries no rule wanted. */
export function ruleMismatch(rule: Rule, key: string, ctx: WebhookContext): string | null {
  if (!rule.enabled) return "disabled";
  if (!rule.events.includes(key)) return `listens to ${rule.events.join(", ")}`;
  if (rule.reviewer && !sameName(rule.reviewer, ctx.requested_reviewer ?? "")) {
    return `requested reviewer ${ctx.requested_reviewer ?? "(none)"} is not ${rule.reviewer}`;
  }
  if (rule.channel && !sameName(rule.channel, ctx.slack_channel ?? "")) {
    return `channel ${ctx.slack_channel ?? "(none)"} is not ${rule.channel}`;
  }
  if (ctx.slack_bot_id && !rule.allowBots) return "posted by a bot; rule does not accept bots";
  return filterMismatch(rule.filters.query, ctx);
}

/**
 * Why the delivery fails a rule's filter expression (see `filterQuery.ts`),
 * or null when it passes: the first top-level `and` part that fails, with
 * what the delivery has for it. A done Linear issue only matches a filter
 * with a `state:` term naming its state or type (outside negations), so rules
 * written before done issues were polled do not start firing on finished
 * work, and `state:Todo or bug` does not catch a done bug.
 */
export function filterMismatch(text: string, ctx: WebhookContext): string | null {
  const parsed = parseQuery(text);
  if (!parsed.ok) return `filter is invalid: ${parsed.error}`;
  const done = ctx.state_type === "completed";
  if (done && !termValues(text, "state").some((state) => sameName(state, ctx.state ?? "") || sameName(state, "completed"))) {
    return `state ${ctx.state ?? "(none)"} is done; name it in a state: term to run on done issues`;
  }
  const subject = querySubject(ctx);
  const parts = parsed.query?.type === "and" ? parsed.query.queries : parsed.query ? [parsed.query] : [];
  const failed = parts.find((part) => !matchesQuery(part, subject));
  if (!failed) return null;
  const term = failed.type === "not" ? failed.query : failed;
  return term.type === "term" ? `${has(term.key, term.value, ctx)} does not match ${formatQuery(failed)}` : `does not match ${formatQuery(failed)}`;
}

/** What the delivery offers each filter key, from its template variables; list variables are comma separated. */
export function querySubject(ctx: WebhookContext): QuerySubject {
  return {
    label: values(ctx.labels),
    state: [ctx.state, ctx.state_type].filter((value): value is string => value !== undefined),
    team: values(ctx.team),
    reason: values(ctx.reasons),
    repo: values(ctx.repo),
    tag: (ctx.tags ?? "").split("\n"),
    has: [...(ctx.issue_parent ? ["parent"] : []), ...(ctx.issue_children ? ["sub-issues"] : [])],
    any: Object.values(ctx).filter((value) => value !== undefined),
  };
}

/** What the delivery has for a key, for mismatch messages: `state Todo`, `no parent issue`, `issue_title has i9`. */
function has(key: QueryKey, value: string, ctx: WebhookContext): string {
  switch (key) {
    case "label":
      return `labels ${ctx.labels || "(none)"}`;
    case "state":
      return `state ${ctx.state ?? "(none)"}`;
    case "team":
      return `team ${ctx.team ?? "(none)"}`;
    case "reason":
      return `reasons ${ctx.reasons || "(none)"}`;
    case "repo":
      return `repo ${ctx.repo || "(none)"}`;
    case "tag":
      return `tags ${ctx.tags?.replaceAll("\n", ", ") || "(none)"}`;
    case "has":
      if (value.toLowerCase() === "parent") return ctx.issue_parent ? `parent ${ctx.issue_parent}` : "no parent issue";
      return ctx.issue_children ? `sub-issues ${ctx.issue_children}` : "no sub-issues";
    case "any": {
      const field = Object.entries(ctx).find(([, text]) => text?.toLowerCase().includes(value.toLowerCase()));
      return field ? `${field[0]} has ${value}` : `no field has ${value}`;
    }
  }
}

function values(list: string | undefined): string[] {
  return (list ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
}

export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
