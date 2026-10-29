import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Cause, Effect, Exit } from "effect";
import { z } from "zod";
import { assertChannelAllowed } from "./channels.ts";
import { errorMessage } from "./errors.ts";
import { logger } from "./log.ts";
import { notifyUser } from "./notify.ts";
import { Poller } from "./poller.ts";
import { createVersion, listPrompts, promoteVersion, readPrompt } from "./promptVersions.ts";
import { markMerged, requestReview, requestSecondPass, reviewStatus, type ReviewServices } from "./reviewRequests.ts";
import { createRule, deleteRule, updateRule, type RuleCreate, type RulePatch } from "./ruleAdmin.ts";
import { getRun, listRuns, rateRun, runAnalytics } from "./runHistory.ts";
import { syncPullRequests } from "./runPullRequests.ts";
import { startBackfill } from "./usage.ts";
import { PROMPT_OWNERS, PROMPT_VERSION_OWNERS, RUN_SOURCES, RUN_STATUSES, SUGGESTED_EVENTS, WORKSPACE_MODES } from "./shared.ts";
import { Store } from "./store.ts";
import { SlackClient } from "./slack.ts";

/**
 * MCP tools for other agents: post as the Slack bot, DM the user for their
 * attention (see notify.ts), and send PRs for review with tracked threads and
 * rounds, and mark those threads merged (see reviewRequests.ts), read and
 * version the prompts rules and dispatches use (see promptVersions.ts),
 * list, create, edit and delete rules (see ruleAdmin.ts), and read, rate and
 * compare past runs with what they spent (see runHistory.ts, usage.ts).
 * Stateless Streamable HTTP, one server per request;
 * index.ts serves it on loopback. Tool inputs stay zod schemas: that is what
 * the MCP SDK accepts and turns into the JSON Schema it advertises.
 */

const log = logger("mcp");

/** Failures the agent can act on: returned as tool errors without an error log. */
const EXPECTED = new Set([
  "ReviewRequestError",
  "NotifyError",
  "SlackApiError",
  "ChannelNotAllowedError",
  "PromptNotFoundError",
  "RunNotFoundError",
  "InvalidFollowUpError",
  "RuleNotFoundError",
  "SchemaError",
]);

const prUrl = z.string().describe("GitHub pull request URL, https://github.com/<owner>/<repo>/pull/<number>");
const mentions = z
  .array(z.string())
  .optional()
  .describe("People to tag: Slack user ids (U…), user group ids (S…), or here/channel. Without them, request_review tags the default reviewers from Settings and a second pass tags whoever the last round did");
const note = z.string().optional().describe("Extra Markdown shown in the message, e.g. what changed since the last round");
const promptOwner = z.enum(PROMPT_OWNERS).describe("preset: a dispatch preset. rule: a rule's own prompt");
const promptId = z.string().describe("Id of the preset or rule, from list_prompts");
const runId = z.string().describe("Run id, from list_runs");
const ruleId = z.string().describe("Rule id, from list_rules");

/**
 * A rule's fields as the tools advertise them. ruleAdmin.ts decodes them
 * again with the UI's schemas, which own defaults and validation; the check
 * below keeps these in step with those schemas.
 */
