import { describe, expect, test } from "bun:test";
import { summarize } from "./update.ts";

const git = { upstream: "origin/main", current: "aaaaaaaaaaaa", latest: "bbbbbbbbbbbb", log: "", changedFiles: "", dirty: "" };

describe("summarize", () => {
  test("lists commits and flags migrations, dependencies and a dirty checkout", () => {
    const status = summarize(
      {
        ...git,
        log: "bbbbbbb feat: analytics\naaaaaa1 fix: slack retry\n",
        changedFiles: "drizzle/0006_x.sql\nsrc/store.ts\nbun.lock\n",
        dirty: " M src/handler.ts\n",
      },
      "launchd",
    );
    expect(status).toMatchObject({
      current: "aaaaaaa",
      latest: "bbbbbbb",
      commits: [
        { sha: "bbbbbbb", subject: "feat: analytics" },
        { sha: "aaaaaa1", subject: "fix: slack retry" },
      ],
      migrations: true,
      dependencies: true,
      dirty: true,
      restart: "launchd",
    });
  });

  test("is quiet when nothing changed", () => {
    expect(summarize(git, "hot")).toMatchObject({ commits: [], migrations: false, dependencies: false, dirty: false });
  });
});
