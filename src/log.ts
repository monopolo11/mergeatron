/**
 * One-line, timestamped service logs, greppable by scope and key:
 *
 *   2026-09-23 10:03:12.345 INFO  [rules] no rule matched delivery=abc event=pull_request.opened why="Review: listens to ..."
 *
 * Logging goes through Effect's logger: `logger(scope)` returns effects that
 * annotate the entry with the scope and the fields, and `lineLogger` renders
 * the annotations as `key=value` pairs, so a log line carries whatever the
 * surrounding `Effect.annotateLogs` added too (a delivery id, a run id).
 * Timestamps are local time: the service runs on the laptop that reads them.
 * Values containing spaces or quotes are JSON-quoted; undefined fields are
 * dropped; Error values print their message; a cause attached to the entry
 * (`Effect.logError("...", cause)`) prints as `error=`.
 */
import { Cause, Effect, Logger, References, type LogLevel } from "effect";

type Level = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const WRITERS: Record<Level, (line: string) => void> = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

const LEVELS: Partial<Record<LogLevel.LogLevel, Level>> = { Trace: "info", Debug: "info", Info: "info", Warn: "warn", Error: "error", Fatal: "error" };

/** Logger bound to a scope such as `webhook`, `rules`, `slack` or `completion`. Each method returns an effect. */
export function logger(scope: string) {
  const write = (log: (message: string) => Effect.Effect<void>) => (message: string, fields: LogFields = {}) =>
    log(message).pipe(Effect.annotateLogs({ scope, ...fields }));
  return { info: write(Effect.logInfo), warn: write(Effect.logWarning), error: write(Effect.logError) };
}

/** Renders Effect log entries in the one-line format above. */
export const lineLogger = Logger.make<unknown, void>(({ message, logLevel, fiber, date, cause }) => {
  const { scope, ...fields } = fiber.getRef(References.CurrentLogAnnotations);
  const level = LEVELS[logLevel] ?? "info";
  const text = (Array.isArray(message) ? message : [message]).map((part) => (typeof part === "string" ? part : formatValue(part))).join(" ");
  const error = cause.reasons.length > 0 && !Cause.hasInterruptsOnly(cause) ? Cause.squash(cause) : undefined;
  WRITERS[level](formatLine(level, typeof scope === "string" ? scope : "app", text, error === undefined ? fields : { ...fields, error }, date));
});

/** Replaces Effect's default logger with the line format. */
export const loggerLayer = Logger.layer([lineLogger]);

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
