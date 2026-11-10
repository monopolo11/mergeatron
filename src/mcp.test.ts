import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeMcpHandler } from "./mcp.ts";
import { Poller } from "./poller.ts";
import { fakeSlack, runWith, testLayer } from "./testing.ts";

/** Calls one MCP tool through the real handler, as an agent's client would. */
const callTool = (handler: (request: Request) => Promise<Response>, name: string, args: Record<string, unknown>) =>
  handler(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  ).then((response) => response.text());

describe("slack_post_message", () => {
  test("posts to any channel and DMs any user", async () => {
    const posts: { channel: string; text: string }[] = [];
    const slack = fakeSlack({ post: (channel, text) => Effect.sync(() => (posts.push({ channel, text }), { channel, ts: "1.0" })) });
    const layer = Poller.layerWith({ github: null, linear: null, sentry: null }).pipe(Layer.provideMerge(testLayer({ slack })));
    const replies = await runWith(
      layer,
      Effect.gen(function* () {
        const handler = yield* makeMcpHandler;
        return yield* Effect.forEach(["#random", "U0SOMEONE"], (channel) => Effect.promise(() => callTool(handler, "slack_post_message", { channel, text: "hi" })));
      }),
    );
    for (const reply of replies) expect(reply).not.toContain('"isError":true');
    expect(posts).toEqual([
      { channel: "#random", text: "hi" },
      { channel: "U0SOMEONE", text: "hi" },
    ]);
  });
});
