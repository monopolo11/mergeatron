import type { T3Environment } from "../../src/t3.ts";

export type Status = {
  t3: { origin: string; environment: T3Environment | null };
  webhookSecretConfigured: boolean;
  slack: "off" | "connecting" | "connected";
};

/** JSON fetch wrapper; throws with the server's `error` message on non-2xx. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body as T;
}

/** "just now", "4 min ago", "2 h ago", "3 d ago", or a date for older entries. */
export function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}
