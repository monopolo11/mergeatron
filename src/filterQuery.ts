import { INBOX_REASONS } from "./shared.ts";

/**
 * A rule's filter: one boolean expression over the delivery, such as
 * `reason:assigned and state:"To Do" and (bug or p0) and !has:parent`. Free
 * of server dependencies so the rule editor validates, highlights and
 * previews it too.
 *
 * - Bare words are labels. `key:value` tests another field; see QUERY_KEYS.
 *   Unknown prefixes stay labels (`priority:high`); `label:` forces one.
 *   A `tag:` value is a Sentry tag with its value: `tag:service:checkout`.
 *   `any:i9` holds when any field of the delivery contains the text.
 * - `and`, `or` (or a comma) and parentheses; `and` binds tighter than `or`.
 * - `!term` or `not:term` negates a term; both also negate a group.
 * - Consecutive words form one value (`Ready For Dev`, `state:To Do`); quote
 *   one that holds an operator, a parenthesis or a comma: `"Bugs and Fixes"`.
 *   Inside quotes, `\"` is a literal quote: `state:"QA \"Ready\""`.
 * - Values compare case-insensitively. An empty expression matches anything.
 */

/** What a term tests: `label` for bare words, the rest as `key:value`. */
export const QUERY_KEYS = ["label", "state", "team", "reason", "repo", "tag", "has", "any"] as const;
export type QueryKey = (typeof QUERY_KEYS)[number];

/** The values `has:` takes: whether the issue is a sub-issue, and whether it has sub-issues. */
export const HAS_VALUES = ["parent", "sub-issues"] as const;

export type FilterQuery =
  | { type: "term"; key: QueryKey; value: string }
  | { type: "not"; query: FilterQuery }
  | { type: "and" | "or"; queries: FilterQuery[] };

export type ParsedQuery = { ok: true; query: FilterQuery | null } | { ok: false; error: string };

/** What a delivery offers each key, e.g. `{ label: ["bug"], state: ["Todo", "unstarted"] }`. Missing keys have no values; `any` holds every field's text. */
export type QuerySubject = Partial<Record<QueryKey, string[]>>;

type Token = ({ type: "(" | ")" | "or" | "and" | "not" } | { type: "word"; text: string; quoted: boolean }) & { start: number; end: number };

const KEY_PREFIX = new RegExp(`^(${QUERY_KEYS.join("|")}):`, "i");

/** Parses a filter expression; `query` is null for an empty one. */
export function parseQuery(text: string): ParsedQuery {
  const tokens = tokenize(text);
  if (typeof tokens === "string") return { ok: false, error: tokens };
  if (tokens.length === 0) return { ok: true, query: null };

  let at = 0;
  // The first problem found; parsing stops there.
  let error: string | null = null;
  const peek = () => tokens[at]?.type;
  // The few tokens before the failing one, so errors point at the spot.
  const after = () => (at === 0 ? "at the start" : `after "${tokens.slice(Math.max(0, at - 3), at).map(show).join(" ")}"`);
  const fail = (message: string) => {
    error ??= message;
    return null;
  };

  const parseList = (type: "or" | "and", parseItem: () => FilterQuery | null): FilterQuery | null => {
    const first = parseItem();
    if (!first) return null;
    const queries = [first];
    while (peek() === type) {
      at++;
      const next = parseItem();
      if (!next) return null;
      queries.push(next);
    }
    return queries.length === 1 ? first : { type, queries };
  };
  const parseOr = (): FilterQuery | null => parseList("or", parseAnd);
  const parseAnd = (): FilterQuery | null => parseList("and", parseUnary);
  const parseUnary = (): FilterQuery | null => {
    const token = tokens[at];
    if (token?.type === "not") {
      at++;
      const query = parseUnary();
      return query && { type: "not", query };
    }
    if (token?.type === "(") {
      at++;
      const query = parseOr();
      if (!query) return null;
      if (peek() !== ")") return fail(`Missing ) ${after()}.`);
      at++;
      return query;
    }
    const words: Extract<Token, { type: "word" }>[] = [];
    for (let next = tokens[at]; next?.type === "word"; next = tokens[++at]) words.push(next);
    if (words.length === 0) return fail(token ? `Expected a term ${after()}, found "${show(token)}".` : `Expected a term ${after()}.`);
    return term(words, fail);
  };

  const query = parseOr();
  if (error || !query) return { ok: false, error: error ?? "Invalid filter expression." };
  if (at < tokens.length) return { ok: false, error: `Unexpected "${show(tokens[at]!)}" ${after()}.` };
  return { ok: true, query };
}

/** The term a run of words forms: `key:value` when the first word starts with a known key, else a label. */
function term(words: Extract<Token, { type: "word" }>[], fail: (message: string) => null): FilterQuery | null {
  const first = words[0]!;
  const prefix = first.quoted ? null : KEY_PREFIX.exec(first.text);
  if (!prefix) return { type: "term", key: "label", value: words.map((word) => word.text).join(" ") };
  const key = prefix[1]!.toLowerCase() as QueryKey;
  const value = [first.text.slice(prefix[0].length), ...words.slice(1).map((word) => word.text)].join(" ").trim();
  if (!value) return fail(`Expected a value after "${key}:".`);
  if (key === "has" && !HAS_VALUES.some((known) => known === value.toLowerCase())) return fail(`has: takes ${HAS_VALUES.join(" or ")}, not "${value}".`);
  if (key === "reason" && !INBOX_REASONS.some((known) => known === value.toLowerCase())) return fail(`reason: takes ${INBOX_REASONS.join(", ")}, not "${value}".`);
  return { type: "term", key, value };
}

