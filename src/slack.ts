import type { WebhookContext } from "./github.ts";
import { logger } from "./log.ts";

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
 * should not start a thread: URL verification, bot posts (including our own
 * replies), edits, joins and other subtyped messages, and plain replies
 * inside a Slack thread (mentions there still count).
 */
export function slackEvent(payload: unknown): SlackEvent | Ignored {
  if (!isRecord(payload) || payload.type !== "event_callback" || !isRecord(payload.event)) {
    return { ignored: `not an event_callback (${isRecord(payload) ? String(payload.type) : typeof payload})` };
  }
  const event = payload.event;
  if (typeof event.type !== "string" || typeof event.channel !== "string" || typeof event.ts !== "string") {
    return { ignored: "event has no type, channel or ts" };
  }
  if (event.bot_id) return { ignored: "posted by a bot" };
  if (event.subtype) return { ignored: `message subtype ${String(event.subtype)}` };
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
  };
}

const PR_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

/** First GitHub PR link in a piece of text. */
export function pullRequestInText(text: string): { repo: string; number: string; url: string } | null {
  const match = PR_URL.exec(text);
  return match ? { repo: match[1]!, number: match[2]!, url: match[0] } : null;
}

/** Rule key for a mention asking for another review inside an existing review thread. */
export const SECOND_PASS_EVENT = "slack.second_pass";
const SECOND_PASS = /\bsecond[- ]pass\b/i;

/**
 * Template variables for a Slack message. The first GitHub PR link in the text
 * sets `repo`, `pr_number` and `pr_url`; `pr_head` and friends come later from
 * GitHub (see pulls.ts) because Slack only knows the URL. A mention saying
 * "second pass" is keyed `slack.second_pass`; its PR is resolved from the
 * thread it was posted in (see secondPass.ts).
 */
export function extractSlackContext(event: SlackEvent): WebhookContext {
  const text = cleanSlackText(event.text ?? "");
  const pr = pullRequestInText(text);
  const ctx: WebhookContext = {
    repo: pr?.repo ?? "",
    event: event.type === "app_mention" && SECOND_PASS.test(text) ? SECOND_PASS_EVENT : `slack.${event.type}`,
    slack_channel: event.channel,
    slack_ts: event.ts,
    slack_text: text,
  };
  if (event.thread_ts && event.thread_ts !== event.ts) ctx.slack_thread_ts = event.thread_ts;
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

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Keeps one Socket Mode connection alive and hands every Events API payload
 * to `onEvent`. Envelopes are acked before the handler runs, so the handler
 * has no deadline; Slack redelivers anything not acked within 3s. Reconnects
 * on Slack's periodic `disconnect`, on errors, and after the laptop wakes up.
 */
export class SlackSocket {
  connected = false;
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = RECONNECT_MIN_MS;

  constructor(
    private readonly appToken: string,
    private readonly onEvent: (payload: unknown) => void,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      url = await this.openUrl();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("connections.open failed", { error: message, retryInSeconds: this.backoffMs / 1000 });
      if (/certificate/i.test(message)) {
        log.warn(
          "TLS-inspecting proxy? Bun reads SSL_CERT_FILE / NODE_EXTRA_CA_CERTS at startup: export the CA bundle in the shell that launches bun, or set it in .env and re-run `bun service.ts install` so launchd gets it.",
        );
      }
      return this.retry();
    }

    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoffMs = RECONNECT_MIN_MS;
      log.info("socket connected");
    };
    ws.onmessage = (event) => {
      const message = socketMessage(String(event.data));
      switch (message.kind) {
        case "hello":
          return;
        case "disconnect":
          log.info("disconnect requested, reconnecting", { reason: message.reason });
          ws.close();
          return;
        case "event":
          ws.send(JSON.stringify({ envelope_id: message.envelopeId }));
          this.onEvent(message.payload);
          return;
        case "other":
          if (message.envelopeId) ws.send(JSON.stringify({ envelope_id: message.envelopeId }));
          return;
      }
    };
    ws.onerror = () => log.warn("socket error");
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.ws = null;
      if (!this.stopped) {
        log.info("socket closed, reconnecting", { code: event.code, retryInSeconds: this.backoffMs / 1000 });
        this.retry();
      }
    };
  }

  private retry(): void {
    if (this.stopped) return;
    setTimeout(() => void this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
  }

  /** `apps.connections.open` needs the app-level token, not the bot token. */
  private async openUrl(): Promise<string> {
    const response = await fetch(`${SLACK_API}/apps.connections.open`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.appToken}` },
    });
    const result = (await response.json()) as { ok: boolean; url?: string; error?: string };
    if (!result.ok || !result.url) throw new Error(result.error ?? String(response.status));
    return result.url;
  }
}

/** Slack renders about 4k characters before folding a message; keep replies readable. */
const REPLY_MAX_CHARS = 12_000;

/** Bot-token Web API client for the handful of calls the orchestrator makes. */
export class SlackClient {
  constructor(private readonly token: string) {}

  /**
   * Adds an emoji reaction to the triggering message. Already-reacted is not
   * an error; an emoji the workspace lacks throws `SlackApiError` `invalid_name`.
   */
  async react(origin: SlackOrigin, name: string): Promise<void> {
    await this.call("reactions.add", { channel: origin.channel, timestamp: origin.ts, name }, ["already_reacted"]);
  }

  async unreact(origin: SlackOrigin, name: string): Promise<void> {
    await this.call("reactions.remove", { channel: origin.channel, timestamp: origin.ts, name }, ["no_reaction"]);
  }

  /** Posts a reply in the triggering message's thread. Markdown is converted to Slack mrkdwn. */
  async reply(origin: SlackOrigin, markdown: string): Promise<void> {
    await this.call("chat.postMessage", {
      channel: origin.channel,
      thread_ts: origin.thread,
      text: toMrkdwn(markdown),
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  private async call<T = unknown>(method: string, body: Record<string, unknown>, ignoreErrors: string[] = []): Promise<T> {
    const response = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { ok: boolean; error?: string } & T;
    if (!result.ok && !ignoreErrors.includes(result.error ?? "")) {
      throw new SlackApiError(method, result.error ?? String(response.status));
    }
    return result;
  }
}

/** A Web API call Slack rejected; `code` is Slack's error string (`invalid_name`, `channel_not_found`, ...). */
export class SlackApiError extends Error {
  constructor(
    method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackApiError";
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
