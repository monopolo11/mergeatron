import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { notifyUser, NotifyError } from "./notify.ts";
import { Store } from "./store.ts";
import { failureOf, fakeSlack, runWith, testLayer } from "./testing.ts";

describe("notifyUser", () => {
  test("starts a DM thread with the Settings user, then replies in it", async () => {
    const posts: { channel: string; text: string; thread?: string }[] = [];
    const slack = fakeSlack({ post: (channel, text, thread) => Effect.sync(() => (posts.push({ channel, text, thread }), { channel: "D1", ts: `${posts.length}.0` })) });
    await runWith(
      testLayer({ slack }),
      Effect.gen(function* () {
        expect(yield* failureOf(notifyUser("hi"))).toBeInstanceOf(NotifyError);

        const store = yield* Store;
        yield* store.saveSettings({ ...(yield* store.getSettings()), slackUserId: "U0BERNARDO" });
        const first = yield* notifyUser("Need a decision");
        expect(first).toMatchObject({ channel: "D1", ts: "1.0", thread_ts: "1.0" });
        const reply = yield* notifyUser("Still waiting", first.thread_ts);
        expect(reply).toMatchObject({ ts: "2.0", thread_ts: "1.0" });
        expect(posts).toEqual([
          { channel: "U0BERNARDO", text: "Need a decision", thread: undefined },
          { channel: "U0BERNARDO", text: "Still waiting", thread: "1.0" },
        ]);
      }),
    );
  });
});
