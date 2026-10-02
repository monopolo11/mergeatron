import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "./log.ts";

const log = logger("server");

/** Startup cannot continue; the message says what to set. */
export class StartupError extends Data.TaggedError("StartupError")<{ readonly message: string }> {}

/**
 * Environment the service runs with, read once at startup through Effect's
 * Config module (Bun loads `.env` into the environment). Tokens are redacted
 * so they never show in logs or error messages. Optional integrations that
 * are half configured are turned off with a warning rather than failing.
 */
export class AppConfig extends Context.Service<AppConfig>()("AppConfig", {
  make: Effect.gen(function* () {
    const t3Token = yield* Config.Redacted("T3_TOKEN").pipe(
      Effect.mapError(() => new StartupError({ message: "T3_TOKEN is required. Issue one with: npx t3 auth session issue --token-only --ttl 365d" })),
    );
    const webhookSecret = yield* Config.Redacted("GITHUB_WEBHOOK_SECRET").pipe(Config.option);
    if (Option.isNone(webhookSecret)) yield* log.warn("GITHUB_WEBHOOK_SECRET is not set: webhook signatures will not be verified.");

    const slackAppToken = yield* Config.Redacted("SLACK_APP_TOKEN").pipe(Config.option);
    const slackBotToken = yield* Config.Redacted("SLACK_BOT_TOKEN").pipe(Config.option);
    const slack = Option.all({ appToken: slackAppToken, botToken: slackBotToken });
    if (Option.isNone(slack) && (Option.isSome(slackAppToken) || Option.isSome(slackBotToken))) {
      yield* log.warn("Slack needs both SLACK_APP_TOKEN and SLACK_BOT_TOKEN; the Slack trigger is disabled.");
    }

    const linearApiKey = yield* Config.Redacted("LINEAR_API_KEY").pipe(Config.option);
    if (Option.isNone(linearApiKey)) yield* log.warn("LINEAR_API_KEY is not set: the inbox polls GitHub only.");

    return {
      t3Token,
      /** `T3_ORIGIN`; otherwise the origin is read from T3's server-runtime.json under `t3Home` (see t3.ts). */
      t3Origin: yield* Config.String("T3_ORIGIN").pipe(Config.option),
      t3Home: yield* Config.String("T3CODE_HOME").pipe(Config.withDefault(join(homedir(), ".t3"))),
      webhookSecret,
      /** Both Slack tokens, or none: Socket Mode needs the app token and the Web API the bot token. */
      slack,
      linearApiKey,
      port: yield* Config.Port("PORT").pipe(Config.withDefault(8787)),
      /** Loopback-only port of the MCP tools, so a tunnel to `port` never exposes them. */
      mcpPort: yield* Config.Port("MCP_PORT").pipe(Config.withDefault(8788)),
      dataPath: yield* Config.String("DATA_PATH").pipe(Config.withDefault("data/orchestrator.sqlite")),
      development: (yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"))) !== "production",
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export const secret = Redacted.value;
