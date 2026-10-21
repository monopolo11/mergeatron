# Upgrading from "T3 Review"

The project used to be called T3 Review / `t3-review-orchestrator`. After pulling the rename, three things on your machine still use the old names.

1. **MCP server.** The server is now named `mergeatron`, so the tools show up as `mcp__mergeatron__*` instead of `mcp__t3-review__*`. Re-register it, and update any prompt, skill or permission rule that mentions the old tool names:

   ```sh
   claude mcp remove t3-review --scope user
   claude mcp add --scope user --transport http mergeatron http://127.0.0.1:8788/mcp
   ```

2. **launchd agent** (if you run it as a service). The label changed from `com.t3.review-orchestrator` to `com.mergeatron.service` and the log moved to `~/Library/Logs/mergeatron/mergeatron.log`. Until you migrate, the old agent keeps running and `bun service.ts status` / `restart` point you here. One command stops and removes the old agent, then installs the new one (a brief downtime; the old log stays in `~/Library/Logs/t3-review-orchestrator/`):

   ```sh
   bun service.ts migrate
   ```

3. **Database.** Nothing to do. On the first start with `DATA_PATH` unset, a database at `./data/orchestrator.sqlite` is copied to `~/.mergeatron/data/`; the old file stays as a backup and can be deleted once you are happy. Migrate the launchd agent first if you run one, so the old and new process never share the file.

The Slack app is not renamed by pulling: re-apply `slack-app-manifest.yaml` (or rename it in the Slack app settings) to change the bot's name to `@mergeatron`.
