/**
 * A rule's label filter: a boolean expression over label names, such as
 * `(bug or p0) and !wontfix`. Free of server dependencies so the rule editor
 * validates and previews it too.
 *
 * - `and`, `or` (or a comma) and parentheses; `and` binds tighter than `or`.
 * - `!label` or `not:label` means the label is absent; both also negate a group.
 * - Consecutive words form one label (`Ready For Dev`); quote a label that
 *   holds an operator, a parenthesis or a comma: `"Bugs and Fixes"`.
 * - Labels compare case-insensitively. An empty expression matches anything.
 */
export type LabelQuery =
  | { type: "label"; name: string }
  | { type: "not"; query: LabelQuery }
  | { type: "and" | "or"; queries: LabelQuery[] };

export type ParsedLabels = { ok: true; query: LabelQuery | null } | { ok: false; error: string };

type Token = { type: "(" | ")" | "or" | "and" | "not" } | { type: "word"; text: string };

/** Parses a label expression; `query` is null for an empty one. */
export function parseLabels(text: string): ParsedLabels {
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

  const parseList = (type: "or" | "and", parseItem: () => LabelQuery | null): LabelQuery | null => {
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
  const parseOr = (): LabelQuery | null => parseList("or", parseAnd);
  const parseAnd = (): LabelQuery | null => parseList("and", parseUnary);
  const parseUnary = (): LabelQuery | null => {
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
    const words: string[] = [];
    for (let next = tokens[at]; next?.type === "word"; next = tokens[++at]) words.push(next.text);
    if (words.length === 0) return fail(token ? `Expected a label ${after()}, found "${show(token)}".` : `Expected a label ${after()}.`);
    return { type: "label", name: words.join(" ") };
  };

  const query = parseOr();
  if (error || !query) return { ok: false, error: error ?? "Invalid label expression." };
  if (at < tokens.length) return { ok: false, error: `Unexpected "${show(tokens[at]!)}" ${after()}.` };
  return { ok: true, query };
}

/** True when `labels` satisfy the query; a null query matches anything. */
export function matchesLabels(query: LabelQuery | null, labels: string[]): boolean {
  const present = new Set(labels.map((label) => label.trim().toLowerCase()));
  const test = (q: LabelQuery): boolean => {
    switch (q.type) {
      case "label":
        return present.has(q.name.toLowerCase());
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

/** A label as it should be typed into an expression: quoted when it would not parse back as itself. */
export function quoteLabel(label: string): string {
  const parsed = parseLabels(label);
  return parsed.ok && parsed.query?.type === "label" && parsed.query.name === label ? label : `"${label}"`;
}

/** Splits an expression into tokens, or describes why it cannot. */
function tokenize(text: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (/\s/.test(char)) {
      i++;
    } else if (char === "(" || char === ")") {
      tokens.push({ type: char });
      i++;
    } else if (char === ",") {
      tokens.push({ type: "or" });
      i++;
    } else if (char === "!") {
      tokens.push({ type: "not" });
      i++;
    } else if (char === '"') {
      const end = text.indexOf('"', i + 1);
      if (end === -1) return `Missing closing quote after ${text.slice(i)}.`;
      const name = text.slice(i + 1, end).trim();
      if (!name) return 'Empty label "".';
      tokens.push({ type: "word", text: name });
      i = end + 1;
    } else if (text.slice(i, i + 4).toLowerCase() === "not:") {
      tokens.push({ type: "not" });
      i += 4;
    } else {
      const word = /^[^\s(),"]+/.exec(text.slice(i))![0];
      const keyword = word.toLowerCase();
      tokens.push(keyword === "and" || keyword === "or" ? { type: keyword } : { type: "word", text: word });
      i += word.length;
    }
  }
  return tokens;
}

function show(token: Token): string {
  return token.type === "word" ? token.text : token.type === "not" ? "!" : token.type;
}
