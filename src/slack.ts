import { Context, Data, Deferred, Duration, Effect, Exit, Layer, Option, Queue, Redacted, Schedule, SubscriptionRef } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { AppConfig } from "./config.ts";
import type { WebhookContext } from "./github.ts";
import { logger } from "./log.ts";
import { memoSuccess } from "./memo.ts";

/**
 * Slack side of the orchestrator: Socket Mode connection and event parsing on
 * the way in, reactions and threaded replies on the way out.
 *
 * Socket Mode means Slack pushes events over a WebSocket we open, so the
 * laptop needs no public URL for Slack. Two tokens: an app-level token
 * (`xapp-`, scope `connections:write`) opens the socket; the bot token
 * (`xoxb-`) makes Web API calls. See slack-app-manifest.yaml for scopes.
 */

const SLACK_API = "https://slack.com/api";

const log = logger("slack");

/** An event that should not start anything, and why. Logged so a silent bot can be explained. */
export type Ignored = { ignored: string };

/** The parts of an Events API `event_callback` we read. */
export type SlackEvent = {
  type: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
};

/**
 * Pulls the inner event out of an Events API envelope. Ignores anything that
 * should not start a thread: URL verification, edits, joins and other
 * subtyped messages, and plain replies inside a Slack thread (mentions there
 * still count), which covers our own review replies. Top-level bot posts
 * come through with `bot_id`; secondPass.ts decides whether a rule wants them.
 */
export function slackEvent(payload: unknown): SlackEvent | Ignored {
  if (!isRecord(payload) || payload.type !== "event_callback" || !isRecord(payload.event)) {
    return { ignored: `not an event_callback (${isRecord(payload) ? String(payload.type) : typeof payload})` };
  }
  const event = payload.event;
  if (typeof event.type !== "string" || typeof event.channel !== "string" || typeof event.ts !== "string") {
    return { ignored: "event has no type, channel or ts" };
  }
  if (event.subtype && event.subtype !== "bot_message") return { ignored: `message subtype ${String(event.subtype)}` };
  if (event.type === "message" && typeof event.thread_ts === "string" && event.thread_ts !== event.ts) {
    return { ignored: "plain reply inside a Slack thread; mention the bot there instead" };
  }
  return {
    type: event.type,
    channel: event.channel,
    user: typeof event.user === "string" ? event.user : undefined,
    text: typeof event.text === "string" ? event.text : undefined,
    ts: event.ts,
    thread_ts: typeof event.thread_ts === "string" ? event.thread_ts : undefined,
    bot_id: typeof event.bot_id === "string" ? event.bot_id : undefined,
  };
}

const PR_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

/** First GitHub PR link in a piece of text. */
export function pullRequestInText(text: string): { repo: string; number: string; url: string } | null {
  const match = PR_URL.exec(text);
  return match ? { repo: match[1]!, number: match[2]!, url: match[0] } : null;
}

/**
 * Rule key for a mention asking for another review inside an existing review
 * thread. Every later round ("second pass", "third pass", "4th pass", "next
 * pass", "another pass"...) uses it, so one rule serves them all.
 */
export const SECOND_PASS_EVENT = "slack.second_pass";
const LATER_PASS = /\b(?:next|another|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|(?:[2-9]|10)(?:nd|rd|th))[- ]pass\b/i;

/**
 * Template variables for a Slack message. The first GitHub PR link in the text
 * sets `repo`, `pr_number` and `pr_url`; `pr_head` and friends come later from
 * GitHub (see pulls.ts) because Slack only knows the URL. A mention saying
 * "second pass" (or third, next, another...) is keyed `slack.second_pass`; its PR is resolved from the
 * thread it was posted in (see secondPass.ts).
 */
