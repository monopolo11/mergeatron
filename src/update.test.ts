import { describe, expect, test } from "bun:test";
import { summarize, summarizeRelease } from "./update.ts";

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

describe("summarizeRelease", () => {
  const history = "Monopolo11\tmonopolo11@example.com\n";

  test("names contributors with no earlier commit, by GitHub login when the email has one", () => {
    const release = summarizeRelease(
      ["Monopolo11\tmonopolo11@example.com\tabc1234\tfix: a", "Ada Lovelace\t42+ada@users.noreply.github.com\tdef5678\tfeat: b\ttabbed", "Ada Lovelace\t42+ada@users.noreply.github.com\t0123456\tfix: c"].join("\n"),
      history,
    );
    expect(release.newContributors).toEqual(["ada"]);
    expect(release.commits).toEqual([
      { sha: "abc1234", subject: "fix: a", author: "Monopolo11" },
      { sha: "def5678", subject: "feat: b\ttabbed", author: "ada" },
      { sha: "0123456", subject: "fix: c", author: "ada" },
    ]);
  });

  test("matches known contributors regardless of case", () => {
    expect(summarizeRelease("monopolo11\tother@example.com\tabc1234\tfix: a", history).newContributors).toEqual([]);
  });
});
