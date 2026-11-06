import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { InboxSourceError } from "./inboxSource.ts";
import { makeSentryInbox, nextCursor, type SentryIssue, type SentryRequest } from "./sentryInbox.ts";
import { DEFAULT_SENTRY_LIMIT, EMPTY_SENTRY_FILTERS, sentryQuery, type SentryFilters } from "./shared.ts";
import { failureOf } from "./testing.ts";

const issue = (patch: Partial<SentryIssue>): SentryIssue => ({
  id: "101",
  shortId: "CHECKOUT-3F",
  title: "TypeError: cart is undefined",
  culprit: "app/cart.ts in total",
  permalink: "https://sentry.acme.dev/organizations/acme/issues/101/",
  level: "error",
  status: "unresolved",
  substatus: "escalating",
  priority: "high",
  count: "42",
  userCount: 7,
  firstSeen: "2026-10-01T10:00:00Z",
  lastSeen: "2026-10-02T10:00:00Z",
  project: { slug: "checkout" },
  metadata: { type: "TypeError", value: "cart is undefined" },
  assignedTo: null,
  ...patch,
});

const projects = [
  { id: "1", slug: "checkout", environments: ["production", "staging"] },
  { id: "2", slug: "billing", environments: ["production"] },
];

const TAGS = /^organizations\/acme\/issues\/\d+\/tags\/$/;

/** A Sentry that answers by path and records every request; issues have no tags unless a route says so, and an unknown path fails like the API would. */
function fake(routes: Record<string, (params: Record<string, string | string[]>) => unknown>) {
  const calls: { path: string; params: Record<string, string | string[]> }[] = [];
  const request: SentryRequest = (path, params = {}) =>
    Effect.suspend(() => {
      calls.push({ path, params });
      const route = routes[path] ?? (TAGS.test(path) ? () => [] : undefined);
      return route ? Effect.succeed({ data: route(params) as never, next: null }) : Effect.fail(new InboxSourceError({ source: "sentry", message: `unexpected ${path}` }));
    });
  return { calls, request };
}

const inboxWith = (sentryFilters: SentryFilters, request: SentryRequest, sentryLimit = DEFAULT_SENTRY_LIMIT) =>
  makeSentryInbox({ url: "https://sentry.acme.dev", org: "acme" }, Effect.succeed({ sentryFilters, sentryLimit }), request);

describe("sentryQuery", () => {
  test("values of one key match any, keys all match, free text and Sentry syntax pass as typed", () => {
    expect(sentryQuery([])).toBe("is:unresolved");
    expect(sentryQuery(["service:checkout", "service:billing", "region:us", "region:us", "!release:beta", "timeout", 'url:"a b"', "level:[error,fatal]"])).toBe(
      'is:unresolved service:[checkout,billing] region:us !release:beta timeout url:"a b" level:[error,fatal]',
    );
    expect(sentryQuery(["team:Core Payments"])).toBe('is:unresolved team:"Core Payments"');
  });
});

