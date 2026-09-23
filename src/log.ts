/**
 * One-line, timestamped service logs, greppable by scope and key:
 *
 *   2026-09-23 10:03:12.345 INFO  [rules] no rule matched delivery=abc event=pull_request.opened why="Review: listens to ..."
 *
 * Timestamps are local time: the service runs on the laptop that reads them.
 * Values containing spaces or quotes are JSON-quoted; undefined fields are
 * dropped; Error values print their message.
 */

type Level = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const WRITERS: Record<Level, (line: string) => void> = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

/** Logger bound to a scope such as `webhook`, `rules`, `slack` or `completion`. */
export function logger(scope: string) {
  const write = (level: Level) => (message: string, fields?: LogFields) =>
    WRITERS[level](formatLine(level, scope, message, fields));
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

export function formatLine(level: Level, scope: string, message: string, fields: LogFields = {}, date = new Date()): string {
  const pairs = Object.entries(fields).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${formatValue(value)}`]));
  return [timestamp(date), level.toUpperCase().padEnd(5), `[${scope}]`, message, ...pairs].join(" ");
}

function formatValue(value: unknown): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return text === "" || /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

function timestamp(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