export function extractSlackContext(event: SlackEvent): WebhookContext {
  const text = cleanSlackText(event.text ?? "");
  const pr = pullRequestInText(text);
  const ctx: WebhookContext = {
    repo: pr?.repo ?? "",
    event: event.type === "app_mention" && LATER_PASS.test(text) ? SECOND_PASS_EVENT : `slack.${event.type}`,
    slack_channel: event.channel,
    slack_ts: event.ts,
    slack_text: text,
  };
  if (event.thread_ts && event.thread_ts !== event.ts) ctx.slack_thread_ts = event.thread_ts;
  if (event.bot_id) ctx.slack_bot_id = event.bot_id;
  if (event.user) {
    ctx.slack_user = event.user;
    ctx.sender = event.user;
  }
  if (pr) {
    ctx.pr_url = pr.url;
    ctx.pr_number = pr.number;
  }
  return ctx;
}

/** Strips `<@U123>` mentions, unwraps `<url|label>` links and decodes Slack's HTML escapes. */
export function cleanSlackText(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, "")
    .replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reduces an Events API payload to a rule key and template variables, or the
 * reason nothing should start. A channel message only counts as a review
 * request when it links a GitHub PR; a mention always reaches the rules so
 * the bot can say why it did nothing.
 */
export function slackDelivery(payload: unknown): { event: string; ctx: WebhookContext } | Ignored {
  const event = slackEvent(payload);
  if ("ignored" in event) return event;
  const ctx = extractSlackContext(event);
  if (event.type === "message" && !ctx.pr_url) return { ignored: "channel message has no GitHub PR link" };
  return { event: ctx.event!, ctx };
}

/**
 * Where a run came from in Slack, when it did; GitHub runs have none. `ts` is
 * the triggering message (reactions go there); `thread` is where replies go:
 * the parent when the trigger was itself a thread reply.
 */
export type SlackOrigin = { channel: string; ts: string; thread: string };
export function slackOrigin(ctx: Record<string, string | undefined> | null): SlackOrigin | null {
  if (!ctx?.slack_channel || !ctx.slack_ts) return null;
  return { channel: ctx.slack_channel, ts: ctx.slack_ts, thread: ctx.slack_thread_ts ?? ctx.slack_ts };
}

/** Messages Slack sends over a Socket Mode connection, reduced to what we act on. */
export type SocketMessage =
  | { kind: "hello" }
  | { kind: "disconnect"; reason: string }
  | { kind: "event"; envelopeId: string; payload: unknown }
  | { kind: "other"; envelopeId: string | null };

/** Parses one raw Socket Mode frame. Anything unrecognised is `other` and only acked. */
export function socketMessage(raw: string): SocketMessage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "other", envelopeId: null };
  }
  if (!isRecord(data)) return { kind: "other", envelopeId: null };
  const envelopeId = typeof data.envelope_id === "string" ? data.envelope_id : null;
  if (data.type === "hello") return { kind: "hello" };
  if (data.type === "disconnect") return { kind: "disconnect", reason: typeof data.reason === "string" ? data.reason : "unknown" };
  if (data.type === "events_api" && envelopeId) return { kind: "event", envelopeId, payload: data.payload };
  return { kind: "other", envelopeId };
}

/** A Web API call Slack rejected; `code` is Slack's error string (`invalid_name`, `channel_not_found`, ...). */
export class SlackApiError extends Data.TaggedError("SlackApiError")<{ readonly method: string; readonly code: string }> {
  override get message(): string {
    return `Slack ${this.method} failed: ${this.code}`;
  }
}

/** Slack renders about 4k characters before folding a message; keep replies readable. */
const REPLY_MAX_CHARS = 12_000;