/** True when `subject` satisfies the query; a null query matches anything. */
export function matchesQuery(query: FilterQuery | null, subject: QuerySubject): boolean {
  const present = Object.fromEntries(Object.entries(subject).map(([key, values]) => [key, new Set(values.map((value) => value.trim().toLowerCase()))]));
  const test = (q: FilterQuery): boolean => {
    switch (q.type) {
      case "term": {
        const value = q.value.toLowerCase();
        if (q.key === "any") return [...(present.any ?? [])].some((text) => text.includes(value));
        return present[q.key]?.has(value) ?? false;
      }
      case "not":
        return !test(q.query);
      case "and":
        return q.queries.every(test);
      case "or":
        return q.queries.some(test);
    }
  };
  return query === null || test(query);
}

/** Values of `key` terms outside negations, e.g. the teams a rule names, for scoping suggestions. Empty for an invalid expression. */
export function termValues(text: string, key: QueryKey): string[] {
  const parsed = parseQuery(text);
  const collect = (q: FilterQuery | null): string[] => {
    if (!q || q.type === "not") return [];
    if (q.type === "term") return q.key === key ? [q.value] : [];
    return q.queries.flatMap(collect);
  };
  return parsed.ok ? collect(parsed.query) : [];
}

/** The query written back as text, quoting values that would not parse back as themselves. */
export function formatQuery(query: FilterQuery): string {
  const inner = (q: FilterQuery, within: "and" | "not") => (q.type === "or" || (within === "not" && q.type === "and") ? `(${formatQuery(q)})` : formatQuery(q));
  switch (query.type) {
    case "term":
      return query.key === "label" ? quoteLabel(query.value) : quoteValue(query.key, query.value);
    case "not":
      return `!${inner(query.query, "not")}`;
    case "and":
      return query.queries.map((q) => inner(q, "and")).join(" and ");
    case "or":
      return query.queries.map(formatQuery).join(" or ");
  }
}

/** A label as it should be typed into an expression: quoted when it would not parse back as itself. */
export function quoteLabel(label: string): string {
  return roundTrips(label, "label", label) ? label : quoted(label);
}

/** A `key:value` term as it should be typed: the value quoted when it would not parse back as itself. */
export function quoteValue(key: Exclude<QueryKey, "label">, value: string): string {
  return roundTrips(`${key}:${value}`, key, value) ? `${key}:${value}` : `${key}:${quoted(value)}`;
}

/** A value in quotes, its own quotes escaped. */
function quoted(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function roundTrips(text: string, key: QueryKey, value: string): boolean {
  const parsed = parseQuery(text);
  return parsed.ok && parsed.query?.type === "term" && parsed.query.key === key && parsed.query.value === value;
}

/** A piece of an expression for syntax highlighting: a key prefix, an operator, a negation, or plain text. */
export type QuerySpan = { text: string; kind: "key" | "op" | "not" | "text" };

/** The expression split into spans covering every character, for highlighting; plain text when it does not tokenize. */
export function highlightQuery(text: string): QuerySpan[] {
  const tokens = tokenize(text);
  if (typeof tokens === "string") return [{ text, kind: "text" }];
  const spans: QuerySpan[] = [];
  let at = 0;
  const push = (end: number, kind: QuerySpan["kind"]) => {
    if (end > at) spans.push({ text: text.slice(at, end), kind });
    at = Math.max(at, end);
  };
  for (const token of tokens) {
    push(token.start, "text");
    if (token.type === "word") {
      const prefix = token.quoted ? null : KEY_PREFIX.exec(token.text);
      if (prefix) push(token.start + prefix[0].length, "key");
      push(token.end, "text");
    } else {
      push(token.end, token.type === "not" ? "not" : "op");
    }
  }
  push(text.length, "text");
  return spans;
}

/** Splits an expression into tokens, or describes why it cannot. */
function tokenize(text: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    const start = i;
    if (/\s/.test(char)) {
      i++;
    } else if (char === "(" || char === ")") {
      tokens.push({ type: char, start, end: ++i });
    } else if (char === ",") {
      tokens.push({ type: "or", start, end: ++i });
    } else if (char === "!") {
      tokens.push({ type: "not", start, end: ++i });
    } else if (char === '"') {
      // The closing quote is the first one not escaped as `\"`.
      const end = /(?<!\\)"/.exec(text.slice(i + 1));
      if (!end) return `Missing closing quote after ${text.slice(i)}.`;
      const value = text.slice(i + 1, i + 1 + end.index).replaceAll('\\"', '"').trim();
      if (!value) return 'Empty value "".';
      i += end.index + 2;
      tokens.push({ type: "word", text: value, quoted: true, start, end: i });
    } else if (text.slice(i, i + 4).toLowerCase() === "not:") {
      i += 4;
      tokens.push({ type: "not", start, end: i });
    } else {
      const word = /^[^\s(),"]+/.exec(text.slice(i))![0];
      const keyword = word.toLowerCase();
      i += word.length;
      tokens.push(keyword === "and" || keyword === "or" ? { type: keyword, start, end: i } : { type: "word", text: word, quoted: false, start, end: i });
    }
  }
  return tokens;
}

function show(token: Token): string {
  return token.type === "word" ? token.text : token.type === "not" ? "!" : token.type;
}
