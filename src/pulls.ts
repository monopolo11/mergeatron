import { Context, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { exec } from "./exec.ts";
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
export const withPullRequestDetails = Effect.fn("github.pullRequestDetails")(function* (ctx: WebhookContext) {
  if (!ctx.repo || !ctx.pr_number || ctx.pr_head) return ctx;
  const result = yield* exec("gh", ["api", `repos/${ctx.repo}/pulls/${ctx.pr_number}`]).pipe(
    Effect.flatMap((output) => (output.exitCode === 0 ? Effect.succeed(output.stdout) : Effect.fail(output.stderr))),
    Effect.mapError((error) => (typeof error === "string" ? error : error.message)),
    Effect.flatMap((stdout) => Effect.try({ try: () => JSON.parse(stdout) as PullRequestPayload, catch: () => "gh returned no JSON" })),
    Effect.result,
  );
  if (result._tag === "Failure") {
    yield* log.warn("gh api failed; running without PR details", { repo: ctx.repo, pr: ctx.pr_number, error: result.failure });
    return ctx;
  }
  const pr = result.success;
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
});

type PullRequestPayload = {
  title?: string;
  body?: string | null;
  user?: { login?: string };
  head?: { ref?: string; sha?: string };
  base?: { ref?: string; repo?: { default_branch?: string; html_url?: string } };
};

function defined<T extends Record<string, string | undefined>>(values: T): Partial<Record<keyof T, string>> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<Record<keyof T, string>>;
}

/** Whether GitHub says the PR is merged, via the `gh` CLI; null when `gh` cannot tell (not installed, no access). */
export const pullRequestMerged = Effect.fn("github.pullRequestMerged")(function* (repo: string, prNumber: string) {
  const result = yield* exec("gh", ["api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".merged"]).pipe(Effect.result);
  if (result._tag === "Failure" || result.success.exitCode !== 0) {
    const error = result._tag === "Failure" ? result.failure.message : result.success.stderr;
    yield* log.warn("gh api failed; cannot tell whether the PR is merged", { repo, pr: prNumber, error });
    return null;
  }
  return result.success.stdout.trim() === "true";
});

export type PullRequestsShape = {
  readonly details: (ctx: WebhookContext) => Effect.Effect<WebhookContext>;
  readonly merged: (repo: string, prNumber: string) => Effect.Effect<boolean | null>;
};

/** GitHub lookups the triggers need, through the `gh` CLI; tests provide fakes. */
export class PullRequests extends Context.Service<PullRequests, PullRequestsShape>()("PullRequests") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const provide = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner);
      return { details: (ctx) => provide(withPullRequestDetails(ctx)), merged: (repo, prNumber) => provide(pullRequestMerged(repo, prNumber)) };
    }),
  );
}
