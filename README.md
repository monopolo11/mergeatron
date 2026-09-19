# GitHub → T3 Code review orchestrator

Small Bun service that listens for GitHub webhooks and starts a
[T3 Code](https://github.com/pingdotgg/t3code) thread with a prompt you configure.
Typical use: when someone requests your review on a PR, a review thread opens in
T3 Code on a worktree checked out at the PR head. The service starts the thread
and is done; the agent takes it from there.

## How it talks to T3 Code

The service sends one `thread.turn.start` command over T3 Code's WebSocket RPC
(`orchestration.dispatchCommand`, see `packages/contracts/src/rpc.ts`) with the
same bootstrap the composer uses: T3 creates the thread, fetches the base branch,
creates the worktree, runs the project's setup script and starts the turn. The
service then links the PR to the thread. Auth is a scoped bearer token issued by
the `t3` CLI against the same `~/.t3/userdata` database the desktop app uses;
reads (projects, environment descriptor) go over HTTP with the same token.

## Setup

```sh
bun install
cp .env.example .env
```

1. Issue a token (match the version of your installed T3 Code, shown in About):

   ```sh
   npx t3@<version> auth session issue --token-only --ttl 365d --label "github review orchestrator"
   ```

   Put it in `.env` as `T3_TOKEN`.

2. Pick a webhook secret, put it in `.env` as `GITHUB_WEBHOOK_SECRET`.

3. Run:

   ```sh
   bun --hot index.ts
   ```

   The UI is at http://localhost:8787: rules on the left, the selected rule's editor
   in the middle (changes autosave), live run log on the right. The webhook endpoint
   is `POST /webhooks/github`. Use **Test thread** in the header to start a
   one-message thread in a project and confirm the token, RPC and provider work
   before wiring up GitHub. **Settings** holds the default model and runtime mode.

4. Expose the port to GitHub (for a laptop, `cloudflared tunnel --url http://localhost:8787`
   or [smee.io](https://smee.io)). In the repo or org settings add a webhook:
   content type `application/json`, your secret, and the events you want
   (Pull requests, Pull request reviews, Issue comments, Issues).

## Run as a service (macOS)

To keep the orchestrator running without a terminal, install it as a launchd
user agent. It starts at login and launchd restarts it if it crashes:

```sh
bun service.ts install
```

`bun service.ts status` shows pid and last exit code, `logs` tails
`~/Library/Logs/t3-review-orchestrator/orchestrator.log`, `restart` picks up
code or `.env` changes, and `uninstall` stops it and removes the agent. The agent
runs `bun index.ts` from this directory, so `.env` and `data/` are the same ones
used when running by hand. Reinstall after moving the checkout.

## Rules

Each rule has:

- **Event**: `<event>.<action>` such as `pull_request.review_requested`.
- **Repositories**: optional `owner/name` list. Empty matches every repo.
- **Requested reviewer**: optional login or team slug. Handy so only reviews
  requested from you fire, not every review request on the repo.
- **T3 project**: explicit, or auto-matched by comparing the webhook repository
  to each project's git remote.
- **Workspace**: `worktree` asks T3 to start the thread in a new worktree from
  `origin/<PR head>` (or the default branch for non-PR events); `local` starts it
  in the project checkout. Fork PRs have no branch on `origin`, so use `local`
  and `gh pr checkout` in the prompt for those.
- **Model**: optional override; otherwise project default, then the global default.
  Provider and model pickers are populated from T3's own provider config
  (`server.getConfig`), so only instances and models T3 knows about are offered.
- **Prompt**: first message of the thread. `{{pr_url}}`, `{{pr_title}}`, `{{pr_head}}`,
  `{{comment_body}}` and friends are substituted; see the chips in the editor.

GitHub retries deliveries; the same delivery id never starts a second thread for
the same rule. Recent runs and their thread links show at the bottom of the UI.

## Analytics

**Analytics** in the header swaps the editor for run counts: totals, runs per PR
or issue author, and runs per trigger source, each split into started, skipped
and failed. Sources are `github` (webhook), `manual` (connection test) and
`slack`, which is listed at zero until a Slack trigger exists. The same data is
at `GET /api/analytics`.

## Development

Storage is SQLite via Drizzle (`src/db/schema.ts`). Migrations in `drizzle/` run
at startup; after changing the schema run `bun x drizzle-kit generate`.

The UI is React + Tailwind v4 + shadcn/ui (`frontend/components/ui`, add more with
`bunx --bun shadcn@latest add <component>`; fix any `from "cn"` import it emits to
`@/lib/utils`). Tailwind is compiled by `bun-plugin-tailwind` inside `Bun.serve`
(see `bunfig.toml`), so always run the app through `index.ts`; a bare `bun build`
of the HTML skips the plugin.

```sh
bun test
```