/** Bot-token Web API client for the handful of calls the orchestrator makes. */
export type SlackClientShape = {
  /** Adds an emoji reaction to the triggering message. Already-reacted is not an error; an emoji the workspace lacks fails with `invalid_name`. */
  readonly react: (origin: SlackOrigin, name: string) => Effect.Effect<void, SlackApiError>;
  readonly unreact: (origin: SlackOrigin, name: string) => Effect.Effect<void, SlackApiError>;
  /** Posts a reply in the triggering message's thread. Markdown is converted to Slack mrkdwn. */
  readonly reply: (origin: SlackOrigin, markdown: string) => Effect.Effect<void, SlackApiError>;
  /**
   * Posts to a channel (ID, or `#name` for public channels the bot is in), in
   * `thread` when given. Returns the channel id and the message's `ts`, which
   * doubles as its thread id.
   */
  readonly post: (channel: string, markdown: string, thread?: string) => Effect.Effect<{ channel: string; ts: string }, SlackApiError>;
  /** This app's bot id (`auth.test`), to tell our own posts from other bots'. Cached once it succeeds. */
  readonly botId: Effect.Effect<string, SlackApiError>;
  /** Link to a message, for agents to hand to their user. */
  readonly permalink: (channel: string, ts: string) => Effect.Effect<string, SlackApiError>;
};

/** Builds the Web API client for a bot token. Needs an `HttpClient`. */
export const makeSlackClient = Effect.fn("SlackClient.make")(function* (token: string) {
  const client = yield* HttpClient.HttpClient;

  /**
   * Form-encoded rather than JSON: read methods such as `chat.getPermalink`
   * ignore JSON bodies, and every method accepts form params.
   */
  const call = <T = unknown>(method: string, body: Record<string, string | boolean | undefined>, ignoreErrors: string[] = []): Effect.Effect<T, SlackApiError> =>
    Effect.gen(function* () {
      const params = Object.fromEntries(Object.entries(body).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])));
      const response = yield* client.execute(
        HttpClientRequest.post(`${SLACK_API}/${method}`).pipe(HttpClientRequest.bearerToken(token), HttpClientRequest.bodyUrlParams(params)),
      );
      const result = (yield* response.json) as { ok: boolean; error?: string } & T;
      if (!result.ok && !ignoreErrors.includes(result.error ?? "")) {
        return yield* Effect.fail(new SlackApiError({ method, code: result.error ?? String(response.status) }));
      }
      return result;
    }).pipe(
      Effect.catchTag("HttpClientError", (error) => Effect.fail(new SlackApiError({ method, code: `request failed: ${error.message}` }))),
      Effect.withSpan("slack.call", { attributes: { method } }),
    );

  const post: SlackClientShape["post"] = (channel, markdown, thread) =>
    Effect.map(
      call<{ channel: string; ts: string }>("chat.postMessage", {
        channel,
        thread_ts: thread,
        text: toMrkdwn(markdown),
        unfurl_links: false,
        unfurl_media: false,
      }),
      ({ channel, ts }) => ({ channel, ts }),
    );

  const botId = yield* memoSuccess(Effect.map(call<{ bot_id: string }>("auth.test", {}), ({ bot_id }) => bot_id));

  const shape: SlackClientShape = {
    react: (origin, name) => Effect.asVoid(call("reactions.add", { channel: origin.channel, timestamp: origin.ts, name }, ["already_reacted"])),
    unreact: (origin, name) => Effect.asVoid(call("reactions.remove", { channel: origin.channel, timestamp: origin.ts, name }, ["no_reaction"])),
    reply: (origin, markdown) => Effect.asVoid(post(origin.channel, markdown, origin.thread)),
    post,
    botId,
    permalink: (channel, ts) => Effect.map(call<{ permalink: string }>("chat.getPermalink", { channel, message_ts: ts }), ({ permalink }) => permalink),
  };
  return shape;
});

const notConfigured = (method: string) => Effect.fail(new SlackApiError({ method, code: "slack_not_configured" }));

