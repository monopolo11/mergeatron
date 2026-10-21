# Development

## How it talks to T3 Code

The service speaks T3's orchestration protocol 2 (T3 Code 0.0.46 and later). It launches each thread with one `orchestration.launchThread` call over the WebSocket RPC (see `packages/contracts/src/orchestrationV2.ts` in T3 Code): T3 creates the thread, fetches the base branch, creates the worktree, runs the project's setup script and sends the prompt. The service then links the PR to the thread and polls the thread's bounded snapshot until its runs and background work settle.

Auth is a scoped bearer token issued by the `t3` CLI against the same `~/.t3/userdata` database the desktop app uses. Reads (projects, threads, environment descriptor) go over HTTP with the same token.

## Architecture

The service is written with [Effect](https://effect.website) v4. Every dependency (database, T3 client, Slack, the `gh` CLI, the Sentry client, the inbox poller, the updater) is a `Context.Service` class with a `layer`, and `index.ts` composes them into one layer graph that `BunRuntime.runMain` launches.

- Shutting down (`SIGINT`/`SIGTERM`) closes that graph in reverse: the HTTP servers stop, background fibers (completion watchers, inbox polls, the Slack socket) are interrupted, the database closes.
- `src/background.ts` supervises everything that outlives a request, so no work runs as a dangling promise. The queue advance and the stuck-PR check run on the supervisor fiber (`src/supervisor.ts`) off a queue of run events.
- Failures are typed (`T3HttpError`, `T3RpcError`, `SlackApiError`, `InboxSourceError`, `UpdateError`, `ReviewRequestError`) and handled where they are expected.
- Intervals and retries are `Schedule`s: the Slack socket reconnects with exponential backoff (1s doubling to 30s, jittered), watchers poll T3 every 5s for up to 3h, each inbox source polls on its own interval, and `gh`/`git` run as child processes that interruption kills.

Storage is SQLite via Drizzle (`src/db/schema.ts`); `src/store.ts` wraps the synchronous queries in `Effect.sync`. Migrations in `drizzle/` run at startup. After changing the schema run `bun x drizzle-kit generate`. API payloads are Effect `Schema`s in `src/rules.ts`: decoding fills defaults, trims names and answers a bad request with the failing path.

The UI is React + Tailwind v4 + shadcn/ui (`frontend/components/ui`, add more with `bunx --bun shadcn@latest add <component>`; fix any `from "cn"` import it emits to `@/lib/utils`). Tailwind is compiled by `bun-plugin-tailwind` inside `Bun.serve` (see `bunfig.toml`), so always run the app through `index.ts`; a bare `bun build` of the HTML skips the plugin.

## Tests

```sh
bun test
```

Tests get fresh services from `src/testing.ts`: an in-memory store, the background supervisor and fakes for T3, Slack and the `gh` lookups. A test provides `testLayer({ t3, slack })`, runs its body as an Effect, and waits for background work with `settle` instead of sleeping.

## Observability

Logs are one line per decision, rendered by Effect's logger (`src/log.ts`); annotations such as the delivery or run id become `key=value` pairs.

Metrics are served in Prometheus format at `GET /api/metrics`:

- `orchestrator_deliveries_total` by trigger
- `orchestrator_runs_total` by initial status, `orchestrator_runs_settled_total` by outcome
- `orchestrator_thread_duration`, `orchestrator_watchers_active`
- `orchestrator_polls_total` and `orchestrator_inbox_items` by source
- Effect's fiber runtime metrics

Deliveries, thread starts, watchers, T3 RPCs, Slack calls, polls, updates and MCP tool calls each run in a tracing span. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to export logs, metrics and traces over OTLP to a collector (Grafana, Jaeger, Honeycomb, ...); without it nothing is exported.
