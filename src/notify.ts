import { Data, Effect } from "effect";
import { logger } from "./log.ts";
import { SlackClient } from "./slack.ts";
import { Store } from "./store.ts";

const log = logger("mcp");

/** No Slack user to DM; the message tells the agent what the human must set. */
export class NotifyError extends Data.TaggedError("NotifyError")<{ readonly message: string }> {}

/**
 * DMs the Slack user in Settings as the bot, behind the MCP `notify_user`
 * tool: how an agent gets its human's attention. Without `thread` it starts a
 * new DM thread; with the returned `thread_ts` it replies in that thread.
 */
export const notifyUser = Effect.fn("notify.user")(function* (text: string, thread?: string) {
  const store = yield* Store;
  const slack = yield* SlackClient;
  const { slackUserId } = yield* store.getSettings();
  if (!slackUserId) return yield* Effect.fail(new NotifyError({ message: "No one to DM: set your Slack user id in the orchestrator's Settings → Slack and MCP." }));
  // A user id as the channel posts in the bot's DM with that user.
  const posted = yield* slack.post(slackUserId, text, thread);
  const threadTs = thread ?? posted.ts;
  const permalink = yield* slack.permalink(posted.channel, threadTs).pipe(Effect.orElseSucceed(() => null));
  yield* log.info("user notified", { channel: posted.channel, ts: posted.ts, thread: threadTs });
  return { channel: posted.channel, ts: posted.ts, thread_ts: threadTs, permalink };
});