export class SlackClient extends Context.Service<SlackClient, SlackClientShape>()("SlackClient") {
  /**
   * Without Slack tokens, reactions and replies are skipped quietly: only
   * Slack-triggered runs make them, and there are none. Posting on behalf of
   * agents fails with `slack_not_configured`.
   */
  static readonly disabled: SlackClientShape = {
    react: () => Effect.void,
    unreact: () => Effect.void,
    reply: () => Effect.void,
    post: () => notConfigured("chat.postMessage"),
    botId: notConfigured("auth.test"),
    permalink: () => notConfigured("chat.getPermalink"),
  };

  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const { slack } = yield* AppConfig;
      return Option.isSome(slack) ? yield* makeSlackClient(Redacted.value(slack.value.botToken)) : SlackClient.disabled;
    }),
  );
}

/** Good-enough Markdown to Slack mrkdwn: bold, headers, links, fenced code left as is. */
export function toMrkdwn(markdown: string): string {
  const text = markdown
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ");
  return text.length > REPLY_MAX_CHARS ? `${text.slice(0, REPLY_MAX_CHARS)}\n\n_(truncated; full reply in the T3 thread)_` : text;
}

const RECONNECT_MIN = Duration.seconds(1);
const RECONNECT_MAX = Duration.seconds(30);
/** How often we ping Slack; a ping still unanswered at the next tick means the socket is dead. */
const HEARTBEAT = Duration.seconds(30);

/** Bun's client WebSocket. The DOM lib (loaded for the frontend) hides `ping` and `terminate` on the global type. */
type SlackWebSocket = WebSocket & Pick<Bun.WebSocket, "ping" | "terminate">;

/** The socket could not be opened: `apps.connections.open` failed or the handshake did not complete. */
class SlackSocketError extends Data.TaggedError("SlackSocketError")<{ readonly message: string }> {}

export type SlackSocketOptions = {
  readonly appToken: string;
  /** Runs for every Events API payload, in its own fiber; it must handle its own errors. */
  readonly onEvent: (payload: unknown) => Effect.Effect<void>;
  /** Flipped while a socket is open, for the status endpoint. */
  readonly connected: SubscriptionRef.SubscriptionRef<boolean>;
  readonly heartbeat?: Duration.Input;
  /** Pause before dialing again after a connected socket closed; opening failures back off exponentially instead. */
  readonly reconnectDelay?: Duration.Input;
};

/**
 * Keeps one Socket Mode connection alive and hands every Events API payload
 * to `onEvent`. Envelopes are acked before the handler runs, so the handler
 * has no deadline; Slack redelivers anything not acked within 3s. Reconnects
 * on Slack's periodic `disconnect`, on errors, and after the laptop wakes up:
 * a closed socket is dialed again after `reconnectDelay`, and a socket that
 * cannot be opened is retried with exponential backoff (1s doubling to 30s,
 * jittered), reset once a connection succeeds.
 *
 * A heartbeat catches sockets that die without a close (a VPN or WARP tunnel
 * re-routing, say): the OS keeps reporting the TCP connection as open and
 * events silently stop arriving. Every `heartbeat` we ping; if the previous
 * ping got no pong, the socket is terminated and the usual reconnect runs.
 *
 * Never returns; run it in a scoped fiber and close the scope to stop.
 */
