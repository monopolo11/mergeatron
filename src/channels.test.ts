import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { assertChannelAllowed, ChannelNotAllowedError } from "./channels.ts";
import { EMPTY_FILTERS } from "./shared.ts";
import { Store } from "./store.ts";
import { failureOf, runWith, testLayer } from "./testing.ts";

describe("assertChannelAllowed", () => {
  test("allows the review channel and enabled rule channels, nothing else", async () => {
    await runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        const rule = { name: "r", events: ["slack.message"] as string[], reviewer: null, allowBots: false, skipSelfReview: true, filters: EMPTY_FILTERS, maxConcurrent: 0, projectId: null, workspace: "worktree" as const, model: null, prompt: "p", presetId: null };
        yield* store.createRule({ ...rule, enabled: true, channel: "#alerts" });
        yield* store.createRule({ ...rule, enabled: false, channel: "#disabled" });
        yield* store.saveSettings({ ...(yield* store.getSettings()), reviewChannel: "C0REVIEWS" });

        yield* assertChannelAllowed("#alerts");
        yield* assertChannelAllowed("alerts");
        yield* assertChannelAllowed("C0REVIEWS");
        expect(yield* failureOf(assertChannelAllowed("#disabled"))).toBeInstanceOf(ChannelNotAllowedError);
        expect(yield* failureOf(assertChannelAllowed("#random"))).toBeInstanceOf(ChannelNotAllowedError);
      }),
    );
  });

  test("refuses DMs even when the id is configured", async () => {
    await runWith(
      testLayer(),
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveSettings({ ...(yield* store.getSettings()), reviewChannel: "U0BERNARDO" });
        expect((yield* failureOf(assertChannelAllowed("U0BERNARDO"))).message).toContain("notify_user");
        expect((yield* failureOf(assertChannelAllowed("D0123456789"))).message).toContain("notify_user");
      }),
    );
  });
});
