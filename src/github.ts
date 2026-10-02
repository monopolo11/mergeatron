import { timingSafeEqual } from "node:crypto";
import type { TemplateVar } from "./shared.ts";

/** Validates `X-Hub-Signature-256` against the raw request body. */
export function verifySignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = new Bun.CryptoHasher("sha256", secret).update(rawBody).digest("hex");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
}

/** `<event>.<action>` or just `<event>` when the payload carries no action. */
export function eventKey(eventName: string, payload: unknown): string {
  const action = isRecord(payload) && typeof payload.action === "string" ? payload.action : null;
  return action ? `${eventName}.${action}` : eventName;
}

export type WebhookContext = Partial<Record<TemplateVar, string>> & { repo: string };

/**
 * Flattens the parts of a GitHub payload that prompts care about into
 * template variables. Missing fields are simply absent.
 */
export function extractContext(eventName: string, payload: unknown): WebhookContext {
  const p = isRecord(payload) ? payload : {};
  const repo = rec(p.repository);
  const pr = rec(p.pull_request);
  const issue = rec(p.issue);
  const comment = rec(p.comment);
  const review = rec(p.review);

  const ctx: WebhookContext = {
    repo: str(repo.full_name) ?? "",
    event: eventName,
  };
  set(ctx, "action", str(p.action));
  set(ctx, "repo_url", str(repo.html_url));
  set(ctx, "default_branch", str(repo.default_branch));
  set(ctx, "sender", str(rec(p.sender).login));
  set(ctx, "label", str(rec(p.label).name));

  // review_requested carries either a user or a team.
  const reviewer = rec(p.requested_reviewer);
  const team = rec(p.requested_team);
  set(ctx, "requested_reviewer", str(reviewer.login) ?? str(team.slug));

  if (Object.keys(pr).length > 0) {
    set(ctx, "pr_number", num(pr.number));
    set(ctx, "pr_title", str(pr.title));
    set(ctx, "pr_url", str(pr.html_url));
    set(ctx, "pr_body", str(pr.body));
    set(ctx, "pr_author", str(rec(pr.user).login));
    set(ctx, "pr_head", str(rec(pr.head).ref));
    set(ctx, "pr_head_sha", str(rec(pr.head).sha));
    set(ctx, "pr_base", str(rec(pr.base).ref));
    // Same shape as inbox items, so label and state filters work on webhook rules too.
    set(ctx, "labels", labelNames(pr.labels));
    set(ctx, "state", pr.draft === true ? "draft" : str(pr.state));
  }

  if (Object.keys(issue).length > 0) {
    set(ctx, "issue_number", num(issue.number));
    set(ctx, "issue_title", str(issue.title));
    set(ctx, "issue_url", str(issue.html_url));
    set(ctx, "issue_body", str(issue.body));
    set(ctx, "issue_author", str(rec(issue.user).login));
    set(ctx, "labels", labelNames(issue.labels));
    set(ctx, "state", str(issue.state));
    // A comment on a PR arrives as issue_comment with issue.pull_request set.
    if (isRecord(issue.pull_request)) {
      set(ctx, "pr_number", num(issue.number));
      set(ctx, "pr_title", str(issue.title));
      set(ctx, "pr_url", str(rec(issue.pull_request).html_url) ?? str(issue.html_url));
      set(ctx, "pr_author", str(rec(issue.user).login));
    }
  }

  set(ctx, "comment_body", str(comment.body));
  set(ctx, "comment_author", str(rec(comment.user).login));
  set(ctx, "comment_url", str(comment.html_url));
  set(ctx, "review_state", str(review.state));
  set(ctx, "review_body", str(review.body));
  set(ctx, "review_author", str(rec(review.user).login));

  return ctx;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function rec(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function num(value: unknown): string | undefined {
  return typeof value === "number" ? String(value) : undefined;
}
/** `labels: [{ name }]` as the comma-separated `labels` variable; absent when the payload has none. */
function labelNames(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.flatMap((label) => (typeof rec(label).name === "string" ? [rec(label).name as string] : []));
  return names.length > 0 ? names.join(", ") : undefined;
}
function set(ctx: WebhookContext, key: TemplateVar, value: string | undefined) {
  if (value !== undefined) ctx[key] = value;
}
