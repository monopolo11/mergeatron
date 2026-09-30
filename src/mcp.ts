import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "./log.ts";
import { requestReview, requestSecondPass, ReviewRequestError, reviewStatus, type ReviewDeps } from "./reviewRequests.ts";
import { SlackApiError } from "./slack.ts";

/**
 * MCP tools for other agents: post as the Slack bot, and send PRs for review
 * with tracked threads and rounds (see reviewRequests.ts). Stateless
 * Streamable HTTP, one server per request; index.ts serves it on loopback.
 */

const log = logger("mcp");

const prUrl = z.string().describe("GitHub pull request URL, https://github.com/<owner>/<repo>/pull/<number>");
const mentions = z
  .array(z.string())
  .optional()
  .describe("People to tag: Slack user ids (U…), user group ids (S…), or here/channel");
const note = z.string().optional().describe("Extra Markdown shown in the message, e.g. what changed since the last round");

export async function handleMcpRequest(deps: ReviewDeps, request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcpServer(deps).connect(transport);
  return transport.handleRequest(request);
}

function mcpServer(deps: ReviewDeps): McpServer {
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
    ({ channel, text, thread_ts }) => result("slack_post_message", () => deps.slack.post(channel, text, thread_ts)),
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
    ({ pr_url, channel, mentions, note }) => result("request_review", () => requestReview(deps, { prUrl: pr_url, channel, mentions, note })),
  );

  server.registerTool(
    "request_second_pass",
    {
      description:
        "Ask for another review of a PR sent with request_review, e.g. after pushing fixes. Replies in its Slack thread, starts the next round, and re-runs the automated review, even when the PR's reviews are paused.",
      inputSchema: { pr_url: prUrl, mentions, note },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    ({ pr_url, mentions, note }) => result("request_second_pass", () => requestSecondPass(deps, { prUrl: pr_url, mentions, note })),
  );

  server.registerTool(
    "review_status",
    {
      description:
        "Where a PR's review stands: its Slack thread and round, status (reviewing, approved, changes_requested, commented, paused, ...), and the latest automated review's full reply to act on.",
      inputSchema: { pr_url: prUrl },
      annotations: { readOnlyHint: true },
    },
    async ({ pr_url }) => result("review_status", () => reviewStatus(deps.store, pr_url)),
  );

  return server;
}

/** Runs a tool body; errors the agent can act on (bad input, Slack's error code) come back as tool errors, not protocol failures. */
async function result(tool: string, run: () => unknown): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await run(), null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof ReviewRequestError || error instanceof SlackApiError)) log.error("tool failed", { tool, error: message });
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}