describe("SentryInbox.fetch", () => {
  test("searches the filtered projects and environments, and marks issues assigned to the token's user", async () => {
    const { calls, request } = fake({
      "": () => ({ user: { id: "9", name: "Ana", email: "ana@acme.dev" } }),
      "organizations/acme/projects/": () => projects,
      "organizations/acme/issues/": () => [issue({ assignedTo: { type: "user", id: "9" } }), issue({ id: "102", shortId: "BILLING-1", substatus: null, assignedTo: { type: "team", id: "9" }, project: { slug: "billing" } })],
    });
    const filters = { projects: ["checkout", "billing"], environments: ["production"], tags: ["service:checkout"] };
    const { login, items } = await Effect.runPromise(Effect.flatMap(inboxWith(filters, request), (inbox) => inbox.fetch()));

    expect(calls.find((call) => call.path === "organizations/acme/issues/")?.params).toMatchObject({
      query: "is:unresolved service:checkout",
      project: ["1", "2"],
      environment: ["production"],
      statsPeriod: "14d",
    });
    // collapse=stats strips firstSeen and lastSeen, and items cannot be stored without them.
    expect(calls.find((call) => call.path === "organizations/acme/issues/")?.params).not.toHaveProperty("collapse");
    expect(login).toBe("Ana");
    expect(items.map((item) => [item.identifier, item.reasons, item.state])).toEqual([
      ["CHECKOUT-3F", ["assigned", "watching"], "escalating"],
      ["BILLING-1", ["watching"], "unresolved"],
    ]);
    expect(items[0]).toMatchObject({
      key: "sentry:CHECKOUT-3F",
      source: "sentry",
      kind: "issue",
      repo: null,
      url: "https://sentry.acme.dev/organizations/acme/issues/101/",
      stateType: "unresolved",
      labels: ["error"],
      team: "checkout",
      priority: "high",
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-02T10:00:00Z",
    });
    expect(items[0]!.body).toBe("TypeError: cart is undefined\nin app/cart.ts in total\n42 events, 7 users, level error, first seen 2026-10-01T10:00:00Z, last seen 2026-10-02T10:00:00Z");
  });

  test("no project filter searches every project; an organization token has no user", async () => {
    const { calls, request } = fake({ "": () => ({ user: null }), "organizations/acme/issues/": () => [issue({ assignedTo: { type: "user", id: "9" } })] });
    const { login, items } = await Effect.runPromise(Effect.flatMap(inboxWith(EMPTY_SENTRY_FILTERS, request), (inbox) => inbox.fetch()));
    expect(calls.map((call) => call.path)).toEqual(["", "organizations/acme/issues/", "organizations/acme/issues/101/tags/"]);
    expect(calls[1]!.params).toMatchObject({ project: ["-1"], environment: [] });
    expect(login).toBeNull();
    expect(items[0]!.reasons).toEqual(["watching"]);
  });

  test("an unknown project fails the poll instead of widening it, after refreshing the project list", async () => {
    const { calls, request } = fake({ "": () => ({ user: null }), "organizations/acme/projects/": () => projects });
    const error = await Effect.runPromise(failureOf(Effect.flatMap(inboxWith({ ...EMPTY_SENTRY_FILTERS, projects: ["checkout", "search"] }, request), (inbox) => inbox.fetch())));
    expect(error.message).toBe("no Sentry project search in acme");
    expect(calls.filter((call) => call.path === "organizations/acme/projects/")).toHaveLength(2);
  });

  test("pages until the limit, and stops at the last page", async () => {
    const page = (start: number, length: number) => Array.from({ length }, (_, index) => issue({ id: String(start + index), shortId: `CHECKOUT-${start + index}` }));
    const list = (limit: number, pages: number) =>
      Effect.gen(function* () {
        const params: Record<string, string | string[]>[] = [];
        const request: SentryRequest = (path, query = {}) =>
          Effect.suspend(() => {
            if (path === "") return Effect.succeed({ data: { user: null } as never, next: null });
            if (TAGS.test(path)) return Effect.succeed({ data: [] as never, next: null });
            params.push(query);
            const at = Number(query.cursor ?? 0);
            return Effect.succeed({ data: page(at, Number(query.limit)) as never, next: at + 100 < pages * 100 ? String(at + 100) : null });
          });
        const inbox = yield* inboxWith(EMPTY_SENTRY_FILTERS, request, limit);
        const { items } = yield* inbox.fetch();
        return { items: items.length, pages: params.map(({ limit, cursor }) => [limit, cursor]) };
      });

    expect(await Effect.runPromise(list(25, 3))).toEqual({ items: 25, pages: [["25", undefined]] });
    expect(await Effect.runPromise(list(250, 3))).toEqual({ items: 250, pages: [["100", undefined], ["100", "100"], ["50", "200"]] });
    expect(await Effect.runPromise(list(500, 2))).toEqual({ items: 200, pages: [["100", undefined], ["100", "100"]] });
  });

  test("an issue repeated across pages does not take a slot", async () => {
    const one = (n: number) => issue({ id: String(n), shortId: `CHECKOUT-${n}` });
    const pages = [Array.from({ length: 100 }, (_, index) => one(index + 1)), [one(100)], [one(101)]];
    const asked: (string | string[] | undefined)[] = [];
    const request: SentryRequest = (path, query = {}) =>
      Effect.suspend(() => {
        if (path === "") return Effect.succeed({ data: { user: null } as never, next: null });
        if (TAGS.test(path)) return Effect.succeed({ data: [] as never, next: null });
        asked.push(query.limit);
        const at = Number(query.cursor ?? 0);
        return Effect.succeed({ data: pages[at] as never, next: at + 1 < pages.length ? String(at + 1) : null });
      });
    const { items } = await Effect.runPromise(inboxWith(EMPTY_SENTRY_FILTERS, request, 101).pipe(Effect.flatMap((inbox) => inbox.fetch())));
    expect(items.map(({ key }) => key)).toEqual(Array.from({ length: 101 }, (_, index) => `sentry:CHECKOUT-${index + 1}`));
    expect(asked).toEqual(["100", "1", "1"]);
  });

  test("items carry tags with few values, and a tag is only read again after a new event", async () => {
    let lastSeen = "2026-10-02T10:00:00Z";
    const { calls, request } = fake({
      "": () => ({ user: null }),
      "organizations/acme/issues/": () => [issue({ lastSeen })],
      "organizations/acme/issues/101/tags/": () => [
        { key: "service", topValues: [{ value: "checkout" }, { value: "billing" }, { value: null }] },
        { key: "url", topValues: Array.from({ length: 11 }, (_, index) => ({ value: `/${index}` })) },
      ],
    });
    const { first, second, third } = await Effect.runPromise(
      Effect.gen(function* () {
        const inbox = yield* inboxWith(EMPTY_SENTRY_FILTERS, request);
        const first = yield* inbox.fetch();
        const second = yield* inbox.fetch();
        lastSeen = "2026-10-03T10:00:00Z";
        const third = yield* inbox.fetch();
        return { first, second, third };
      }),
    );
    expect(first.items[0]!.tags).toEqual(["service:checkout", "service:billing"]);
    expect(second.items[0]!.tags).toEqual(first.items[0]!.tags);
    expect(third.items[0]!.tags).toEqual(first.items[0]!.tags);
    const reads = calls.filter((call) => call.path === "organizations/acme/issues/101/tags/");
    expect(reads).toHaveLength(2);
    expect(reads[0]!.params).toEqual({ limit: "11" });
  });

  test("a failed tag read fails the poll, and the next poll only reads what is missing", async () => {
    let broken = true;
    const { calls, request } = fake({
      "": () => ({ user: null }),
      "organizations/acme/issues/": () => [issue({}), issue({ id: "102", shortId: "CHECKOUT-4" })],
    });
    const flaky: SentryRequest = (path, params) =>
      broken && path === "organizations/acme/issues/102/tags/" ? Effect.fail(new InboxSourceError({ source: "sentry", message: "429" })) : request(path, params);
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const inbox = yield* inboxWith(EMPTY_SENTRY_FILTERS, flaky);
        const error = yield* failureOf(inbox.fetch());
        broken = false;
        const { items } = yield* inbox.fetch();
        expect(items).toHaveLength(2);
        return error;
      }),
    );
    expect(error.message).toBe("429");
    expect(calls.filter((call) => call.path === "organizations/acme/issues/101/tags/")).toHaveLength(1);
  });
});

