# Rules

A rule says: when this event happens, start a T3 thread with this prompt. Everything the service does starts from one.

**Rules** lists them on the left with their runs in the range, and the selected rule's editor beside it. Changes save with **Save**; see [Prompt versions](#prompt-versions).

## Fields

| Field | Meaning |
| --- | --- |
| **Events** | One or more keys the rule fires on, picked by source (GitHub, Slack, Inbox, Webhooks) with each source's count of picks. One rule can serve several sources |
| **Repositories** | Optional `owner/name` list. Empty matches every repo. For Slack rules, the repository of the PR linked in the message |
| **Requested reviewer** | GitHub only. A login or team slug, so only reviews requested from you fire, not every review request on the repo |
| **Slack channel** | Slack only. A channel id. Empty matches any channel the bot is in |
| **Skip my own PRs** | On by default. When the PR author is the GitHub login in **Settings → Defaults**, the run is recorded as skipped |
| **T3 project** | Explicit, or auto-matched by comparing the webhook repository to each project's git remote |
| **Workspace** | `worktree`: T3 starts the thread in a new worktree from `origin/<PR head>` (or the default branch for non-PR events). `local`: in the project checkout |
| **Model** | Optional override; otherwise the project default, then the global default. Pickers list only what T3's own provider config offers |
| **Concurrency** | Threads of this rule running at once (default 3, 0 unlimited). See [Concurrency](#concurrency) |
| **Prompt** | The thread's first message, with variables |

Event keys look like `pull_request.review_requested`, `slack.app_mention`, `slack.message`, `slack.second_pass`, `webhook.<slug>` or an [inbox event](inbox.md#automations).

**Workspace notes.** Linear and Sentry issues name no branch, so their worktree starts from the project checkout's `origin/HEAD`, which also fills `{{default_branch}}`. When git cannot tell, the thread runs in the checkout and the run's detail says why. Fork PRs have no branch on `origin`: use `local` and `gh pr checkout` in the prompt.

## Prompts

The prompt is a template. `{{pr_url}}`, `{{pr_title}}`, `{{pr_head}}`, `{{comment_body}}`, `{{slack_text}}` and friends are substituted; the editor lists every available variable as a chip. Slack-triggered and PR rules also get `{{previous_result}}` and `{{previous_thread_url}}` (the last finished review of that PR) and, for MCP review requests, `{{review_round}}`. [Custom webhooks](webhooks.md#custom-webhooks) add `{{payload.<path>}}`.

### Prompt versions

Dispatch presets and each rule's own prompt are versioned. Saving never edits a version: a changed body becomes the next version, a **draft** that runs ignore, unless you click **Save and promote**.

- The version select above the prompt shows any version read-only.
- **Promote** makes it live (promoting an older one rolls back).
- **Edit from this** starts a draft from it.

Rule settings save with the same buttons and apply at once. Agents read and version prompts through the [MCP tools](slack.md#mcp-server-for-agents); their versions are marked `mcp`.

HTTP: `GET` and `POST /api/{prompts,rules}/:id/versions` (`{ body, note?, promote? }`) and `POST /api/{prompts,rules}/:id/versions/:version/promote`.

## How runs behave

Each match is a run. It shows in the live log as:

| Status | Meaning |
| --- | --- |
| `queued` | Waiting for the rule's concurrency limit, or for a paused queue to resume |
| `running` | Thread started; until its first turn settles |
| `done` | Settled, with the agent's final message as the result |
| `failed` | The thread failed, or had no result after 3 hours (which frees the PR for a new review) |
| `skipped` | Matched but not run: own PR, PR already under review, paused |

A PR gets one review at a time: while a run for it is running, further triggers for that PR (any rule, any source) are logged as skipped and, on Slack, answered with a short note. Watchers survive restarts: runs still `running` are re-polled on boot.

### Concurrency

Every rule has a **Concurrency** limit. A match past it is recorded as `queued`, with the rule's prompt, project, workspace and model frozen on the run, and starts when a thread of the rule settles or fails to start, oldest first. Raising the limit starts queued runs right away, and queued runs survive a restart.

A queued review holds its PR's one-at-a-time lock like a running one, and is skipped if the PR got a thread from elsewhere before its turn. Dispatches from the inbox share one limit set in the dialog. Slack-triggered reviews react ⏳ while queued, then 👀 when they start.

### Usage limits

When a thread fails because the provider's usage ran out (T3 reports the failure as a usage limit), the whole queue pauses: no thread starts, and every new match is recorded as `queued` until it resumes. A banner above every page says why, links the thread, and shows when the queue resumes: at the reset time T3 reported, or never on its own when the provider gave none. Pick another time and **Reschedule resume** to move it, or **Resume now**. On resume, queued runs start oldest first within each rule's concurrency limit. The pause and its resume time survive a restart.

The API behind the banner: `GET /api/queue/pause` (null while the queue runs), `PUT /api/queue/pause` with `{ "resumeAt": "<ISO time>" }`, and `DELETE /api/queue/pause` to resume now.

## Stuck PRs

Reviews of a PR that keep ending in "changes requested" mean the scope is moving or a finding keeps coming back, and another round will not fix that. The verdict of each finished review is read from the agent's final message (same as the Slack reaction).

Once **Pause after change requests** in Settings → Reviews (default 3) reviews in a row of one PR request changes:

1. That PR's automated review pauses.
2. The service opens one more thread, `Handoff: <PR title>`, in the same project and workspace as the last review.
3. Its first message is the **Handoff prompt** in Settings: the PR variables plus `{{rounds}}` and `{{review_history}}` (every review report of the streak, oldest first). The default asks for a handoff document: which findings recur, what was fixed and came back, where the scope moved, and a recommendation.

The document is the run's result (rule `handoff` in the log) and, for Slack-triggered PRs, is posted in the review thread after a "review paused" note.

While paused, further triggers for the PR are logged as skipped and point at the handoff thread. An approval ends the streak. A "second pass" mention on Slack always reviews, so a human can resume once the PR is reshaped; a change request past the limit does not write a second handoff. Set the limit to 0 to never pause.
