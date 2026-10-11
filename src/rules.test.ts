import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { RuleInput, RunQuery, RunRatingInput, SettingsInput } from "./rules.ts";
import { DEFAULT_SETTINGS } from "./rules.ts";

describe("RuleInput", () => {
  const decode = Schema.decodeUnknownResult(RuleInput);

  test("fills defaults and trims names", () => {
    const rule = decode({ name: " r ", prompt: "x", events: ["pull_request.opened"], repos: [" acme/widgets "] });
    expect(Result.isSuccess(rule) && rule.success).toMatchObject({
      name: "r",
      enabled: true,
      repos: ["acme/widgets"],
      reviewer: null,
      maxConcurrent: 3,
      workspace: "worktree",
      model: null,
      filters: { rerunOnPush: true, labels: "" },
    });
  });

  test("an inbox rule polls one source", () => {
    const rule = { name: "r", prompt: "x" };
    expect(Result.isSuccess(decode({ ...rule, events: ["inbox.github.pull_request", "inbox.github.issue", "pull_request.opened"] }))).toBe(true);
    const mixed = decode({ ...rule, events: ["inbox.github.pull_request", "inbox.linear.issue"] });
    expect(Result.isFailure(mixed) && mixed.failure.message).toContain('at ["events"]');
  });

  test("reports the field that is wrong", () => {
    const empty = decode({ name: "", prompt: "x", events: ["a"] });
    expect(Result.isFailure(empty) && empty.failure.message).toContain('at ["name"]');
    const negative = decode({ name: "r", prompt: "x", events: ["a"], maxConcurrent: -1 });
    expect(Result.isFailure(negative) && negative.failure.message).toContain('at ["maxConcurrent"]');
    const labels = decode({ name: "r", prompt: "x", events: ["a"], filters: { labels: "(bug or p0" } });
    expect(Result.isFailure(labels) && labels.failure.message).toContain('Missing ) after "bug or p0"');
  });
});

describe("SettingsInput", () => {
  test("clears emptied names and strips the @ from the GitHub login and Slack user", () => {
    const settings = Schema.decodeUnknownResult(SettingsInput)({ ...DEFAULT_SETTINGS, githubLogin: " @Bernardo ", reviewChannel: "  ", slackUserId: "<@U0BERNARDO|bernardo>" });
    expect(Result.isSuccess(settings) && settings.success).toMatchObject({ githubLogin: "Bernardo", reviewChannel: null, slackUserId: "U0BERNARDO" });
  });
});

describe("RunRatingInput", () => {
  const decode = Schema.decodeUnknownResult(RunRatingInput);

  test("takes a score without feedback, and feedback without a score", () => {
    const scored = decode({ rating: 7 });
    expect(Result.isSuccess(scored) && scored.success).toEqual({ rating: 7, feedback: null, followUpOf: null });
    const written = decode({ feedback: " missed the DST bug " });
    expect(Result.isSuccess(written) && written.success).toEqual({ rating: null, feedback: "missed the DST bug", followUpOf: null });
  });

  test("takes the run it follows up, trimmed", () => {
    const followUp = decode({ rating: 7, followUpOf: " run-1 " });
    expect(Result.isSuccess(followUp) && followUp.success).toMatchObject({ followUpOf: "run-1" });
  });

  test("needs one of them, and a score from 0 to 10", () => {
    const blank = decode({ rating: null, feedback: "  " });
    expect(Result.isFailure(blank) && blank.failure.message).toContain("Give a score, feedback or both.");
    expect(Result.isFailure(decode({ rating: 11 }))).toBe(true);
    expect(Result.isFailure(decode({ rating: 7.5 }))).toBe(true);
  });
});

describe("RunQuery", () => {
  test("decodes numbers from search params", () => {
    const query = Schema.decodeUnknownResult(RunQuery)({ promptOwner: "preset", promptId: "p1", promptVersion: "4", limit: "500" });
    expect(Result.isSuccess(query) && query.success).toEqual({ promptOwner: "preset", promptId: "p1", promptVersion: 4, limit: 500 });
    expect(Result.isFailure(Schema.decodeUnknownResult(RunQuery)({ limit: "501" }))).toBe(true);
  });
});
