import { describe, expect, test } from "bun:test";
import { openDatabase } from "./db/index.ts";
import { resolveSecondPassTarget } from "./secondPass.ts";
import { Store } from "./store.ts";

const pr = { repo: "acme/widgets", pr_number: "42", pr_url: "https://github.com/acme/widgets/pull/42" };
const mention = { repo: "", event: "slack.second_pass", slack_channel: "C1", slack_ts: "2.0", slack_thread_ts: "1.0", slack_text: "second pass" };

describe("resolveSecondPassTarget", () => {
  test("takes the PR from the run that started the thread", () => {
    const store = new Store(openDatabase(":memory:"));
    store.recordRun({ ruleId: "r", ruleName: "review", deliveryId: "d", event: "slack.message", repo: pr.repo, status: "done", detail: "", threadId: "t", threadUrl: "u", context: { ...pr, slack_channel: "C1", slack_ts: "1.0" }, result: "first pass" });
    const ctx = { ...mention };
    expect(resolveSecondPassTarget(store, ctx)).toBeNull();
    expect(ctx).toMatchObject(pr);
  });

  test("a PR link in the mention wins, and unknown threads get an explanation", () => {
    const store = new Store(openDatabase(":memory:"));
    const linked = { ...mention, ...pr };
    expect(resolveSecondPassTarget(store, linked)).toBeNull();
    expect(resolveSecondPassTarget(store, { ...mention })).toContain("did not start from a PR review");
    expect(resolveSecondPassTarget(store, { ...mention, slack_thread_ts: undefined })).toContain("inside the review's thread");
  });
});
