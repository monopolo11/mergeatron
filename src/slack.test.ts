import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Fiber, SubscriptionRef } from "effect";
import { FetchHttpClient } from "effect/http";
import { createHash } from "node:crypto";
import { turnOutcome } from "./completion.ts";
import { cleanSlackText, extractSlackContext, runSlackSocket, slackDelivery, slackEvent, slackOrigin, socketMessage, toMrkdwn, type SlackEvent } from "./slack.ts";

const mention = {
  type: "event_callback",
  event_id: "Ev123",
  event: {
    type: "app_mention",
    channel: "C0123",
    user: "U0456",
    text: "<@U0BOT> please review <https://github.com/acme/widgets/pull/42|acme/widgets#42> &amp; be strict",
    ts: "1726670000.000100",
  },
};

describe("socketMessage", () => {
  test("classifies Socket Mode frames", () => {
    expect(socketMessage(JSON.stringify({ type: "hello" }))).toEqual({ kind: "hello" });
    expect(socketMessage(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }))).toEqual({ kind: "disconnect", reason: "refresh_requested" });
    expect(socketMessage(JSON.stringify({ type: "events_api", envelope_id: "e1", payload: mention }))).toEqual({ kind: "event", envelopeId: "e1", payload: mention });
    expect(socketMessage(JSON.stringify({ type: "slash_commands", envelope_id: "e2" }))).toEqual({ kind: "other", envelopeId: "e2" });
    expect(socketMessage("not json")).toEqual({ kind: "other", envelopeId: null });
  });
});

describe("slackEvent", () => {
  test("unwraps event_callback envelopes", () => {
    expect(slackEvent(mention)).toMatchObject({ type: "app_mention" });
  });

  test("ignores verification and subtyped messages, keeps bot posts for the rules to decide", () => {
    expect(slackEvent({ type: "url_verification", challenge: "x" })).toEqual({ ignored: "not an event_callback (url_verification)" });
    expect(slackEvent({ ...mention, event: { ...mention.event, bot_id: "B1", subtype: "bot_message" } })).toMatchObject({ bot_id: "B1" });
    expect(slackEvent({ ...mention, event: { ...mention.event, subtype: "message_changed" } })).toEqual({ ignored: "message subtype message_changed" });
  });

  test("ignores replies inside threads unless the bot is mentioned", () => {
    const reply = { ...mention.event, type: "message", thread_ts: "1726660000.000001" };
    expect(slackEvent({ ...mention, event: reply })).toHaveProperty("ignored");
    expect(slackEvent({ ...mention, event: { ...reply, type: "app_mention" } })).toMatchObject({ type: "app_mention" });
  });
});

describe("extractSlackContext", () => {
  test("finds the PR in the message and keeps the Slack origin", () => {
    const ctx = extractSlackContext(slackEvent(mention) as SlackEvent);
    expect(ctx).toMatchObject({
      repo: "acme/widgets",
      event: "slack.app_mention",
      pr_number: "42",
      pr_url: "https://github.com/acme/widgets/pull/42",
      slack_channel: "C0123",
      slack_ts: "1726670000.000100",
      slack_user: "U0456",
      sender: "U0456",
      slack_text: "please review https://github.com/acme/widgets/pull/42 & be strict",
    });
  });

  test("a 'second pass' mention in a thread is keyed slack.second_pass and remembers the parent", () => {
    const ctx = extractSlackContext({ type: "app_mention", channel: "C1", ts: "2.0", thread_ts: "1.0", text: "<@UBOT> second pass please" });
    expect(ctx).toMatchObject({ event: "slack.second_pass", slack_ts: "2.0", slack_thread_ts: "1.0", repo: "" });
    expect(slackOrigin(ctx)).toEqual({ channel: "C1", ts: "2.0", thread: "1.0" });
    expect(extractSlackContext({ type: "app_mention", channel: "C1", ts: "2.0", text: "<@UBOT> hi" }).event).toBe("slack.app_mention");
  });

  test("leaves repo empty when the message has no PR link", () => {
    const ctx = extractSlackContext({ type: "message", channel: "C1", ts: "1", text: "hello" });
    expect(ctx.repo).toBe("");
    expect(ctx.pr_url).toBeUndefined();
  });

  test("cleanSlackText unwraps bare links too", () => {
    expect(cleanSlackText("see <https://github.com/a/b/pull/1>")).toBe("see https://github.com/a/b/pull/1");
  });
});

