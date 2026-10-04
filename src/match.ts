import type { WebhookContext } from "./github.ts";
import type { Rule } from "./rules.ts";
import type { RuleFilters } from "./shared.ts";

/**
 * Rule matching, free of server dependencies so the UI can run it too (the
 * rule editor counts the inbox items a rule would fire on).
 */

/** Rules that apply to this delivery: event, repository, reviewer, channel and filters all pass. */
export function matchRules(rules: Rule[], key: string, ctx: WebhookContext): Rule[] {
  return rules.filter((rule) => ruleMismatch(rule, key, ctx) === null);
}

/** Why a rule does not apply to this delivery, or null when it does. Logged for deliveries no rule wanted. */
export function ruleMismatch(rule: Rule, key: string, ctx: WebhookContext): string | null {
  if (!rule.enabled) return "disabled";
  if (!rule.events.includes(key)) return `listens to ${rule.events.join(", ")}`;
  if (rule.repos.length > 0 && !rule.repos.some((repo) => sameName(repo, ctx.repo))) {
    return `repo ${ctx.repo || "(none)"} not in ${rule.repos.join(", ")}`;
  }
  if (rule.reviewer && !sameName(rule.reviewer, ctx.requested_reviewer ?? "")) {
    return `requested reviewer ${ctx.requested_reviewer ?? "(none)"} is not ${rule.reviewer}`;
  }
  if (rule.channel && !sameName(rule.channel, ctx.slack_channel ?? "")) {
    return `channel ${ctx.slack_channel ?? "(none)"} is not ${rule.channel}`;
  }
  if (ctx.slack_bot_id && !rule.allowBots) return "posted by a bot; rule does not accept bots";
  return filterMismatch(rule.filters, ctx);
}

/**
 * The first filter the delivery fails, or null. List-valued variables
 * (`labels`, `reasons`) are comma separated; a filter passes when any of its
 * values is present, except `notLabels`, which fails when any of its values is
 * present. `states` accepts the state name or, for Linear, its type.
 */
export function filterMismatch(filters: RuleFilters, ctx: WebhookContext): string | null {
  if (!intersects(filters.reasons, ctx.reasons)) return `reasons ${ctx.reasons || "(none)"} include none of ${filters.reasons.join(", ")}`;
  if (filters.allLabels && !includesAll(filters.labels, ctx.labels)) return `labels ${ctx.labels || "(none)"} lack one of ${filters.labels.join(", ")}`;
  if (!filters.allLabels && !intersects(filters.labels, ctx.labels)) return `labels ${ctx.labels || "(none)"} include none of ${filters.labels.join(", ")}`;
  const excluded = filters.notLabels.find((label) => intersects([label], ctx.labels));
  if (excluded) return `labels ${ctx.labels} include ${excluded}`;
  if (!intersects(filters.states, [ctx.state, ctx.state_type].filter(Boolean).join(","))) {
    return `state ${ctx.state ?? "(none)"} is not ${filters.states.join(", ")}`;
  }
  if (!intersects(filters.teams, ctx.team)) return `team ${ctx.team ?? "(none)"} is not ${filters.teams.join(", ")}`;
  return null;
}

/** True when `wanted` is empty or shares a value with the comma-separated `actual`, ignoring case. */
function intersects(wanted: string[], actual: string | undefined): boolean {
  const present = values(actual);
  return wanted.length === 0 || wanted.some((value) => present.includes(value.trim().toLowerCase()));
}

/** True when every value of `wanted` is in the comma-separated `actual`, ignoring case. */
function includesAll(wanted: string[], actual: string | undefined): boolean {
  const present = values(actual);
  return wanted.every((value) => present.includes(value.trim().toLowerCase()));
}

function values(list: string | undefined): string[] {
  return (list ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
}

export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
