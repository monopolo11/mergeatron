import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { RuleInput, RunQuery, runScope, RunRatingInput, SettingsInput } from "./rules.ts";
import { DEFAULT_SETTINGS } from "./rules.ts";

describe("RuleInput", () => {
  const decode = Schema.decodeUnknownResult(RuleInput);

  test("fills defaults and trims names", () => {
    const rule = decode({ name: " r ", prompt: "x", events: ["pull_request.opened"], filters: { query: " repo:acme/widgets " } });
    expect(Result.isSuccess(rule) && rule.success).toMatchObject({
      name: "r",
      enabled: true,
      reviewer: null,
      maxConcurrent: 3,
      workspace: "worktree",
      model: null,
      filters: { rerunOnPush: true, query: "repo:acme/widgets" },
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
    const query = decode({ name: "r", prompt: "x", events: ["a"], filters: { query: "(bug or p0" } });
    expect(Result.isFailure(query) && query.failure.message).toContain('Missing ) after "bug or p0"');
  });
});

describe("SettingsInput", () => {
  test("the Sentry limit defaults to 100 and stays within 1 and 1000", () => {
    const decode = Schema.decodeUnknownResult(SettingsInput);
    const { sentryLimit: _, ...saved } = DEFAULT_SETTINGS;
    expect(Result.isSuccess(decode(saved)) && Result.getOrThrow(decode(saved)).sentryLimit).toBe(100);
    expect(Result.isSuccess(decode({ ...DEFAULT_SETTINGS, sentryLimit: 1000 }))).toBe(true);
    expect(Result.isFailure(decode({ ...DEFAULT_SETTINGS, sentryLimit: 0 }))).toBe(true);
    expect(Result.isFailure(decode({ ...DEFAULT_SETTINGS, sentryLimit: 1001 }))).toBe(true);
  });

  test("clears emptied names and strips the @ from the GitHub login and Slack user", () => {
    const settings = Schema.decodeUnknownResult(SettingsInput)({ ...DEFAULT_SETTINGS, githubLogin: " @Bernardo ", reviewChannel: "  ", slackUserId: "<@U0BERNARDO|bernardo>" });
    expect(Result.isSuccess(settings) && settings.success).toMatchObject({ githubLogin: "Bernardo", reviewChannel: null, slackUserId: "U0BERNARDO" });
  });

  test("rejects default reviewers Slack cannot tag", () => {
    const settings = Schema.decodeUnknownResult(SettingsInput)({ ...DEFAULT_SETTINGS, reviewMentions: ["U0ALICE01", "bob@acme.com"] });
    expect(Result.isFailure(settings) && settings.failure.message).toContain('Cannot tag "bob@acme.com"');
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
  test("decodes the limit and splits facet lists into a scope", () => {
    const query = Schema.decodeUnknownResult(RunQuery)({ prompt: "preset:p1:4,rule:r1,bogus:x", source: "slack,fax", live: "1", limit: "500" });
    expect(Result.isSuccess(query) && query.success.limit).toBe(500);
    expect(Result.isSuccess(query) && runScope(query.success)).toMatchObject({
      prompts: [{ owner: "preset", id: "p1", version: 4 }, { owner: "rule", id: "r1", version: undefined }],
      sources: ["slack"],
      livePrompts: true,
    });
    const statuses = Schema.decodeUnknownResult(RunQuery)({ runStatus: "skipped,bogus", notRunStatus: "1" });
    expect(Result.isSuccess(statuses) && runScope(statuses.success)).toMatchObject({ statuses: ["skipped"], notStatuses: true });
    expect(Result.isFailure(Schema.decodeUnknownResult(RunQuery)({ limit: "501" }))).toBe(true);
  });
});
