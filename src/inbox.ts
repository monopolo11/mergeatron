import type { Verdict } from "./completion.ts";
import type { WebhookContext } from "./github.ts";
import { ruleMismatch } from "./match.ts";
import type { PollStatus } from "./poller.ts";
import type { Rule, Run } from "./rules.ts";
import { inboxEvent, type InboxKind, type InboxReason, type InboxSource } from "./shared.ts";

import type { inboxItems } from "./db/schema.ts";

/** A persisted inbox row: what the source returned plus when it was seen and when it left. */
export type InboxItem = typeof inboxItems.$inferSelect;
/** What a source returns for one PR or issue; the store adds the tracking columns. */
export type PolledItem = Omit<InboxItem, "firstSeenAt" | "lastSeenAt" | "goneAt">;

/**
 * A label items of a source can carry, synced so the rule editor can suggest
 * labels no inbox item has yet. `scope` is the repository (`owner/name`,
 * lowercased) for GitHub, the team key for Linear, or null for Linear
 * workspace labels, which every team shares.
 */
export type InboxLabel = { name: string; scope: string | null };

/** `GET /api/labels`: the last synced labels per source, empty until a sync succeeds. */
export type LabelsResponse = Record<InboxSource, InboxLabel[]>;

/** The latest run on an item's PR or issue, from any trigger. The reply stays out: it can be long. */
export type InboxRun = Pick<Run, "id" | "status" | "ruleName" | "detail" | "threadUrl" | "createdAt"> & { verdict: Verdict | null };

/** `GET /api/inbox`; `?gone=1` appends the items that left the inbox after something ran on them, newest departure first. */
export type InboxResponse = {
  polling: Record<InboxSource, PollStatus>;
  /** Items that left the inbox after something ran on them, within retention (30 days). */
  gone: number;
  items: (InboxItem & { lastRun: InboxRun | null })[];
};

export function itemEvent(item: Pick<PolledItem, "source" | "kind">): string {
  return inboxEvent(item.source, item.kind);
}

/** Template variables for an item, in the same names webhook deliveries use so prompts and filters carry over. */
export function itemContext(item: PolledItem): WebhookContext {
  const ctx: WebhookContext = {
    repo: item.repo ?? "",
    event: itemEvent(item),
    state: item.state,
    labels: item.labels.join(", "),
    reasons: item.reasons.join(", "),
  };
  const common = {
    repo_url: item.repoUrl,
    default_branch: item.defaultBranch,
    state_type: item.stateType,
    team: item.team,
    priority: item.priority,
    branch: item.branch,
    review_decision: item.reviewDecision,
  };
  const specific =
    item.kind === "pull_request"
      ? {
          pr_number: item.identifier.replace(/^#/, ""),
          pr_title: item.title,
          pr_url: item.url,
          pr_body: item.body,
          pr_author: item.author,
          pr_head: item.branch,
          pr_head_sha: item.headSha,
          pr_base: item.base,
        }
      : {
          issue_number: item.source === "github" ? item.identifier.replace(/^#/, "") : null,
          issue_identifier: item.identifier,
          issue_title: item.title,
          issue_url: item.url,
          issue_body: item.body,
          issue_author: item.author,
        };
  for (const [name, value] of Object.entries({ ...common, ...specific })) {
    if (value !== null && value !== undefined) ctx[name as keyof WebhookContext] = value;
  }
  return ctx;
}

/**
 * Delivery id of an item for a rule: the item key, plus the PR head when the
 * rule re-runs on pushes, so each head gets its own review and nothing else
 * repeats. `hasRun(deliveryId, ruleId)` then dedupes across polls.
 */
export function itemDeliveryId(item: PolledItem, rule: Pick<Rule, "filters">): string {
  return item.kind === "pull_request" && rule.filters.rerunOnPush && item.headSha ? `${item.key}@${item.headSha.slice(0, 12)}` : item.key;
}

/**
 * Rules an item should start now: the rule matches, has not run for this
 * delivery id, and is armed for the item, meaning the item saw activity after
 * the rule was last saved. Arming keeps a new or re-enabled rule from firing
 * on everything already in the inbox; "Run now" in the editor backfills on
 * purpose with `armed: false`.
 */
export function automationsFor(
  item: PolledItem,
  rules: Rule[],
  hasRun: (deliveryId: string, ruleId: string) => boolean,
  options: { armed: boolean } = { armed: true },
): { rule: Rule; deliveryId: string }[] {
  const ctx = itemContext(item);
  const event = itemEvent(item);
  return rules.flatMap((rule) => {
    if (ruleMismatch(rule, event, ctx) !== null) return [];
    if (options.armed && Date.parse(item.updatedAt) <= Date.parse(rule.updatedAt)) return [];
    const deliveryId = itemDeliveryId(item, rule);
    return hasRun(deliveryId, rule.id) ? [] : [{ rule, deliveryId }];
  });
}