const ruleFields = z.object({
  name: z.string().describe("Shown in the UI and the run log"),
  enabled: z.boolean().describe("false: the rule stops firing. Default true"),
  events: z
    .array(z.string())
    .min(1)
    .describe(`Event keys it fires on: ${SUGGESTED_EVENTS.map((event) => event.key).join(", ")}, or webhook.<slug> for a custom webhook defined in Settings. An inbox rule takes the inbox events of one source only`),
  reviewer: z.string().nullable().describe("Only fire when this GitHub login or team slug is the requested reviewer"),
  channel: z.string().nullable().describe("Slack events: the channel id to listen in; null means any channel the bot is in"),
  allowBots: z.boolean().describe("Slack events: also fire for posts by other bots and apps. Default true"),
  skipSelfReview: z.boolean().describe("Skip PRs authored by the GitHub login in Settings. Default true"),
  filters: z
    .object({
      query: z
        .string()
        .optional()
        .describe(
          'Filter expression such as \'reason:assigned and state:"To Do" and (bug or p0) and !has:parent\'. Bare words are labels (names from list_labels); key:value tests state (name or type), team (Linear team key or Sentry project), reason (review_requested, assigned, mentioned, authored, watching), repo (owner/name) or has (parent, sub-issues: Linear issue relations). and, or (or a comma), parentheses, ! or not: to negate; quote a value holding an operator, with \\\" for a quote inside quotes. Case-insensitive; empty matches anything. A done Linear issue only matches a filter with a state: term naming its state or type',
        ),
      rerunOnPush: z.boolean().optional().describe("Inbox PR rules: run again when the PR head moves. Default true"),
    })
    .describe("Filters on top of the event; an empty filter matches anything"),
  maxConcurrent: z.number().int().min(0).describe("Threads running at once; further matches queue. 0 means no limit. Default 3"),
  projectId: z.string().nullable().describe("T3 project to open threads in; null matches by the repository's git remote"),
  workspace: z.enum(WORKSPACE_MODES).describe("worktree (default): a new worktree per thread. local: the project's checkout"),
  model: z
    .object({
      instanceId: z.string(),
      model: z.string(),
      options: z
        .array(z.object({ id: z.string().min(1), value: z.union([z.string().min(1), z.boolean()]) }))
        .optional()
        .describe('Model options as T3 takes them, e.g. [{ "id": "effort", "value": "high" }] for a Claude reasoning level ("reasoningEffort" for Codex). Omitted uses the model\'s defaults'),
    })
    .nullable()
    .describe("Provider instance, model and options; null uses the project's default, then Settings'"),
  presetId: z.string().nullable().describe("Run this preset's live prompt instead of the rule's own; ids from list_prompts"),
});
const rulePatch = ruleFields.partial().extend({
  filters: ruleFields.shape.filters.optional().describe("Only the filters given change; the rest keep their values"),
});
const ruleCreate = rulePatch.required({ name: true, events: true }).extend({
  prompt: z.string().min(1).describe("First message of each thread; becomes version 1, live. Templates use {{variables}} such as {{pr_url}}"),
});
// The advertised fields must be ones the schemas accept: drift fails to compile here.
type Extends<T extends U, U> = T;
export type RuleFieldChecks = [Extends<z.infer<typeof rulePatch>, RulePatch>, Extends<z.infer<typeof ruleCreate>, RuleCreate>];

/** What the tools need: the review tools' services plus the poller, for label suggestions. */
export type McpServices = ReviewServices | Poller;

