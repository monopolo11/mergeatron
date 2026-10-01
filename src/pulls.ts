import type { WebhookContext } from "./github.ts";
import { logger } from "./log.ts";

const log = logger("github");

/**
 * Fills in the PR template variables GitHub's webhook would have carried
 * (`pr_head`, `pr_base`, `pr_title`, ...) for triggers that only know the PR
 * URL, such as Slack messages. Uses the `gh` CLI so the laptop's existing
 * GitHub login covers private repositories. Best effort: without `gh` or
 * access the context comes back unchanged and the thread runs in the local
 * checkout instead of a worktree.
 */
export async function withPullRequestDetails(ctx: WebhookContext): Promise<WebhookContext> {
  if (!ctx.repo || !ctx.pr_number || ctx.pr_head) return ctx;
  const result = await Bun.$`gh api repos/${ctx.repo}/pulls/${ctx.pr_number}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    log.warn("gh api failed; running without PR details", { repo: ctx.repo, pr: ctx.pr_number, error: result.stderr.toString().trim() });
    return ctx;
  }
  const pr = result.json() as {
    title?: string;
    body?: string | null;
    user?: { login?: string };
    head?: { ref?: string; sha?: string };
    base?: { ref?: string; repo?: { default_branch?: string; html_url?: string } };
  };
  return {
    ...ctx,
    ...defined({
      pr_title: pr.title,
      pr_body: pr.body ?? undefined,
      pr_author: pr.user?.login,
      pr_head: pr.head?.ref,
      pr_head_sha: pr.head?.sha,
      pr_base: pr.base?.ref,
      default_branch: pr.base?.repo?.default_branch,
      repo_url: pr.base?.repo?.html_url,
    }),
  };
}

function defined<T extends Record<string, string | undefined>>(values: T): Partial<Record<keyof T, string>> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<Record<keyof T, string>>;
}

/** Whether GitHub says the PR is merged, via the `gh` CLI; null when `gh` cannot tell (not installed, no access). */
export async function pullRequestMerged(repo: string, prNumber: string): Promise<boolean | null> {
  const result = await Bun.$`gh api repos/${repo}/pulls/${prNumber} --jq .merged`.quiet().nothrow();
  if (result.exitCode !== 0) {
    log.warn("gh api failed; cannot tell whether the PR is merged", { repo, pr: prNumber, error: result.stderr.toString().trim() });
    return null;
  }
  return result.text().trim() === "true";
}
