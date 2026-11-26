/** A variable's name inside `{{ }}`: a word, or a dotted path into a JSON variable such as `payload.user.login`. */
export const VARIABLE_NAME = String.raw`[\w-]+(?:\.[\w-]+)*`;

/**
 * Replaces `{{ name }}` placeholders; unknown names render as empty strings.
 * A dotted name not in `vars` reads its path out of the JSON its first
 * segment holds (see `jsonPath`).
 */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(new RegExp(String.raw`\{\{\s*(${VARIABLE_NAME})\s*\}\}`, "g"), (_, name: string) => vars[name] ?? jsonPath(vars, name) ?? "");
}

/** `payload.items.0.id`: the value at that path in the JSON of `vars.payload`. Strings as is, other values as JSON; undefined when missing. */
function jsonPath(vars: Record<string, string | undefined>, name: string): string | undefined {
  const [root = "", ...path] = name.split(".");
  const json = vars[root];
  if (path.length === 0 || !json) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  for (const key of path) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * The `payload.<path>` variables a custom webhook's JSON schema describes:
 * every property, and the properties of nested objects. An array is one
 * variable, rendered as JSON. Keys a variable name cannot hold are left out.
 */
export function schemaVariables(schema: unknown, prefix = "payload"): string[] {
  const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
  return Object.entries(properties)
    .filter(([key]) => /^[\w-]+$/.test(key))
    .flatMap(([key, child]) => [`${prefix}.${key}`, ...schemaVariables(child, `${prefix}.${key}`)]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * A workflow rule's input: `template` is a JSON object whose strings may hold
 * `{{ name }}` placeholders, rendered one string at a time so a value with
 * quotes or newlines never breaks the JSON. Without `vars` it only checks the
 * template. The error says why the template is not a JSON object.
 */
export function renderJsonTemplate(template: string, vars: Record<string, string | undefined> = {}): { ok: true; value: { [key: string]: JsonValue } } | { ok: false; error: string } {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(template) as JsonValue;
  } catch (error) {
    // Browsers name the line and column ("... at position 60 (line 4 column 2)"); Bun only says what it found.
    const message = error instanceof Error ? error.message : String(error);
    const at = /line (\d+) column (\d+)/.exec(message);
    return { ok: false, error: at ? `Invalid JSON at line ${at[1]}, column ${at[2]}` : `Invalid JSON: ${message.replace(/^JSON Parse error: /, "")}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, error: "The input must be a JSON object, like { \"title\": \"{{pr_title}}\" }." };
  const render = (value: JsonValue): JsonValue =>
    typeof value === "string"
      ? renderTemplate(value, vars)
      : Array.isArray(value)
        ? value.map(render)
        : typeof value === "object" && value !== null
          ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, render(child)]))
          : value;
  return { ok: true, value: Object.fromEntries(Object.entries(parsed).map(([key, child]) => [key, render(child)])) };
}

/** One message from several prompt bodies, in order: how the dispatch dialog stacks presets and how runs rebuild their message. */
export function joinPrompts(bodies: string[]): string {
  return bodies.join("\n\n");
}
