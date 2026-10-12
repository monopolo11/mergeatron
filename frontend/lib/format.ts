/** `$0.85`, or `$0.8549` with `precise`; under a cent shows `<$0.01`. */
export function usd(value: number, precise = false): string {
  if (precise) return `$${value.toFixed(4)}`;
  return value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

/** Token counts at a glance: `940`, `9.8k`, `672k`, `3.28M`. */
export function tokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 100_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** How long until a time: `now`, `in 3m`, `in 2h`. */
export function timeUntil(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes < 1) return "now";
  return minutes < 60 ? `in ${minutes}m` : `in ${Math.round(minutes / 60)}h`;
}
