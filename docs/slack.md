# Slack and MCP

Optional. Drop a PR link in a channel and a review thread opens; the agent's reply is posted back in the Slack thread. Other agents can send PRs for review through MCP tools.

## Setup

Slack runs over Socket Mode: the service opens a WebSocket to Slack, so it needs no tunnel and keeps working when a quick tunnel's URL changes.

1. Create the app at https://api.slack.com/apps → **Create New App** → **From a manifest** and paste [`slack-app-manifest.yaml`](../slack-app-manifest.yaml).
2. **Basic Information → App-Level Tokens**: generate a token with scope `connections:write`; put it in `.env` as `SLACK_APP_TOKEN`.
3. **Install to Workspace**; put the `xoxb-` bot token (OAuth & Permissions) in `.env` as `SLACK_BOT_TOKEN`.
4. Restart the service (the sidebar shows `slack`) and invite the bot to the channel (`/invite @mergeatron`).

### Behind a TLS-inspecting proxy

With Cloudflare WARP, Zscaler and similar, `fetch` to slack.com fails with `self signed certificate in certificate chain` and the sidebar stays on `slack connecting`. Bun reads `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` at startup, so export the CA bundle in the shell that launches `bun` (`.env` is too late for a manual run).

For the launchd service, `bun service.ts install` copies whichever of these is set in the installing shell or in `.env` into the agent's plist, since launchd does not source your shell profile. Re-run `install` (not `restart`) when the bundle path changes.

## Rules for Slack

Add a [rule](rules.md) with one of these events:

| Event | Fires when |
| --- | --- |
| `slack.app_mention` | The bot is mentioned |
| `slack.message` | A human message in the channel links a GitHub PR (set the channel filter) |
| `slack.second_pass` | Someone asks for another round, see [Second pass](#second-pass) |

Channel chatter without a PR link is ignored. PR links posted by other bots are reviewed too, so PRs another orchestrator's agents send through its MCP tools get picked up; turn off a rule's **Bot posts** toggle to ignore bots (such as GitHub notifications). This bot's own posts never fire rules, since the orchestrator that posted already started the review.

The first GitHub PR link in the message picks the repository and PR. The service fetches the head branch with the `gh` CLI so the worktree starts at the PR head. Without `gh` or access to the repository the thread runs in the local checkout instead, so add `gh pr checkout {{pr_number}}` to the prompt as a fallback.

### Second pass

Mention the bot with "second pass" (or "third pass", "4th pass", "next pass", "another pass") inside a review's Slack thread:

```
@mergeatron second pass
```

That re-reviews the PR in a new T3 thread and posts the result in the same thread. The PR comes from the message the thread hangs under (or a PR link in the mention). Slack does not allow custom slash commands inside threads, hence a mention.

### Reactions

| Reaction | Meaning |
| --- | --- |
| ⏩ | Reached the rules but matched none |
| ⏳ | Queued behind the rule's concurrency limit |
| 👀 | Review running |
| `:chayanne-approved:` (✅ if the workspace lacks it) | Approved |
| 🔁 | Changes requested |
| 💬 | The reply states neither |
| ❌ | The review failed |

When the thread is done, the agent's final message is posted as a threaded reply and the reaction flips to the verdict. "Done" means the latest turn settled, no background task (subagent or background shell) is still running, and the thread has been quiet for a minute: the review prompt fans out to subagents, so the first turn ends with "standing by" and T3 starts another turn when they report. T3 thread links are never posted to Slack; they show in the run log.

## MCP server for agents

With Slack configured, the service also serves MCP tools. They live on their own loopback-only port (`MCP_PORT`, default 8788) so a tunnel to the main port never exposes them.

```sh
claude mcp add --scope user --transport http mergeatron http://127.0.0.1:8788/mcp
```

### Reviews and Slack

| Tool | What it does |
| --- | --- |
| `request_review` | Posts the review request in a channel (`channel`, or **Settings → Review channel**) and feeds it to the rules as `slack.message`, like a human's post. Once per PR |
| `request_second_pass` | For later rounds (after pushing fixes): replies in the PR's thread, starts the next round, fires `slack.second_pass`. Runs even when the PR's reviews are paused |
| `review_status` | The PR's thread, round, status, and the latest review's full reply |
| `mark_merged` | Once the PR is merged (checked with `gh`), reacts `:merge:` on the message that opened its thread. Needs a custom `:merge:` emoji |
| `slack_post_message` | Posts any message as the bot (`channel`, Markdown `text`, optional `thread_ts`). `channel` is any channel the bot is in, or a user id (`U…`) to DM that user |
| `notify_user` | DMs you as the bot (**Settings → Your Slack user id**) when an agent needs your attention. Returns `thread_ts`; pass it back to reply in the same DM thread |

The service remembers each PR's channel, thread and round, so agents only pass the PR URL. Add `slack.second_pass` to a rule's events for later rounds to be reviewed automatically; prompts get `{{review_round}}`. Without a matching rule the message is still posted and tags the humans.

### Prompts, runs and usage

| Tool | What it does |
| --- | --- |
| `list_prompts`, `get_prompt` | Every preset and rule prompt with its live and latest version; one with every version |
| `create_prompt_version` | Saves a new version (full `body`, optional `note`). A draft unless `promote` is true |
| `promote_prompt_version` | Makes a version live; promote an older one to roll back |
| `list_rules`, `create_rule`, `update_rule`, `delete_rule`, `list_labels` | Manage [rules](rules.md) |
| `list_runs`, `get_run`, `rate_run`, `run_analytics` | Read runs with usage, score them, aggregate by prompt version and model ([Runs and analytics](runs.md)) |
| `backfill_usage` | Measure cost for runs that have none |

### Message templates

The two Slack messages the review tools post are templates in **Settings → Slack and MCP** with `{{repo}}`, `{{pr_number}}`, `{{pr_url}}`, `{{pr_title}}`, `{{pr_author}}`, `{{round}}`, `{{mentions}}` and `{{note}}`.

Agents fill `{{note}}` and `{{mentions}}`: Slack user ids (`U…`), user group ids (`S…`), or `here`/`channel`. Fixed tags can live in the template as `<@U123>` or `<!subteam^S123>`.
