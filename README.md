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

   The UI is at http://localhost:8787. **Rules** lists your rules on the left with the
   selected rule's editor beside it (changes autosave). The live run log sits on the
   right of every page; **Runs** in the top bar hides it. The webhook endpoint
   is `POST /webhooks/github`. **Settings** is its own page with six sections, one shown at a time:
   **Connection** (what the service talks to, a **Test thread** button that starts a
   one-message thread in a project to confirm the token, RPC and provider work
   before wiring up GitHub, and the update check), **Defaults** (model, runtime
   mode, your GitHub login, which lets rules skip PRs you authored), **Polling**,
   **Dispatch presets**, **Reviews** (how many change requests in a row pause a
   PR's reviews plus the handoff prompt, see [Stuck PRs](#stuck-prs)) and
   **Slack and MCP**. Everything on it autosaves.

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
channel filter). Channel chatter without a PR link is ignored. PR links posted by
other bots are reviewed too, so PRs another orchestrator's agents send through its MCP
tools get picked up; turn off a rule's **Bot posts** toggle to ignore bots (e.g. GitHub
notifications). This bot's own posts never fire rules, since the orchestrator that
posted already started the review.
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

### MCP server for agents

With Slack configured, the orchestrator also serves MCP tools that let other agents
send PRs for review through the bot. They live on their own loopback-only port
(`MCP_PORT`, default 8788) so a tunnel to the main port never exposes them:

```sh
claude mcp add --scope user --transport http t3-review http://127.0.0.1:8788/mcp
```

| Tool | What it does |
| --- | --- |
| `request_review` | Posts the review request in a channel (`channel`, or **Settings → Review channel**) and feeds it to the rules as `slack.message`, like a human's post. Once per PR. |
| `request_second_pass` | For later rounds (e.g. after pushing fixes): replies in the PR's thread, starts the next round, fires `slack.second_pass`. Runs even when the PR's reviews are paused. |
| `review_status` | The PR's thread, round, status, and the latest review's full reply. |
| `mark_merged` | Once the PR is merged (checked with `gh`), reacts `:merge:` on the message that opened its thread. The workspace needs a custom `:merge:` emoji. |
| `slack_post_message` | Posts any message as the bot (`channel`, Markdown `text`, optional `thread_ts`). |

The orchestrator remembers each PR's channel, thread and round, so agents only pass
the PR URL. Add `slack.second_pass` to a rule's events for later rounds to be
reviewed automatically; prompts get `{{review_round}}`. Without a
matching rule the message is still posted and tags the humans.

Both messages are templates in **Settings → Slack and MCP** with `{{repo}}`, `{{pr_number}}`,
`{{pr_url}}`, `{{pr_title}}`, `{{pr_author}}`, `{{round}}`, `{{mentions}}` and `{{note}}`.
Agents fill `{{note}}` and `{{mentions}}`: Slack user ids (`U…`), user group ids (`S…`),
or `here`/`channel`. Fixed tags can live in the template as `<@U123>` or `<!subteam^S123>`.

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
logged as skipped and, on Slack, answered with a short note. Runs show in the right-hand log as `queued` while they wait
for their rule's concurrency limit, `running` until the
thread's first turn settles, then `done` with the agent's final message (or
`failed`). A thread with no result after 3 hours is marked `failed`, which frees
the PR for a new review. Watchers survive restarts: runs still `running` are re-polled on boot.

### Stuck PRs

Reviews of a PR that keep ending in "changes requested" mean the scope is moving
or a finding keeps coming back, and another round will not fix that. The verdict
of each finished review is read from the agent's final message (same as the Slack
reaction). Once **Pause after change requests** in Settings (default 3) reviews in
a row of one PR request changes, that PR's automated review pauses and the
orchestrator opens one more thread, `Handoff: <PR title>`, in the same project
and workspace as the last review. Its first message is the **Handoff prompt** in
Settings: the PR variables plus `{{rounds}}` and `{{review_history}}` (every review
report of the streak, oldest first). The default asks for a handoff document: which
findings recur, what was fixed and came back, where the scope moved, and a
recommendation. The document is the run's result (rule `handoff` in the log) and, for Slack-triggered
PRs, is posted in the review thread after a "review paused" note.

While paused, further triggers for the PR are logged as skipped and point at the
handoff thread. An approval ends the streak. A "second pass" mention on Slack
always reviews, so a human can resume once the PR is reshaped; a change request
past the limit does not write a second handoff. Set the limit to 0 to never pause.

## Inbox: polled PRs and issues, dispatch, automations

Besides webhooks and Slack, the orchestrator polls for the open PRs and issues
that involve you. **Inbox** in the header lists them grouped by why they are
yours, and each row (or a selection) can be dispatched to T3 with a composed
prompt; rules on the inbox events do the same automatically.

- **GitHub** through the `gh` CLI (your existing login, private repos included):
  PRs where your review is requested, PRs and issues assigned to you, PRs and
  issues that mention you, and PRs you authored. One GraphQL search per reason.