export const runSlackSocket = (options: SlackSocketOptions): Effect.Effect<never, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const heartbeat = Duration.fromInputUnsafe(options.heartbeat ?? HEARTBEAT);

    /** `apps.connections.open` needs the app-level token, not the bot token. */
    const openUrl = Effect.gen(function* () {
      const response = yield* client.execute(HttpClientRequest.post(`${SLACK_API}/apps.connections.open`).pipe(HttpClientRequest.bearerToken(options.appToken)));
      const result = (yield* response.json) as { ok: boolean; url?: string; error?: string };
      if (!result.ok || !result.url) return yield* Effect.fail(new SlackSocketError({ message: result.error ?? String(response.status) }));
      return result.url;
    }).pipe(Effect.catchTag("HttpClientError", (error) => Effect.fail(new SlackSocketError({ message: error.message }))));

    /** One connection, from dial to close. Fails only when the socket never opened. */
    const connectOnce = Effect.gen(function* () {
      const url = yield* openUrl;
      const frames = yield* Queue.unbounded<string>();
      const opened = yield* Deferred.make<void, SlackSocketError>();
      const closed = yield* Deferred.make<number>();
      let awaitingPong = false;

      const ws = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const ws = new WebSocket(url) as SlackWebSocket;
          ws.addEventListener("pong", () => (awaitingPong = false));
          ws.onopen = () => Deferred.doneUnsafe(opened, Exit.void);
          ws.onmessage = (event) => Queue.offerUnsafe(frames, String(event.data));
          ws.onerror = () => Deferred.doneUnsafe(opened, Exit.fail(new SlackSocketError({ message: "websocket error" })));
          ws.onclose = (event) => {
            Deferred.doneUnsafe(opened, Exit.fail(new SlackSocketError({ message: `socket closed (${event.code}) before it opened` })));
            Deferred.doneUnsafe(closed, Exit.succeed(event.code));
          };
          return ws;
        }),
        (ws) => Effect.sync(() => ws.close()),
      );
      yield* Deferred.await(opened);
      yield* SubscriptionRef.set(options.connected, true);
      yield* Effect.addFinalizer(() => SubscriptionRef.set(options.connected, false));
      yield* log.info("socket connected");

      const ping = Effect.gen(function* () {
        if (awaitingPong) {
          yield* log.warn("no pong from Slack, reconnecting", { waitedSeconds: Duration.toSeconds(heartbeat) });
          ws.terminate();
          return;
        }
        awaitingPong = true;
        ws.ping();
      });
      yield* Effect.forkScoped(Effect.repeat(ping, { schedule: Schedule.spaced(heartbeat) }));

      const ack = (envelopeId: string) => ws.send(JSON.stringify({ envelope_id: envelopeId }));
      const handle = Effect.gen(function* () {
        for (;;) {
          const message = socketMessage(yield* Queue.take(frames));
          switch (message.kind) {
            case "hello":
              break;
            case "disconnect":
              yield* log.info("disconnect requested, reconnecting", { reason: message.reason });
              ws.close();
              break;
            case "event":
              ack(message.envelopeId);
              yield* Effect.forkScoped(options.onEvent(message.payload));
              break;
            case "other":
              if (message.envelopeId) ack(message.envelopeId);
              break;
          }
        }
      });
      const code = yield* Effect.race(handle, Deferred.await(closed));
      yield* log.info("socket closed, reconnecting", { code });
    }).pipe(Effect.scoped);

    const backoff = Schedule.min([Schedule.exponential(RECONNECT_MIN).pipe(Schedule.jittered), Schedule.spaced(RECONNECT_MAX)]);
    const dial = connectOnce.pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          yield* log.warn("connections.open failed", { error: error.message });
          if (/certificate/i.test(error.message)) {
            yield* log.warn(
              "TLS-inspecting proxy? Bun reads SSL_CERT_FILE / NODE_EXTRA_CA_CERTS at startup: export the CA bundle in the shell that launches bun, or set it in .env and re-run `bun service.ts install` so launchd gets it.",
            );
          }
        }),
      ),
      // The backoff never gives up, so the error channel is empty in practice.
      Effect.retry({ schedule: backoff }),
      Effect.orDie,
    );
    return yield* dial.pipe(Effect.repeat({ schedule: Schedule.spaced(options.reconnectDelay ?? RECONNECT_MIN) }), Effect.andThen(Effect.never));
  });

export type SlackSocketStatus = "off" | "connecting" | "connected";

/** Status of the Socket Mode connection, for the header: `off` without Slack tokens. */
export class SlackSocket extends Context.Service<SlackSocket, { readonly status: Effect.Effect<SlackSocketStatus> }>()("SlackSocket") {
  static readonly off = Layer.succeed(this, { status: Effect.succeed("off" as const) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
