import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { RuleInput, SettingsInput } from "./rules.ts";
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
      filters: { rerunOnPush: true, labels: [] },
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
  });
});

describe("SettingsInput", () => {
  test("clears emptied names and strips the @ from the GitHub login", () => {
    const settings = Schema.decodeUnknownResult(SettingsInput)({ ...DEFAULT_SETTINGS, githubLogin: " @Bernardo ", reviewChannel: "  " });
    expect(Result.isSuccess(settings) && settings.success).toMatchObject({ githubLogin: "Bernardo", reviewChannel: null });
  });
});
