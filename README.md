# GitHub / Slack → T3 Code review orchestrator

Small Bun service that listens for GitHub webhooks and Slack messages (Socket Mode) and starts a
[T3 Code](https://github.com/pingdotgg/t3code) thread with a prompt you configure.
Typical use: when someone requests your review on a PR, or drops a PR link in a
Slack channel, a review thread opens in T3 Code on a worktree checked out at the
PR head. The service starts the thread, watches for the turn to settle, and for
Slack triggers posts the agent's reply back into the Slack thread.

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
   before wiring up GitHub. **Settings** holds the default model, runtime mode and
   your GitHub login, which lets rules skip PRs you authored.

4. Expose the port to GitHub (for a laptop, `cloudflared tunnel --url http://localhost:8787`
   or [smee.io](https://smee.io)). In the repo or org settings add a webhook:
   content type `application/json`, your secret, and the events you want
   (Pull requests, Pull request reviews, Issue comments, Issues).

### Slack (optional)

Slack runs over Socket Mode: the service opens a WebSocket to Slack, so Slack
needs no tunnel and keeps working when a quick tunnel's URL changes.

1. Create the app at https://api.slack.com/apps → **Create New App** → **From a manifest**
   and paste [`slack-app-manifest.yaml`](slack-app-manifest.yaml).
2. **Basic Information → App-Level Tokens**: generate a token with scope
   `connections:write`; put it in `.env` as `SLACK_APP_TOKEN`.
3. **Install to Workspace**; put the `xoxb-` bot token (OAuth & Permissions) in `.env`
   as `SLACK_BOT_TOKEN`.
4. Restart the service (the header shows `slack connected`) and invite the bot to the
   channel (`/invite @T3 Review`).

Behind a TLS-inspecting proxy (Cloudflare WARP, Zscaler, ...) `fetch` to slack.com
fails with `self signed certificate in certificate chain` and the header stays on
`slack connecting`. Bun reads `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` at startup, so
export the CA bundle in the shell that launches `bun` (`.env` is too late for a manual
run). For the launchd service, `bun service.ts install` copies whichever of these is
set in the installing shell or in `.env` into the agent's plist, since launchd does
not source your shell profile. Re-run `install` (not `restart`) when the bundle path
changes.

Then add a rule with event `slack.app_mention` (fires when the bot is mentioned)
or `slack.message` (human messages in the channel that link a GitHub PR; set the
channel filter). Channel chatter without a PR link is ignored.
The first GitHub PR link in the message picks the repository and PR; the
service fetches the head branch with the `gh` CLI so the worktree starts at the PR
head. Without `gh` or access to the repository the thread runs in the local
checkout instead, so add `gh pr checkout {{pr_number}}` to the prompt as a fallback.

Mentioning the bot with "second pass" inside a review's Slack thread
(`@T3 Review second pass`) re-reviews that PR in a new T3 thread. The PR comes
from the message the thread hangs under (or a PR link in the mention). It fires
rules with event `slack.second_pass`, whose prompt can use `{{previous_result}}`
and `{{previous_thread_url}}` (the last finished review of that PR; also available
to every other PR rule). Slack does not allow custom slash commands inside
threads, hence a mention. The result is posted in the same thread.

A message that reaches the rules but matches none gets a ⏩ reaction so the poster
knows it was seen and skipped. While the review runs the message gets an 👀 reaction. When the
thread is done the agent's final message is posted as a threaded reply and the reaction flips
to the verdict read from that message: `:chayanne-approved:` (✅ if the workspace lacks that
emoji) for an approval, 🔁 for a change request, 💬 when it states neither, ❌ when the review
failed. "Done" means the latest turn settled, no background task
(subagent or background shell) is still running, and the thread has been quiet for a minute:
the review prompt fans out to subagents, so the first turn ends with "standing by" and T3 starts
another turn when they report. T3 thread links are never posted to Slack; they show in the run log.

## Run as a service (macOS)

To keep the orchestrator running without a terminal, install it as a launchd
user agent. It starts at login and launchd restarts it if it crashes:

```sh
bun service.ts install
```

`bun service.ts status` shows pid and last exit code, `logs` tails
`~/Library/Logs/t3-review-orchestrator/orchestrator.log` (one timestamped line per
decision: every delivery received, each rule it did not match and why, skips,
thread starts and verdicts; grep by `delivery=` or `run=`), `restart` picks up
code or `.env` changes, and `uninstall` stops it and removes the agent. The agent
runs `bun index.ts` from this directory, so `.env` and `data/` are the same ones
used when running by hand. Reinstall after moving the checkout or changing the CA
bundle path (see the Slack section).

## Rules

Each rule has:

- **Events**: one or more keys the rule fires on: `<event>.<action>` such as
  `pull_request.review_requested`, or `slack.app_mention` / `slack.message` /
  `slack.second_pass` for Slack. One rule can serve both sources.
- **Repositories**: optional `owner/name` list. Empty matches every repo. For
  Slack rules this is the repository of the PR linked in the message.
- **Requested reviewer** (GitHub): optional login or team slug. Handy so only
  reviews requested from you fire, not every review request on the repo.
- **Slack channel** (Slack): optional channel id. Empty matches any channel the
  bot is in.
- **Skip my own PRs**: on by default. When the PR author is the GitHub login in
  Settings the run is recorded as skipped instead of reviewing your own work.
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
  `{{comment_body}}`, `{{slack_text}}` and friends are substituted; see the chips
  in the editor.

GitHub and Slack retry deliveries; the same delivery id never starts a second
thread for the same rule. A PR also gets one review at a time: while a run for
it is still running, further triggers for that PR (any rule, any source) are
logged as skipped and, on Slack, answered with a short note. Runs show in the right-hand log as `running` until the
thread's first turn settles, then `done` with the agent's final message (or
`failed`). A thread with no result after 3 hours is marked `failed`, which frees
the PR for a new review. Watchers survive restarts: runs still `running` are re-polled on boot.

## Analytics

**Analytics** in the header swaps the editor for run counts: totals, runs per PR
or issue author, and runs per trigger source, each split into running, done,
skipped and failed. Sources are `github` (webhook), `slack` (Socket Mode) and
`manual` (connection test). The same data is at `GET /api/analytics`.

## Updating

The header shows **Update** when the tracked upstream (`origin/main` for a
plain clone) has commits the running server does not, including ones already
pulled by hand without a restart. The popover lists them and flags
whether they bring migrations or dependency changes. **Update and restart**
fast-forwards the checkout, runs `bun install` if `bun.lock` moved, then gets
the new code running: the launchd agent is restarted by launchd, `bun --hot`
reloads on its own, and a plain `bun index.ts` spawns a replacement before
exiting. Migrations apply on that start, as always. A checkout with uncommitted
changes cannot be updated from the UI. `GET /api/update` returns the same check.

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