- **Linear** with a personal API key in `.env` as `LINEAR_API_KEY`: issues
  assigned to or created by you that are not done, plus issues whose description
  or comments mention you (from your notifications). Without the key Linear is off.

Each item carries its `reasons` (`review_requested`, `assigned`, `mentioned`,
`authored`), labels, state (`open`/`draft`, or the Linear state name and type),
Linear team and priority, and for PRs the head branch and commit. The inbox shows
the latest run on each item from any trigger. **Settings → Polling** turns each
source on or off and sets its interval in minutes; the counts in the inbox bar
poll on click.

Items are stored in SQLite (`inbox_items`), so the inbox is full the moment
the service starts and every poll is a diff: new items get a first-seen time
("In inbox" column), items the source stops returning (closed, merged,
unassigned, done) are marked gone and kept for 30 days under the **left**
toggle, and an item that comes back starts a new stay. The same data is at
`GET /api/inbox` (`?gone=1` appends departed items); `POST /api/inbox/poll`
with `{"source"}` polls now.

### Dispatch

**Dispatch** on a row, or **Dispatch selected** for several, opens the composer:
click presets to stack them (the stacked bodies become the message; edit it
freely), pick the T3 project (auto by git remote, or explicit; Linear issues
have no repository, so pick one), workspace, model and how many threads to
run at a time. One thread starts per item; the message is a template the server
renders per item with the same variables webhook deliveries get (`pr_url`,
`issue_url`, …) plus `labels`, `reasons`, `state`, `state_type`, `team`,
`priority`, `issue_identifier`, `branch`, `review_decision`. Presets are edited
in **Settings → Dispatch presets** (`/api/prompts`, seeded with "Review PR",
"Implement issue" and "Address review feedback"): one row per preset, click to
open it, name and body autosave. A dispatch by hand reviews a PR even when its
automated reviews are paused; one thread per PR or issue at a time still holds.
The run log shows dispatches under the preset names with source `manual`.

### Automations

An automation is a rule on an inbox event: **Inbox: GitHub PR**, **Inbox: GitHub
issue** or **Inbox: Linear issue**. A rule polls one source: picking a Linear
inbox event drops the GitHub ones and the other way round. On top of the
repository list the editor gets **Reasons**, **States**, **Labels** (any of the
listed, or switch to all) and, for Linear, **Teams** instead of repositories.
Each is a token field that suggests values seen in the inbox with counts; type
to add one not seen yet. Labels also come from the source itself: after a poll,
labels older than an hour are synced from every GitHub repository with inbox
items or named in a rule, and from Linear's workspace and team labels, and the
editor suggests those within the rule's repositories or teams.
"Review every PR where my review is requested in acme/widgets" is a rule on
Inbox: GitHub PR, repo `acme/widgets`, reason `review requested`. "Implement
Linear issues in Todo assigned to me with label ready-for-dev" is Inbox: Linear
issue, team `ENG`, reason `assigned to me`, state `Todo`, label `ready for dev`,
with the project set. Label and state filters work on webhook rules too, since
PR and issue payloads now carry `labels` and `state`.

**Matches now** in the editor lists the inbox items for the rule's events,
matching ones first with what the rule did for them, the rest with the
matcher's reason ("labels needs design include none of ready for dev", "state In
Progress is not Todo"). After every poll each armed rule fires on the items it
matches. A rule is armed for an item when the item saw activity after the rule
was last saved, so a new or re-enabled rule does not fan out over everything
already in the inbox; **Run on N now** backfills (`POST /api/rules/:id/run-now`).
An item fires a rule once (delivery id = item key); PR rules with **Re-run on
push** (default on) fire again for each new head commit, like
`pull_request.synchronize`. Runs show in the log with source `poll`.

### Concurrency

Every rule has a **Concurrency** limit (default 3, 0 for unlimited): threads of
that rule running at once. A match past the limit is recorded as `queued`,
with the rule's prompt, project, workspace and model frozen on the run, and
starts when a thread of the rule settles or fails to start, oldest first; raising
the limit starts queued runs right away, and queued runs survive a restart. A
queued review holds its PR's one-at-a-time lock like a running one, and is
skipped if the PR got a thread from elsewhere before its turn. Dispatches from
the inbox share one limit set in the dialog. Slack-triggered reviews react ⏳
while queued, then 👀 when they start.

## Analytics

**Analytics** in the header swaps the editor for run counts: totals, runs per PR
or issue author, and runs per trigger source, each split into running, done,
skipped and failed. Sources are `github` (webhook), `slack` (Socket Mode), `poll`
(inbox automations) and `manual` (inbox dispatches and connection tests). The same data is at `GET /api/analytics`.

## Updating

The header shows **update · N** when the tracked upstream (`origin/main` for a
plain clone) has commits the running server does not, including ones already
pulled by hand without a restart; **Settings → Connection** lists them and flags
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
