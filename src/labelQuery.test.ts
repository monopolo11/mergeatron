import { describe, expect, test } from "bun:test";
import { matchesLabels, parseLabels, quoteLabel } from "./labelQuery.ts";

/** Whether `expression` holds for an item carrying `labels`. */
function holds(expression: string, labels: string[]): boolean {
  const parsed = parseLabels(expression);
  if (!parsed.ok) throw new Error(parsed.error);
  return matchesLabels(parsed.query, labels);
}

describe("label expressions", () => {
  test("and binds tighter than or; commas are or; parentheses group", () => {
    expect(holds("bug or p0 and web", ["bug"])).toBe(true);
    expect(holds("(bug or p0) and web", ["bug"])).toBe(false);
    expect(holds("(bug, p0) and web", ["p0", "web"])).toBe(true);
    expect(holds("", [])).toBe(true);
  });

  test("! and not: negate a label or a group", () => {
    expect(holds("bug and !wontfix", ["bug", "wontfix"])).toBe(false);
    expect(holds("bug and not:wontfix", ["bug"])).toBe(true);
    expect(holds("NOT:(bug or p0)", ["web"])).toBe(true);
    expect(holds("!(bug or p0)", ["p0"])).toBe(false);
  });

  test("words run together into one label, quotes keep operators in it, case is ignored", () => {
    expect(holds("Ready For Dev and !blocked", ["ready for dev"])).toBe(true);
    expect(holds('"Bugs and Fixes" or p0', ["bugs and fixes"])).toBe(true);
    expect(quoteLabel("Ready For Dev")).toBe("Ready For Dev");
    expect(quoteLabel("Bugs and Fixes")).toBe('"Bugs and Fixes"');
    expect(quoteLabel("size (L)")).toBe('"size (L)"');
  });

  test("errors point at the spot", () => {
    expect(parseLabels("bug or (p0 and")).toEqual({ ok: false, error: 'Expected a label after "( p0 and".' });
    expect(parseLabels("(bug or p0")).toEqual({ ok: false, error: 'Missing ) after "bug or p0".' });
    expect(parseLabels("bug) and p0")).toEqual({ ok: false, error: 'Unexpected ")" after "bug".' });
    expect(parseLabels('"open')).toEqual({ ok: false, error: 'Missing closing quote after "open.' });
  });
});
