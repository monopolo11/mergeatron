/** Replaces `{{ name }}` placeholders; unknown names render as empty strings. */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => vars[name] ?? "");
}
