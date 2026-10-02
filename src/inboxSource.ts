import { Data, type Effect } from "effect";
import type { InboxLabel, PolledItem } from "./inbox.ts";
import type { InboxSource } from "./shared.ts";

/** A poll or label sync of one source failed; the message is shown on the inbox status. */
export class InboxSourceError extends Data.TaggedError("InboxSourceError")<{ readonly source: InboxSource; readonly message: string }> {}

export type InboxFetch = { login: string | null; items: PolledItem[] };

/** What a source needs to provide; see GitHubInbox, LinearInbox and SentryInbox. */
export type InboxSourceClient = {
  readonly fetch: () => Effect.Effect<InboxFetch, InboxSourceError>;
  /** Labels its items can carry. GitHub labels live on repositories, so it gets the `owner/name`s to cover. */
  readonly labels: (repos: string[]) => Effect.Effect<InboxLabel[], InboxSourceError>;
};