describe("slackDelivery", () => {
  test("channel messages need a PR link; mentions always go through", () => {
    const message = (text: string) => ({ ...mention, event: { ...mention.event, type: "message", text } });
    expect(slackDelivery(message("morning all"))).toEqual({ ignored: "channel message has no GitHub PR link" });
    expect(slackDelivery(message("ptal https://github.com/acme/widgets/pull/7"))).toMatchObject({ event: "slack.message" });
    expect(slackDelivery({ ...mention, event: { ...mention.event, text: "<@U0BOT> hi" } })).toMatchObject({ event: "slack.app_mention" });
  });
});

describe("toMrkdwn", () => {
  test("converts headers, bold, links and bullets", () => {
    expect(toMrkdwn("## Findings\n\n- **src/a.ts:3** see [PR](https://x.y/p)")).toBe("*Findings*\n\n• *src/a.ts:3* see <https://x.y/p|PR>");
  });
});

describe("turnOutcome", () => {
  const thread = {
    latestTurn: { turnId: "t1", state: "completed" as const, completedAt: "2026-09-21T00:00:00.000Z", assistantMessageId: "a2" },
    messages: [
      { id: "u1", role: "user" as const, text: "review", turnId: null },
      { id: "a1", role: "assistant" as const, text: "looking", turnId: "t1" },
      { id: "a2", role: "assistant" as const, text: "done: 2 findings", turnId: "t1" },
    ],
    activities: [],
    session: { status: "ready", activeTurnId: null, lastError: null },
  };

  test("returns null while running or before the turn exists", () => {
    expect(turnOutcome({ ...thread, latestTurn: { ...thread.latestTurn, state: "running" } })).toBeNull();
    expect(turnOutcome({ ...thread, latestTurn: null })).toBeNull();
  });

  test("uses the turn's final assistant message", () => {
    expect(turnOutcome(thread)).toEqual({ status: "done", detail: "turn completed", result: "done: 2 findings" });
  });

  test("falls back to the last assistant message of the turn, and reports errors", () => {
    const noPointer = { ...thread, latestTurn: { ...thread.latestTurn, assistantMessageId: null } };
    expect(turnOutcome(noPointer)?.result).toBe("done: 2 findings");
    const errored = { ...thread, latestTurn: { ...thread.latestTurn, state: "error" as const }, session: { ...thread.session, lastError: "provider down" } };
    expect(turnOutcome(errored)).toMatchObject({ status: "failed", detail: "provider down" });
  });
});

describe("SlackSocket heartbeat", () => {
  const HEARTBEAT_MS = 50;
  let cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.toReversed()) await fn();
    cleanup = [];
  });

  /** Points `apps.connections.open` at a local socket URL and runs the Socket Mode loop against it until the test ends. */
  function connectTo(url: string) {
    const openConnection = (async () => Response.json({ ok: true, url })) as unknown as typeof fetch;
    const socket = Effect.gen(function* () {
      const connected = yield* SubscriptionRef.make(false);
      yield* runSlackSocket({ appToken: "xapp-test", onEvent: () => Effect.void, connected, heartbeat: `${HEARTBEAT_MS} millis`, reconnectDelay: "10 millis" });
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, openConnection));
    const fiber = Effect.runFork(socket);
    cleanup.push(() => Effect.runPromise(Fiber.interrupt(fiber)));
  }

  test("reconnects when a socket stops answering pings", async () => {
    // Completes the WebSocket handshake, then goes silent: no pongs, no close.
    let handshakes = 0;
    const zombie = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(conn, chunk) {
          const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(chunk.toString())?.[1];
          if (!key) return;
          handshakes++;
          const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
          conn.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        },
      },
    });
    cleanup.push(() => zombie.stop(true));
    connectTo(`ws://127.0.0.1:${zombie.port}`);

    await waitFor(() => handshakes >= 2);
  });

  test("keeps a socket that answers pings", async () => {
    let upgrades = 0;
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? (upgrades++, undefined) : new Response(null, { status: 400 })),
      websocket: { message() {} },
    });
    cleanup.push(() => server.stop(true));
    connectTo(`ws://127.0.0.1:${server.port}`);

    await Bun.sleep(HEARTBEAT_MS * 5);
    expect(upgrades).toBe(1);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}
