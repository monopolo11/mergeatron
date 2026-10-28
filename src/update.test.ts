import { describe, expect, test } from "bun:test";
import { describeBuild, summarizeRelease, targetFor } from "./update.ts";
import type { ReleaseInfo } from "./version.ts";

describe("describeBuild", () => {
  const clean = { tags: [], dirty: "", branch: null };

  test("a clean release checkout is that release, the stable when a nightly shares its commit", () => {
    expect(describeBuild({ ...clean, tags: ["v0.1.3-nightly.20261020.4", "v0.1.3", "not-a-release"] })).toEqual({ kind: "release", version: "v0.1.3" });
  });

  test("uncommitted changes make any checkout a development build", () => {
    expect(describeBuild({ tags: ["v0.1.3"], dirty: " M src/handler.ts\n", branch: null })).toEqual({ kind: "development", reason: "dirty" });
  });

  test("main on no release may update; any other untagged commit may not", () => {
    expect(describeBuild({ ...clean, branch: "main" })).toEqual({ kind: "main" });
    expect(describeBuild({ ...clean, branch: "feat/x" })).toEqual({ kind: "development", reason: "untagged" });
    expect(describeBuild(clean)).toEqual({ kind: "development", reason: "untagged" });
  });
});

describe("targetFor", () => {
  const release = (tag: string, prerelease = tag.includes("nightly")): ReleaseInfo => ({ tag, url: `https://github.com/o/r/releases/tag/${tag}`, prerelease });
  const releases = [release("v0.1.2"), release("v0.1.3-nightly.20261027.9")];

  test("main moves onto the latest stable, whatever the channel", () => {
    expect(targetFor({ kind: "main" }, "nightly", releases)?.tag).toBe("v0.1.2");
  });

  test("development builds never update", () => {
    expect(targetFor({ kind: "development", reason: "untagged" }, "nightly", releases)).toBeNull();
  });

  test("a release follows its channel", () => {
    expect(targetFor({ kind: "release", version: "v0.1.1" }, "stable", releases)?.tag).toBe("v0.1.2");
    expect(targetFor({ kind: "release", version: "v0.1.1" }, "nightly", releases)?.tag).toBe("v0.1.3-nightly.20261027.9");
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