/** A web handler for `/mcp`, bound to the services in scope when it is built. */
export const makeMcpHandler: Effect.Effect<(request: Request) => Promise<Response>, never, McpServices> = Effect.gen(function* () {
  const services = yield* Effect.context<McpServices>();
  const runPromise = Effect.runPromiseWith(services);
  const slack = yield* SlackClient;
  const store = yield* Store;
  const poller = yield* Poller;

  /** Runs a tool body; errors the agent can act on (bad input, Slack's error code) come back as tool errors, not protocol failures. */
  const result = <A, E>(tool: string, body: Effect.Effect<A, E, McpServices>): Promise<CallToolResult> =>
    runPromise(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(body);
        if (Exit.isSuccess(exit)) return { content: [{ type: "text", text: JSON.stringify(exit.value, null, 2) }] } satisfies CallToolResult;
        const error = Cause.squash(exit.cause);
        const message = errorMessage(error);
        const expected = typeof error === "object" && error !== null && "_tag" in error && EXPECTED.has(String(error._tag));
        if (!expected) yield* log.error("tool failed", { tool, error: message });
        return { isError: true, content: [{ type: "text", text: message }] } satisfies CallToolResult;
      }).pipe(Effect.withSpan("mcp.tool", { attributes: { tool } })),
    );

  const server = () => {
    const server = new McpServer({ name: "mergeatron", version: "1.0.0" });

    server.registerTool(
      "slack_post_message",
      {
        description:
          "Post a message to Slack as the bot. Only the review channel in Settings and channels set on enabled rules are allowed; no DMs (use notify_user). The bot must be a member of the channel. Returns the message ts; pass it as thread_ts to reply in that thread.",
        inputSchema: {
          channel: z.string().describe("Channel id (C0123...) or #name of a public channel"),
          text: z.string().min(1).describe("Message body in Markdown; raw Slack syntax such as <@U123> passes through"),
          thread_ts: z.string().optional().describe("ts of the parent message to reply in its thread"),
        },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      ({ channel, text, thread_ts }) => result("slack_post_message", assertChannelAllowed(channel).pipe(Effect.andThen(slack.post(channel, text, thread_ts)))),
    );

    server.registerTool(
      "notify_user",
      {
        description:
          "DM your user in Slack to get their attention: a question you are blocked on, a decision, or finished work to look at. Say what you need and link the thread or PR. Returns thread_ts; pass it back to reply in the same DM thread.",
        inputSchema: {
          text: z.string().min(1).describe("Message body in Markdown"),
          thread_ts: z.string().optional().describe("thread_ts from an earlier notify_user call, to reply in that DM thread"),
        },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      ({ text, thread_ts }) => result("notify_user", notifyUser(text, thread_ts)),
    );

    server.registerTool(
      "request_review",
      {
        description:
          "Send a pull request for review: posts the request in Slack (tagging reviewers) and starts the orchestrator's automated review. Once per PR; use request_second_pass for later rounds. Returns the Slack thread and round.",
        inputSchema: {
          pr_url: prUrl,
          channel: z.string().optional().describe("Channel id or #name; defaults to the review channel in the orchestrator's Settings"),
          mentions,
          note,
        },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      ({ pr_url, channel, mentions, note }) => result("request_review", requestReview({ prUrl: pr_url, channel, mentions, note })),
    );

    server.registerTool(
      "request_second_pass",
      {
        description:
          "Ask for another review of a PR sent with request_review, e.g. after pushing fixes. Replies in its Slack thread, starts the next round, and re-runs the automated review, even when the PR's reviews are paused.",
        inputSchema: { pr_url: prUrl, mentions, note },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      ({ pr_url, mentions, note }) => result("request_second_pass", requestSecondPass({ prUrl: pr_url, mentions, note })),
    );

    server.registerTool(
      "mark_merged",
      {
        description:
          "Mark a PR sent with request_review as merged: adds the :merge: reaction to the message that opened its Slack review thread. Call after the PR merges; fails when GitHub says it is not merged yet. Safe to repeat.",
        inputSchema: { pr_url: prUrl },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      ({ pr_url }) => result("mark_merged", markMerged(pr_url)),
    );

    server.registerTool(
      "review_status",
      {
        description:
          "Where a PR's review stands: its Slack thread and round, status (reviewing, approved, changes_requested, commented, paused, ...), and the latest automated review's full reply to act on.",
        inputSchema: { pr_url: prUrl },
        annotations: { readOnlyHint: true },
      },
      ({ pr_url }) => result("review_status", reviewStatus(pr_url)),
    );

    server.registerTool(
      "list_prompts",
      {
        description:
          "List the versioned prompts: dispatch presets (owner preset) and each rule's own prompt (owner rule), with the live version runs use and the latest saved. A rule with a presetId runs that preset's live body instead of its own prompt.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () => result("list_prompts", listPrompts()),
    );

    server.registerTool(
      "get_prompt",
      {
        description:
          "Read a preset or rule prompt with every version, newest first: body, note, source (ui or mcp) and when it was saved. liveVersion is the one runs use. Templates use {{variables}} such as {{pr_url}}.",
        inputSchema: { owner: promptOwner, id: promptId },
        annotations: { readOnlyHint: true },
      },
      ({ owner, id }) => result("get_prompt", readPrompt(owner, id)),
    );

    server.registerTool(
      "create_prompt_version",
      {
        description:
          "Save a new version of a preset or rule prompt. It stays a draft that runs ignore until promoted, unless promote is true. A body equal to the latest version's saves nothing new. Returns the version.",
        inputSchema: {
          owner: promptOwner,
          id: promptId,
          body: z.string().min(1).describe("The full prompt text, not a diff"),
          note: z.string().optional().describe("Why this version exists, shown in its history"),
          promote: z.boolean().optional().describe("Make it live right away; default false"),
        },
        annotations: { destructiveHint: false },
      },
      ({ owner, id, body, note, promote }) =>
        result("create_prompt_version", createVersion(owner, id, { body, note: note?.trim() || null, promote: promote ?? false }, "mcp")),
    );

    server.registerTool(
      "promote_prompt_version",
      {
        description: "Make a version of a preset or rule prompt the live one: threads started from now on use its body. Promote an older version to roll back.",
        inputSchema: { owner: promptOwner, id: promptId, version: z.number().int().min(1).describe("Version number from get_prompt") },
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      ({ owner, id, version }) => result("promote_prompt_version", promoteVersion(owner, id, version)),
    );

    server.registerTool(
      "list_runs",
      {
        description:
          "List runs newest first: each thread a rule, dispatch, handoff or connection test started, with its trigger (event, source), status, the prompt versions its message is made of (promptRefs) and the model it started with, when it arrived (createdAt), its thread opened (startedAt) and it ended (settledAt), how long the thread worked (elapsedMs), what it spent (usage: tokens by kind and estimated costUsd, subagents included; null until measured when the run settles), the PRs linked to its T3 thread as last read (pullRequests: the PR a review ran on and those the agent opened, with title and open/closed/merged state), and its rating, written review and the run it follows up (followUpOf). Leaves out the context and reply; read those with get_run.",
        inputSchema: {
          rule_id: z.string().optional().describe("Only runs of this rule; dispatch, handoff and manual are the ids of runs without a stored rule"),
          status: z.enum(RUN_STATUSES).optional(),
          source: z.enum(RUN_SOURCES).optional().describe("What triggered the run: github webhook, slack, poll (inbox automation), webhook (custom webhook) or manual"),
          prompt_owner: z.enum(PROMPT_VERSION_OWNERS).optional().describe("preset, rule, or dispatch: the hand-edited text of an inbox dispatch"),
          prompt_id: z.string().optional().describe("With prompt_owner: only runs whose message is made of this prompt"),
          prompt_version: z.number().int().min(1).optional().describe("With prompt_owner and prompt_id: only runs of this version"),
          model: z.string().optional().describe("Model id, e.g. claude-opus-5-5"),
          rated: z.boolean().optional().describe("true: rated runs only. false: runs not rated yet"),
          since: z.string().optional().describe("ISO timestamp: runs created at or after it"),
          sort: z.enum(["recent", "cost"]).optional().describe("recent (default): newest first. cost: measured runs only, most expensive first"),
          limit: z.number().int().min(1).max(500).optional().describe("Default 50"),
        },
        annotations: { readOnlyHint: true },
      },
      ({ rule_id, status, source, prompt_owner, prompt_id, prompt_version, model, rated, since, sort, limit }) =>
        result(
          "list_runs",
          listRuns({
            ruleIds: rule_id ? [rule_id] : undefined,
            status,
            sources: source ? [source] : undefined,
            prompts: prompt_owner && prompt_id ? [{ owner: prompt_owner, id: prompt_id, version: prompt_version }] : undefined,
            models: model ? [model] : undefined,
            rated,
            from: since,
            sort,
            limit: limit ?? 50,
          }),
        ),
    );

    server.registerTool(
      "get_run",
      {
        description:
          "Read one run in full: its trigger and template variables (context), what it was set to start with (action: the rule's project, workspace, requested model, preset and limit at the time), the first message (prompt, rendered from its prompt versions and context), the model used, what the thread spent (usage: tokens by kind, estimated costUsd, every model that answered and the Claude Code session ids measured), the PRs linked to its T3 thread, read again from T3 (pullRequests: the PR a review ran on and those the agent opened, with title and open/closed/merged state), the thread's final reply (result) and its rating.",
        inputSchema: { run_id: runId },
        annotations: { readOnlyHint: true },
      },
      ({ run_id }) => result("get_run", Effect.andThen(syncPullRequests(run_id), getRun(run_id))),
    );

    server.registerTool(
      "rate_run",
      {
        description:
          "Rate a run: a written review of how it went, with an optional score from 0 (useless) to 10 (perfect). Set follow_up_of when this run follows up an earlier one, i.e. addresses (fixes) that run's implementation. Rating again replaces the earlier rating, link included. Ratings feed run_analytics, to compare prompt versions and models.",
        inputSchema: {
          run_id: runId,
          feedback: z.string().trim().min(1).describe("Written review: what was good or bad about the run, in Markdown"),
          rating: z.number().int().min(0).max(10).optional().describe("Score from 0 to 10"),
          follow_up_of: z.string().trim().min(1).optional().describe("Id of the earlier run this one follows up (addresses its implementation), from list_runs"),
        },
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      ({ run_id, feedback, rating, follow_up_of }) => result("rate_run", rateRun(run_id, { feedback, rating: rating ?? null, followUpOf: follow_up_of ?? null })),
    );

    server.registerTool(
      "run_analytics",
      {
        description:
          "Run counts by status: overall, per PR author, per trigger source, per prompt version (byPrompt) and per model and reasoning level (byModel; reasoning null means its default), the last two with how many runs were rated, their average rating and average elapsedMs, and how many had usage measured with their total and average estimated cost in USD and average tokens by kind (input, output, cache creation, cache read). Use it to compare prompt versions before promoting one: quality (rating) against cost.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () => result("run_analytics", runAnalytics()),
    );

    server.registerTool(
      "backfill_usage",
      {
        description:
          "Measure the usage (tokens, estimated cost) of settled runs from the last 30 days that have none yet, such as runs from before usage was recorded. Runs in the background, one run at a time, about a second each; returns how many runs it will try (pending) and whether it is running. Read the results with list_runs or run_analytics once it is done. Safe to repeat: a backfill already running is not started twice.",
        inputSchema: {},
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      () => result("backfill_usage", startBackfill()),
    );

    server.registerTool(
      "list_rules",
      {
        description:
          "List the rules: what each fires on (events, reviewer, channel, filters), whether it is enabled, how its threads start (projectId, workspace, model, maxConcurrent) and its live prompt (prompt, livePromptVersion; presetId when a preset's prompt replaces it).",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () => result("list_rules", store.listRules()),
    );

    server.registerTool(
      "create_rule",
      {
        description:
          "Create a rule: it starts a T3 thread with its prompt for each event that matches. Fields left out take the UI's defaults. Returns the rule; change its prompt later with create_prompt_version (owner rule).",
        inputSchema: ruleCreate.shape,
        annotations: { destructiveHint: false },
      },
      (input) => result("create_rule", createRule(input)),
    );

    server.registerTool(
      "update_rule",
      {
        description:
          "Change a rule: only the fields given change, e.g. { enabled: false } to disable it or { filters: { query: \"bug and !wontfix\" } } to change its filter. A raised maxConcurrent starts queued runs. The prompt changes through create_prompt_version (owner rule). Returns the rule.",
        inputSchema: { id: ruleId, ...rulePatch.shape },
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      ({ id, ...patch }) => result("update_rule", updateRule(id, patch)),
    );

    server.registerTool(
      "delete_rule",
      {
        description: "Delete a rule. Its runs and prompt versions stay readable with list_runs and get_run. To stop it for now, update_rule with enabled false instead.",
        inputSchema: { id: ruleId },
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      ({ id }) => result("delete_rule", deleteRule(id)),
    );

    server.registerTool(
      "list_labels",
      {
        description:
          "Labels synced from each inbox source (github, linear, sentry), with the repository or team each belongs to: the names a rule's filters.query expression can use as labels.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () => result("list_labels", poller.labelCatalog),
    );

    return server;
  };

  return async (request: Request): Promise<Response> => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server().connect(transport);
    return transport.handleRequest(request);
  };
});
