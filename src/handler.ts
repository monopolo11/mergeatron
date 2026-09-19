import { eventKey, extractContext, type WebhookContext } from "./github.ts";
import type { Rule } from "./rules.ts";
import type { Store } from "./store.ts";
import { renderTemplate } from "./template.ts";
import type { T3Client, T3Project } from "./t3.ts";

export type Delivery = {
  deliveryId: string;
  eventName: string;
  payload: unknown;
};

export type HandlerDeps = {
  store: Store;
  t3: T3Client;
};

/** Rules that apply to this delivery: event, repository and reviewer filters all pass. */
export function matchRules(rules: Rule[], key: string, ctx: WebhookContext): Rule[] {
  return rules.filter((rule) => {
    if (!rule.enabled || rule.event !== key) return false;
    if (rule.repos.length > 0 && !rule.repos.some((repo) => sameName(repo, ctx.repo))) return false;
    if (rule.reviewer && !sameName(rule.reviewer, ctx.requested_reviewer ?? "")) return false;
    return true;
  });
}

/** Explicit project first, otherwise the project whose git remote points at this repository. */
export function resolveProject(rule: Rule, projects: T3Project[], repo: string): T3Project | null {
  if (rule.projectId) return projects.find((project) => project.id === rule.projectId) ?? null;
  return projects.find((project) => hostsRepository(project, repo)) ?? null;
}

/** True when the project's git remote is this GitHub repository (`owner/name`). */
export function hostsRepository(project: T3Project, repo: string): boolean {
  const identity = project.repositoryIdentity;
  return (
    identity?.provider === "github" &&
    !!identity.owner &&
    !!identity.name &&
    sameName(`${identity.owner}/${identity.name}`, repo)
  );
}

/**
 * Matches the delivery against the rules and starts one T3 thread per match.
 * Returns as soon as runs are recorded; thread creation continues in the
 * background so GitHub gets its response well inside its 10s timeout.
 */
export function handleDelivery(deps: HandlerDeps, delivery: Delivery) {
  const key = eventKey(delivery.eventName, delivery.payload);
  const ctx = extractContext(delivery.eventName, delivery.payload);
  const matched = matchRules(deps.store.listRules(), key, ctx).filter(
    (rule) => !deps.store.hasRun(delivery.deliveryId, rule.id),
  );

  for (const rule of matched) {
    const run = deps.store.recordRun({
      ruleId: rule.id,
      ruleName: rule.name,
      deliveryId: delivery.deliveryId,
      event: key,
      repo: ctx.repo,
      source: "github",
      author: ctx.pr_author ?? ctx.issue_author ?? ctx.sender ?? null,
      status: "started",
      detail: "starting thread",
      threadId: null,
      threadUrl: null,
      context: ctx,
    });
    void startThreadForRule(deps, rule, ctx).then(
      (result) => deps.store.updateRun(run.id, result),
      (error: unknown) =>
        deps.store.updateRun(run.id, {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
          threadId: null,
          threadUrl: null,
        }),
    );
  }

  return { event: key, repo: ctx.repo, matched: matched.map((rule) => rule.name) };
}

async function startThreadForRule(deps: HandlerDeps, rule: Rule, ctx: WebhookContext) {
  const project = resolveProject(rule, await deps.t3.projects(), ctx.repo);
  if (!project) {
    return skipped(
      rule.projectId
        ? `T3 project ${rule.projectId} no longer exists`
        : `no T3 project has a git remote for ${ctx.repo}`,
    );
  }

  const settings = deps.store.getSettings();
  const prNumber = ctx.pr_number ? Number(ctx.pr_number) : null;
  const baseBranch = ctx.pr_head ?? ctx.default_branch ?? null;
  const worktree = rule.workspace === "worktree";

  const thread = await deps.t3.startThread({
    project,
    title: `${rule.name}: ${ctx.pr_title ?? ctx.issue_title ?? ctx.repo}`.slice(0, 120),
    prompt: renderTemplate(rule.prompt, ctx),
    modelSelection: rule.model ?? project.defaultModelSelection ?? settings.model,
    runtimeMode: settings.runtimeMode,
    baseBranch,
    worktree,
    // T3 derives the legacy PR field from the project's remote and crashes the
    // thread snapshot when the link's repository is not the project's, so only
    // link when the project really is this GitHub repository.
    pullRequest:
      prNumber !== null && ctx.pr_url && hostsRepository(project, ctx.repo)
        ? { repository: ctx.repo, number: prNumber, url: ctx.pr_url }
        : null,
  });

  return {
    status: "started" as const,
    detail: worktree && baseBranch ? `worktree from origin/${baseBranch}` : `checkout ${project.workspaceRoot}`,
    ...thread,
  };
}

function skipped(detail: string) {
  return { status: "skipped" as const, detail, threadId: null, threadUrl: null };
}

function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
