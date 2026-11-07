import { describe, expect, test } from "bun:test";
import { formatQuery, highlightQuery, matchesQuery, parseQuery, quoteLabel, quoteValue, termValues, type QuerySubject } from "./filterQuery.ts";

/** Whether `expression` holds for `subject`; a string array is its labels. */
function holds(expression: string, subject: QuerySubject | string[]): boolean {
  const parsed = parseQuery(expression);
  if (!parsed.ok) throw new Error(parsed.error);
  return matchesQuery(parsed.query, Array.isArray(subject) ? { label: subject } : subject);
}

describe("filter expressions", () => {
  test("and binds tighter than or; commas are or; parentheses group", () => {
    expect(holds("bug or p0 and web", ["bug"])).toBe(true);
    expect(holds("(bug or p0) and web", ["bug"])).toBe(false);
    expect(holds("(bug, p0) and web", ["p0", "web"])).toBe(true);
    expect(holds("", [])).toBe(true);
  });

  test("! and not: negate a term or a group", () => {
    expect(holds("bug and !wontfix", ["bug", "wontfix"])).toBe(false);
    expect(holds("bug and not:wontfix", ["bug"])).toBe(true);
    expect(holds("NOT:(bug or p0)", ["web"])).toBe(true);
    expect(holds("!(bug or p0)", ["p0"])).toBe(false);
  });

  test("words run together into one value, quotes keep operators in it, case is ignored", () => {
    expect(holds("Ready For Dev and !blocked", ["ready for dev"])).toBe(true);
    expect(holds('"Bugs and Fixes" or p0', ["bugs and fixes"])).toBe(true);
    expect(holds("state:To Do", { state: ["to do"] })).toBe(true);
    expect(holds('state:"In Review" and team:eng', { state: ["In Review"], team: ["ENG"] })).toBe(true);
  });

  test("key:value terms test their field; unknown prefixes and label: stay labels", () => {
    const issue: QuerySubject = { label: ["priority:high", "state:x"], state: ["Todo", "unstarted"], reason: ["assigned"], has: ["parent"] };
    expect(holds("state:unstarted and reason:assigned and has:parent and !has:sub-issues", issue)).toBe(true);
    expect(holds("priority:high", issue)).toBe(true);
    expect(holds("label:state:x", issue)).toBe(true);
    expect(holds('"state:x"', issue)).toBe(true);
    expect(holds("state:x", issue)).toBe(false);
  });

  test("any: finds text anywhere in any field, whole values or not", () => {
    const issue: QuerySubject = { any: ["Submit I9Form failed", "FOUNTAIN-12"] };
    expect(holds("any:i9", issue)).toBe(true);
    expect(holds('any:"form failed"', issue)).toBe(true);
    expect(holds("!any:i9 and !any:w4", issue)).toBe(false);
    expect(holds("!any:w4", issue)).toBe(true);
    expect(holds("any:w4", {})).toBe(false);
  });

  test("termValues lists a key's values outside negations", () => {
    expect(termValues("(team:ENG or team:OPS) and !team:SRE and bug", "team")).toEqual(["ENG", "OPS"]);
    expect(termValues("bug (", "team")).toEqual([]);
  });

  test("values are quoted only when they would not parse back", () => {
    expect(quoteLabel("Ready For Dev")).toBe("Ready For Dev");
    expect(quoteLabel("Bugs and Fixes")).toBe('"Bugs and Fixes"');
    expect(quoteLabel("size (L)")).toBe('"size (L)"');
    expect(quoteLabel("team:x")).toBe('"team:x"');
    expect(quoteValue("state", "To Do")).toBe("state:To Do");
    expect(quoteValue("state", "Ready or Not")).toBe('state:"Ready or Not"');
  });

  test('\\" is a literal quote inside quotes, and quoting escapes quotes', () => {
    expect(holds('state:"QA \\"Ready\\"" and "say \\"hi\\""', { state: ['QA "Ready"'], label: ['say "hi"'] })).toBe(true);
    expect(quoteValue("state", 'QA "Ready"')).toBe('state:"QA \\"Ready\\""');
    expect(quoteLabel('say "hi"')).toBe('"say \\"hi\\""');
    expect(parseQuery('"open \\"')).toEqual({ ok: false, error: 'Missing closing quote after "open \\".' });
  });

  test("formatQuery writes back an equivalent expression", () => {
    const parsed = parseQuery('NOT:(team:ENG, team:OPS) and (bug or state:"In Review") and !has:parent');
    expect(parsed.ok && formatQuery(parsed.query!)).toBe("!(team:ENG or team:OPS) and (bug or state:In Review) and !has:parent");
  });

  test("errors point at the spot", () => {
    expect(parseQuery("bug or (p0 and")).toEqual({ ok: false, error: 'Expected a term after "( p0 and".' });
    expect(parseQuery("(bug or p0")).toEqual({ ok: false, error: 'Missing ) after "bug or p0".' });
    expect(parseQuery("bug) and p0")).toEqual({ ok: false, error: 'Unexpected ")" after "bug".' });
    expect(parseQuery('"open')).toEqual({ ok: false, error: 'Missing closing quote after "open.' });
    expect(parseQuery("state: and bug")).toEqual({ ok: false, error: 'Expected a value after "state:".' });
    expect(parseQuery("has:children")).toEqual({ ok: false, error: 'has: takes parent or sub-issues, not "children".' });
    expect(parseQuery("reason:assigned to me").ok).toBe(false);
  });

  test("highlighting splits keys, operators and negations, covering every character", () => {
    const text = "!has:parent and (bug, state:Todo)";
    const spans = highlightQuery(text);
    expect(spans.map((span) => span.text).join("")).toBe(text);
    expect(spans.filter((span) => span.kind !== "text").map((span) => `${span.kind}:${span.text}`)).toEqual(["not:!", "key:has:", "op:and", "op:(", "op:,", "key:state:", "op:)"]);
  });
});
