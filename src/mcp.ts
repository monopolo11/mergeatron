import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Cause, Effect, Exit } from "effect";
import { z } from "zod";
import { errorMessage } from "./errors.ts";
import { logger } from "./log.ts";
import { notifyUser } from "./notify.ts";
import { markMerged, requestReview, requestSecondPass, reviewStatus, type ReviewServices } from "./reviewRequests.ts";
import { SlackClient } from "./slack.ts";

/**
 * MCP tools for other agents: post as the Slack bot, DM the user for their
 * attention (see notify.ts), and send PRs for review with tracked threads and
 * rounds, and mark those threads merged (see reviewRequests.ts). Stateless Streamable HTTP, one server per request;
 * index.ts serves it on loopback. Tool inputs stay zod schemas: that is what
 * the MCP SDK accepts and turns into the JSON Schema it advertises.
 */

const log = logger("mcp");

/** Failures the agent can act on: returned as tool errors without an error log. */
const EXPECTED = new Set(["ReviewRequestError", "NotifyError", "SlackApiError"]);

const prUrl = z.string().describe("GitHub pull request URL, https://github.com/<owner>/<repo>/pull/<number>");
const mentions = z
  .array(z.string())
  .optional()
  .describe("People to tag: Slack user ids (U…), user group ids (S…), or here/channel");
const note = z.string().optional().describe("Extra Markdown shown in the message, e.g. what changed since the last round");

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
          "Post a message to Slack as the bot. The bot must be a member of the channel. Returns the message ts; pass it as thread_ts to reply in that thread.",
        inputSchema: {
          channel: z.string().describe("Channel id (C0123...) or #name of a public channel"),
          text: z.string().min(1).describe("Message body in Markdown; raw Slack syntax such as <@U123> passes through"),
          thread_ts: z.string().optional().describe("ts of the parent message to reply in its thread"),
        },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      ({ channel, text, thread_ts }) => result("slack_post_message", slack.post(channel, text, thread_ts)),
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

    return server;
  };

  return async (request: Request): Promise<Response> => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server().connect(transport);
    return transport.handleRequest(request);
  };
});