describe("SentryInbox.options", () => {
  test("suggests project slugs, their environments, and top values of tags with few values", async () => {
    const { calls, request } = fake({
      "organizations/acme/projects/": () => projects,
      "organizations/acme/tags/": () => [
        { key: "service", totalValues: 3 },
        { key: "url", totalValues: 5000 },
      ],
      "organizations/acme/tags/service/values/": () => [{ value: "checkout" }, { value: "billing" }, { value: null }],
    });
    expect(await Effect.runPromise(Effect.flatMap(inboxWith(EMPTY_SENTRY_FILTERS, request), (inbox) => inbox.options))).toEqual({
      projects: ["billing", "checkout"],
      environments: ["production", "staging"],
      tags: ["service:checkout", "service:billing"],
    });
    expect(calls.some((call) => call.path.includes("/url/"))).toBe(false);
  });
});

test("nextCursor reads the next page from Sentry's Link header only when it has results", () => {
  const link = (results: boolean) =>
    `<https://sentry.io/api/0/organizations/acme/projects/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/api/0/organizations/acme/projects/?cursor=0:100:0>; rel="next"; results="${results}"; cursor="0:100:0"`;
  expect(nextCursor(link(true))).toBe("0:100:0");
  expect(nextCursor(link(false))).toBeNull();
  expect(nextCursor(null)).toBeNull();
});
