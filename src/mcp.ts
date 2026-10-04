import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Cause, Effect, Exit } from "effect";
import { z } from "zod";
import { assertChannelAllowed } from "./channels.ts";
import { errorMessage } from "./errors.ts";
import { logger } from "./log.ts";
import { notifyUser } from "./notify.ts";
import { createVersion, listPrompts, promoteVersion, readPrompt } from "./promptVersions.ts";
import { markMerged, requestReview, requestSecondPass, reviewStatus, type ReviewServices } from "./reviewRequests.ts";
import { PROMPT_OWNERS } from "./shared.ts";
import { SlackClient } from "./slack.ts";

/**
 * MCP tools for other agents: post as the Slack bot, DM the user for their
 * attention (see notify.ts), and send PRs for review with tracked threads and
 * rounds, and mark those threads merged (see reviewRequests.ts), and read and
 * version the prompts rules and dispatches use (see promptVersions.ts).
 * Stateless Streamable HTTP, one server per request;
 * index.ts serves it on loopback. Tool inputs stay zod schemas: that is what
 * the MCP SDK accepts and turns into the JSON Schema it advertises.
 */

const log = logger("mcp");

/** Failures the agent can act on: returned as tool errors without an error log. */
const EXPECTED = new Set(["ReviewRequestError", "NotifyError", "SlackApiError", "ChannelNotAllowedError", "PromptNotFoundError"]);

const prUrl = z.string().describe("GitHub pull request URL, https://github.com/<owner>/<repo>/pull/<number>");
const mentions = z
  .array(z.string())
  .optional()
  .describe("People to tag: Slack user ids (U…), user group ids (S…), or here/channel");
const note = z.string().optional().describe("Extra Markdown shown in the message, e.g. what changed since the last round");
const promptOwner = z.enum(PROMPT_OWNERS).describe("preset: a dispatch preset. rule: a rule's own prompt");
const promptId = z.string().describe("Id of the preset or rule, from list_prompts");

/** A web handler for `/mcp`, bound to the services in scope when it is built. */
export const makeMcpHandler: Effect.Effect<(request: Request) => Promise<Response>, never, ReviewServices> = Effect.gen(function* () {
  const services = yield* Effect.context<ReviewServices>();
  const runPromise = Effect.runPromiseWith(services);
  const slack = yield* SlackClient;

  /** Runs a tool body; errors the agent can act on (bad input, Slack's error code) come back as tool errors, not protocol failures. */
  const result = <A, E>(tool: string, body: Effect.Effect<A, E, ReviewServices>): Promise<CallToolResult> =>
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
    const server = new McpServer({ name: "t3-review", version: "1.0.0" });

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

    return server;
  };

  return async (request: Request): Promise<Response> => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server().connect(transport);
    return transport.handleRequest(request);
  };
});
