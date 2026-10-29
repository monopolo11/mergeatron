---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

## Effect

The backend is Effect v4 (`effect`, `@effect/platform-bun`). Conventions:

- A dependency is a `Context.Service` class with a static `layer` (see `src/store.ts`, `src/t3.ts`); `index.ts` composes the layer graph and launches it with `BunRuntime.runMain`. Services are read with `yield* Store`, never imported as singletons.
- Expected failures are `Data.TaggedError` classes handled with `Effect.catchTag`/`catchTags`; unexpected ones are defects. Do not throw.
- Anything that outlives a request goes through `Background.fork`/`watch` (`src/background.ts`), never a bare promise or `setTimeout`. Intervals and retries are `Schedule`s.
- Log with `logger(scope)` from `src/log.ts` (returns effects; fields become `key=value` annotations). Wrap meaningful operations in `Effect.fn("name")` or `Effect.withSpan` so they trace.
- API payloads are Effect `Schema`s in `src/rules.ts`; zod is only used for MCP tool inputs, which the MCP SDK requires.
- Tests build services from `src/testing.ts` (`testLayer`, `fakeT3`, `fakeSlack`, `settle`) and run bodies with `runWith`.
- `src/inbox.ts`, `src/filterQuery.ts`, `src/match.ts`, `src/shared.ts`, `src/template.ts` and `src/verdict.ts` are imported by the frontend bundle: keep them free of Effect and server imports.

## Reviews

Never ask for review in Slack (no `request-review` skill, no `request_review` or `slack_post_message` MCP tools). Open the PR and leave review requests to the human.
