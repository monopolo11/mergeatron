import { Data, Effect } from "effect";
import { sameName } from "./match.ts";
import { Store } from "./store.ts";

/** The channel is not one the orchestrator lets agents post to; the message says what is allowed. */
export class ChannelNotAllowedError extends Data.TaggedError("ChannelNotAllowedError")<{ readonly message: string }> {}

const bare = (channel: string) => channel.trim().replace(/^#/, "");

/** Slack user ids (U…, W…) and DM ids (D…): review requests never go there. */
const isDirectMessage = (channel: string) => /^[UWD][A-Z0-9]{6,}$/.test(bare(channel));

/**
 * Gate for the MCP `request_review` tool: a review request may open only in the
 * review channel in Settings or a channel set on an enabled rule, never a DM.
 * `slack_post_message` and `notify_user` post anywhere and skip it. Compare in
 * the form the channel was saved (`#name` or id): a name is not resolved to an id.
 */
export const assertChannelAllowed = Effect.fn("channels.assertAllowed")(function* (channel: string) {
  if (isDirectMessage(channel)) {
    return yield* Effect.fail(new ChannelNotAllowedError({ message: "Review requests cannot go to a direct message. Use slack_post_message or notify_user to DM someone." }));
  }
  const store = yield* Store;
  const { reviewChannel } = yield* store.getSettings();
  const rules = yield* store.listRules();
  const allowed = [reviewChannel, ...rules.filter((rule) => rule.enabled).map((rule) => rule.channel)].filter((name): name is string => !!name);
  if (allowed.some((name) => sameName(bare(name), bare(channel)))) return;
  const list = allowed.length > 0 ? [...new Set(allowed)].join(", ") : "none configured";
  return yield* Effect.fail(
    new ChannelNotAllowedError({
      message: `Channel ${channel} is not allowed. Agents may post to the review channel in Settings or a channel set on an enabled rule (${list}), written the same way.`,
    }),
  );
});
