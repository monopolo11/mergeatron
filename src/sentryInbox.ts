import { Context, Duration, Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { AppConfig } from "./config.ts";
import type { InboxLabel, PolledItem } from "./inbox.ts";
import { InboxSourceError, type InboxSourceClient } from "./inboxSource.ts";
import { logger } from "./log.ts";
import { memoSuccess } from "./memo.ts";
import { sentryQuery, type InboxReason, type SentryFilters } from "./shared.ts";
import { Store } from "./store.ts";

const log = logger("sentry");

/**
 * Polls Sentry, sentry.io or a self-hosted instance, for unresolved issues
 * seen in the last 14 days that pass the Sentry filters in Settings:
 * projects, environments and tags. Every issue is `watching`; those assigned
 * to the token's user are `assigned` too. Uses an auth token
 * (`SENTRY_AUTH_TOKEN`) with event:read, org:read and project:read.
 */

/** The instance the inbox polls, as Settings shows it. */
export type SentryInstance = {
  /** Origin without a trailing slash: `https://sentry.io`, a region such as `https://de.sentry.io`, or a self-hosted URL. */
  url: string;
  org: string;
};
export type SentryConfig = SentryInstance & { token: Redacted.Redacted<string> };

/** The fields of an organization issues list entry we read. Older self-hosted versions have no substatus or priority. */
export type SentryIssue = {
  id: string;
  shortId: string;
  title: string;
  culprit: string | null;
  permalink: string;
  level: string;
  status: string;
  substatus?: string | null;
  priority?: string | null;
  count: string;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  project: { slug: string };
  metadata: { type?: string; value?: string };
  assignedTo: { type: string; id: string } | null;
};

type SentryProject = { id: string; slug: string; environments?: string[] };
type SentryUser = { id: string; name?: string; email?: string };

/** Values the Settings filters suggest. Tags are `key:value` for the top values of low-cardinality tags. */
export type SentryOptions = { projects: string[]; environments: string[]; tags: string[] };

/** GET on the instance's `/api/0/`: the JSON body and the cursor of the next page, if any. The live one uses the HttpClient, tests inject fakes. */
export type SentryRequest = <T>(path: string, params?: Record<string, string | string[]>) => Effect.Effect<{ data: T; next: string | null }, InboxSourceError>;

export type SentryInboxShape = InboxSourceClient & {
  readonly instance: SentryInstance;
  /** Projects, their environments and common tags, for the Settings filters. */
  readonly options: Effect.Effect<SentryOptions, InboxSourceError>;
};

/** Issues last seen within this window stay in the inbox. */
const PERIOD = "14d";
/** Event levels, the labels Sentry issues carry. */
const LEVELS = ["fatal", "error", "warning", "info", "debug"];
/** How long the project list and tag suggestions are reused. */
const CACHE = Duration.hours(1);
/** Stops paging a runaway project list; 20 pages is 2000 projects. */
const MAX_PROJECT_PAGES = 20;
/** Tags suggested in Settings: up to this many keys with at most this many values each. */
const TAG_KEYS = 25;
const TAG_VALUES = 100;

const failed = (message: string) => new InboxSourceError({ source: "sentry", message });

export const makeSentryInbox = (instance: SentryInstance, filters: Effect.Effect<SentryFilters>, request: SentryRequest) =>
  Effect.gen(function* () {
    const org = `organizations/${encodeURIComponent(instance.org)}`;

    // The token's user never changes; null for organization tokens, which have none.
    const me = yield* memoSuccess(Effect.map(request<{ user: SentryUser | null }>(""), ({ data }) => data.user));

    const loadProjects = Effect.gen(function* () {
      const projects: SentryProject[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
        const { data, next }: { data: SentryProject[]; next: string | null } = yield* request<SentryProject[]>(
          `${org}/projects/`,
          cursor ? { per_page: "100", cursor } : { per_page: "100" },
        );
        projects.push(...data);
        if (!next) break;
        cursor = next;
      }
      return projects;
    });
    const projects = yield* memoSuccess(loadProjects, CACHE);

    /** Project ids for the slugs. An unknown slug fails the poll rather than widening it to every project. */
    const projectIds = (slugs: string[]) =>
      Effect.gen(function* () {
        if (slugs.length === 0) return [];
        const find = (list: SentryProject[]) => slugs.map((slug) => list.find((project) => project.slug === slug.toLowerCase()));
        let found = find(yield* projects);
        // A project created since the list was cached.
        if (found.includes(undefined)) found = find(yield* loadProjects);
        const missing = slugs.filter((_, index) => !found[index]);
        if (missing.length > 0) return yield* Effect.fail(failed(`no Sentry project ${missing.join(", ")} in ${instance.org}`));
        return found.map((project) => project!.id);
      });

    /** `key:value` for the top values of tags with few values: those make good filters, `url` or `user` do not. */
    const tags = yield* memoSuccess(
      Effect.gen(function* () {
        const scope = { project: "-1", statsPeriod: PERIOD };
        const { data: keys } = yield* request<{ key: string; totalValues?: number }[]>(`${org}/tags/`, scope);
        const wanted = keys.filter((tag) => (tag.totalValues ?? 0) <= TAG_VALUES).slice(0, TAG_KEYS);
        const lists = yield* Effect.forEach(
          wanted,
          ({ key }) =>
            request<{ value: string | null }[]>(`${org}/tags/${encodeURIComponent(key)}/values/`, { ...scope, sort: "-count", per_page: "20" }).pipe(
              Effect.map(({ data }) => data.flatMap((tag) => (tag.value ? [`${key}:${tag.value}`] : []))),
              Effect.catch((error) => log.warn("tag values fetch failed", { key, error: error.message }).pipe(Effect.as([]))),
            ),
          { concurrency: 5 },
        );
        return lists.flat();
      }),
      CACHE,
    );

    const shape: SentryInboxShape = {
      instance,
      fetch: () =>
        Effect.gen(function* () {
          const current = yield* filters;
          const [user, ids] = yield* Effect.all([me, projectIds(current.projects)], { concurrency: "unbounded" });
          const { data } = yield* request<SentryIssue[]>(`${org}/issues/`, {
            query: sentryQuery(current.tags),
            // -1 is every project the token can see; without it Sentry picks the user's own projects.
            project: ids.length > 0 ? ids : ["-1"],
            environment: current.environments,
            statsPeriod: PERIOD,
            sort: "date",
            limit: "100",
            // No `collapse=stats`: it also drops firstSeen, lastSeen, count and userCount, which every item needs.
          });
          return { login: user?.name || user?.email || null, items: data.map((issue) => sentryItem(issue, user?.id ?? null)) };
        }).pipe(Effect.withSpan("sentry.inbox.fetch")),

      /** Sentry has no labels; issues carry their level instead. */
      labels: () => Effect.succeed(LEVELS.map((name): InboxLabel => ({ name, scope: null }))),

      options: Effect.gen(function* () {
        const [list, suggested] = yield* Effect.all([projects, tags], { concurrency: "unbounded" });
        return {
          projects: list.map((project) => project.slug).toSorted(),
          environments: [...new Set(list.flatMap((project) => project.environments ?? []))].toSorted(),
          tags: suggested,
        };
      }).pipe(Effect.withSpan("sentry.inbox.options")),
    };
    return shape;
  });

export function sentryItem(issue: SentryIssue, me: string | null): PolledItem {
  const assigned = me !== null && issue.assignedTo?.type === "user" && String(issue.assignedTo.id) === me;
  const reasons: InboxReason[] = assigned ? ["assigned", "watching"] : ["watching"];
  return {
    key: `sentry:${issue.shortId}`,
    source: "sentry",
    kind: "issue",
    repo: null,
    identifier: issue.shortId,
    title: issue.title,
    url: issue.permalink,
    body: issueBody(issue),
    author: null,
    state: issue.substatus ?? issue.status,
    stateType: issue.status,
    labels: [issue.level],
    reasons,
    team: issue.project.slug,
    priority: issue.priority ?? null,
    branch: null,
    headSha: null,
    base: null,
    reviewDecision: null,
    repoUrl: null,
    defaultBranch: null,
    createdAt: issue.firstSeen,
    updatedAt: issue.lastSeen,
  };
}

/** `{{issue_body}}` for a Sentry issue: the exception, where it was raised, and how often it happens. */
function issueBody(issue: SentryIssue): string {
  const { type, value } = issue.metadata;
  return [
    [type, value].filter(Boolean).join(": "),
    issue.culprit && `in ${issue.culprit}`,
    `${issue.count} events, ${issue.userCount} users, level ${issue.level}, first seen ${issue.firstSeen}, last seen ${issue.lastSeen}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Cursor of the next page from Sentry's `Link` header, when that page has results. */
export function nextCursor(link: string | null): string | null {
  return link?.match(/rel="next"; results="true"; cursor="([^"]+)"/)?.[1] ?? null;
}

/** The live transport over the HttpClient. A self-hosted path prefix (`https://example.com/sentry`) is kept. */
export const sentryTransport = (config: SentryConfig): Effect.Effect<SentryRequest, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client): SentryRequest => (path, params = {}) =>
    Effect.gen(function* () {
      const response = yield* client.execute(
        HttpClientRequest.get(`${config.url}/api/0/${path}`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(config.token)),
          HttpClientRequest.appendUrlParams(Object.entries(params).flatMap(([name, value]) => [value].flat().map((v) => [name, v] as const))),
        ),
      );
      const body = (yield* response.json.pipe(Effect.orElseSucceed(() => null))) as { detail?: string } | null;
      if (response.status < 200 || response.status >= 300 || body === null) {
        return yield* Effect.fail(failed(`Sentry API /api/0/${path} failed: ${body?.detail ?? response.status}`));
      }
      return { data: body, next: nextCursor(response.headers["link"] ?? null) };
    }).pipe(Effect.catchTag("HttpClientError", (error) => Effect.fail(failed(`Sentry API failed: ${error.message}`)))) as never,
  );

/**
 * The Sentry inbox when `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` are set: the
 * poller polls it, Settings asks it for filter suggestions. It reads the
 * filters from the store on every poll.
 */
export class Sentry extends Context.Service<Sentry, Option.Option<SentryInboxShape>>()("Sentry") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const { sentry } = yield* AppConfig;
      if (Option.isNone(sentry)) return Option.none();
      const store = yield* Store;
      const request = yield* sentryTransport(sentry.value);
      const filters = Effect.map(store.getSettings(), (settings) => settings.sentryFilters);
      return Option.some(yield* makeSentryInbox({ url: sentry.value.url, org: sentry.value.org }, filters, request));
    }),
  );
}
