import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { InboxSourceError } from "./inboxSource.ts";
import { makeSentryInbox, nextCursor, type SentryIssue, type SentryRequest } from "./sentryInbox.ts";
import { EMPTY_SENTRY_FILTERS, sentryQuery, type SentryFilters } from "./shared.ts";
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

/** A Sentry that answers by path and records every request; an unknown path fails like the API would. */
function fake(routes: Record<string, (params: Record<string, string | string[]>) => unknown>) {
  const calls: { path: string; params: Record<string, string | string[]> }[] = [];
  const request: SentryRequest = (path, params = {}) =>
    Effect.suspend(() => {
      calls.push({ path, params });
      const route = routes[path];
      return route ? Effect.succeed({ data: route(params) as never, next: null }) : Effect.fail(new InboxSourceError({ source: "sentry", message: `unexpected ${path}` }));
    });
  return { calls, request };
}

const inboxWith = (filters: SentryFilters, request: SentryRequest) => makeSentryInbox({ url: "https://sentry.acme.dev", org: "acme" }, Effect.succeed(filters), request);

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
    expect(calls.map((call) => call.path)).toEqual(["", "organizations/acme/issues/"]);
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
