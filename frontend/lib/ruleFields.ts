import type { RuleDraft } from "@/lib/shell";
import { CUSTOM_WEBHOOK_EVENT_PREFIX, INBOX_EVENT_PREFIX, SLACK_EVENT_PREFIX, inboxSource } from "../../src/shared.ts";

/** Which kinds of delivery a rule's events cover; the editor shows the fields that apply to any of them. */
export function eventKinds(events: string[]) {
  return {
    isSlack: events.some((event) => event.startsWith(SLACK_EVENT_PREFIX)),
    isInbox: events.some((event) => event.startsWith(INBOX_EVENT_PREFIX)),
    /** GitHub webhook events. */
    isWebhook: events.some((event) => ![SLACK_EVENT_PREFIX, INBOX_EVENT_PREFIX, CUSTOM_WEBHOOK_EVENT_PREFIX].some((prefix) => event.startsWith(prefix))),
    isCustom: events.some((event) => event.startsWith(CUSTOM_WEBHOOK_EVENT_PREFIX)),
    inboxLinear: events.some((event) => inboxSource(event) === "linear"),
    inboxSentry: events.some((event) => inboxSource(event) === "sentry"),
    inboxGitHub: events.some((event) => inboxSource(event) === "github"),
  };
}

/**
 * The draft as it should be saved: text trimmed, and every matching field the
 * editor hides for these events cleared. A hidden value still filters
 * deliveries (a repository left over from a GitHub event blocks every Linear
 * issue), and nothing in the form could show or remove it.
 */
export function applicable(draft: RuleDraft): RuleDraft {
  const { isSlack, isInbox, isWebhook, inboxLinear, inboxSentry, inboxGitHub } = eventKinds(draft.events);
  const { filters } = draft;
  return {
    ...draft,
    repos: isWebhook || isSlack || inboxGitHub ? draft.repos : [],
    reviewer: (isWebhook && draft.reviewer?.trim()) || null,
    channel: (isSlack && draft.channel?.trim()) || null,
    filters: {
      ...filters,
      teams: inboxLinear || inboxSentry ? filters.teams : [],
      reasons: isInbox ? filters.reasons : [],
      states: isInbox ? filters.states : [],
      labels: isInbox || isWebhook ? filters.labels : "",
    },
  };
}
