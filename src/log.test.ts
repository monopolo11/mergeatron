import { expect, test } from "bun:test";
import { formatLine } from "./log.ts";

test("formatLine prefixes a local timestamp, level and scope, and quotes only values that need it", () => {
  const at = new Date(2026, 8, 23, 9, 5, 7, 42);
  const line = formatLine("warn", "rules", "no rule matched", {
    delivery: "abc",
    pr: undefined,
    why: 'Review: listens to "x"',
    count: 2,
    error: new Error("boom"),
  }, at);
  expect(line).toBe('2026-09-23 09:05:07.042 WARN  [rules] no rule matched delivery=abc why="Review: listens to \\"x\\"" count=2 error=boom');
});
