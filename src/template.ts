/** Replaces `{{ name }}` placeholders; unknown names render as empty strings. */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => vars[name] ?? "");
}

/** One message from several prompt bodies, in order: how the dispatch dialog stacks presets and how runs rebuild their message. */
export function joinPrompts(bodies: string[]): string {
  return bodies.join("\n\n");
}
