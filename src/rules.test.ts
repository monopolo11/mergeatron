import { describe, expect, test } from "bun:test";
import { RuleInput } from "./rules.ts";

describe("RuleInput", () => {
  test("an inbox rule polls one source", () => {
    const rule = { name: "r", prompt: "x" };
    expect(RuleInput.safeParse({ ...rule, events: ["inbox.github.pull_request", "inbox.github.issue", "pull_request.opened"] }).success).toBe(true);
    const mixed = RuleInput.safeParse({ ...rule, events: ["inbox.github.pull_request", "inbox.linear.issue"] });
    expect(mixed.error?.issues.map((issue) => issue.path)).toEqual([["events"]]);
  });
});
