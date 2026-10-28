import { describe, expect, test } from "bun:test";
import { compareVersions, formatVersion, nextRelease, parseVersion, pickRelease, type ReleaseInfo } from "./version.ts";

describe("parseVersion", () => {
  test("reads stable and nightly tags", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, nightly: null });
    expect(parseVersion("v0.1.4-nightly.20261027.12")).toEqual({ major: 0, minor: 1, patch: 4, nightly: { date: 20261027, run: 12 } });
  });

  test("rejects tags that are not releases", () => {
    for (const tag of ["1.2.3", "v1.2", "v1.2.3-beta.1", "v1.2.3-nightly.2026102.1", "v1.2.3-nightly.20261027", "release-1"]) expect(parseVersion(tag)).toBeNull();
  });
});

describe("compareVersions", () => {
  test("orders numerically, a nightly below its stable, nightlies by date then run", () => {
    const tags = ["v0.10.0", "v0.2.0", "v0.2.1-nightly.20261027.3", "v0.2.1", "v0.2.1-nightly.20261026.9", "v0.2.1-nightly.20261027.10"];
    expect(tags.map((tag) => parseVersion(tag)!).sort(compareVersions).map(formatVersion)).toEqual([
      "v0.2.0",
      "v0.2.1-nightly.20261026.9",
      "v0.2.1-nightly.20261027.3",
      "v0.2.1-nightly.20261027.10",
      "v0.2.1",
      "v0.10.0",
    ]);
  });
});

describe("pickRelease", () => {
  const release = (tag: string, prerelease = tag.includes("nightly")): ReleaseInfo => ({ tag, url: "", prerelease });
  const releases = [release("v0.1.2"), release("v0.1.3-nightly.20261027.9"), release("v0.1.1"), release("draft-name")];
  const pick = (channel: "stable" | "nightly", current: string | null, from = releases) => pickRelease(from, channel, current === null ? null : parseVersion(current))?.tag ?? null;

  test("stable sees stable releases only, nightly takes the highest of both", () => {
    expect(pick("stable", null)).toBe("v0.1.2");
    expect(pick("nightly", null)).toBe("v0.1.3-nightly.20261027.9");
  });

  test("a release GitHub marks as prerelease is not stable, whatever its tag", () => {
    expect(pick("stable", null, [release("v0.1.1"), release("v0.2.0", true)])).toBe("v0.1.1");
  });

  test("nightly rolls onto a stable that passes it", () => {
    expect(pick("nightly", "v0.1.3-nightly.20261027.9", [...releases, release("v0.1.3")])).toBe("v0.1.3");
  });

  test("never offers a downgrade: leaving nightly for stable waits for a newer stable", () => {
    expect(pick("stable", "v0.1.3-nightly.20261027.9")).toBeNull();
    expect(pick("stable", "v0.1.3-nightly.20261027.9", [...releases, release("v0.1.3")])).toBe("v0.1.3");
    expect(pick("nightly", "v0.1.3-nightly.20261027.9")).toBeNull();
    expect(pick("stable", "v0.1.2")).toBeNull();
  });
});

describe("nextRelease", () => {
  const nightly = { date: new Date("2026-10-27T23:30:00Z"), run: 42 };

  test("starts at v0.1.0 with no stable release", () => {
    expect(nextRelease([], "stable", nightly)).toEqual({ version: "v0.1.0", previous: null });
    expect(nextRelease(["unrelated"], "nightly", nightly)).toEqual({ version: "v0.1.0-nightly.20261027.42", previous: null });
  });

  test("stable bumps the patch of the latest stable, ignoring nightlies", () => {
    expect(nextRelease(["v0.1.9", "v0.1.10", "v0.1.11-nightly.20261020.5"], "stable", nightly)).toEqual({ version: "v0.1.11", previous: "v0.1.10" });
  });

  test("nightly is a prerelease of the next stable; its notes start at the previous nightly", () => {
    expect(nextRelease(["v0.1.10", "v0.1.11-nightly.20261020.5", "v0.1.11-nightly.20261021.7"], "nightly", nightly)).toEqual({
      version: "v0.1.11-nightly.20261027.42",
      previous: "v0.1.11-nightly.20261021.7",
    });
  });
});
