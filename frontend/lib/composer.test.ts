import { describe, expect, test } from "bun:test";
import type { T3Provider, T3Skill } from "../../src/t3.ts";
import { detectTrigger, providerSkills, searchSkills, skillLabel, splitSkills } from "./composer";

const skill = (name: string, extra: Partial<T3Skill> = {}): T3Skill => ({ name, displayName: null, description: null, scope: "user", path: `/skills/${name}`, ...extra });

describe("detectTrigger", () => {
  test("/ opens only at the start of a line, until a space", () => {
    expect(detectTrigger("/rev")).toEqual({ kind: "slash", query: "rev", start: 0 });
    expect(detectTrigger("see /rev")).toBeNull();
    expect(detectTrigger("/review now")).toBeNull();
  });

  test("$ opens at the start of any token", () => {
    expect(detectTrigger("run $code")).toEqual({ kind: "skill", query: "code", start: 4 });
    expect(detectTrigger("$")).toEqual({ kind: "skill", query: "", start: 0 });
    expect(detectTrigger("a$b")).toBeNull();
  });

  test("a chip before the caret is not a token boundary", () => {
    expect(detectTrigger("￼$x")).toBeNull();
  });
});

describe("splitSkills", () => {
  const skills = [skill("code-review")];

  test("chips known skills only, and not amounts", () => {
    expect(splitSkills("use $code-review then $other for $5", skills)).toEqual(["use ", skills[0]!, " then $other for $5"]);
  });

  test("a token must stand alone", () => {
    expect(splitSkills("$code-review.", skills)).toEqual(["$code-review."]);
    expect(splitSkills("$code-review", skills)).toEqual([skills[0]!]);
  });
});

test("providerSkills keeps one skill per name from enabled providers", () => {
  const provider = (enabled: boolean, skills: T3Skill[]) => ({ enabled, skills }) as T3Provider;
  const names = providerSkills([provider(true, [skill("a"), skill("b")]), provider(true, [skill("A")]), provider(false, [skill("c")])]).map((s) => s.name);
  expect(names).toEqual(["a", "b"]);
});

test("skillLabel title-cases the name unless there is a display name", () => {
  expect(skillLabel(skill("code-review"))).toBe("Code Review");
  expect(skillLabel(skill("x", { displayName: "PR review" }))).toBe("PR review");
});

describe("searchSkills", () => {
  const skills = [skill("babysit-pr", { description: "Monitor a pull request" }), skill("file-pr"), skill("code-review", { description: "Review a branch" })];
  const names = (kind: "slash" | "skill", query: string) => searchSkills(skills, { kind, query }).map((s) => s.name);

  test("ranks name matches over description matches", () => {
    expect(names("skill", "review")).toEqual(["code-review"]);
    expect(names("skill", "pr")).toEqual(["file-pr", "babysit-pr"]);
    expect(names("skill", "pull")).toEqual(["babysit-pr"]);
  });

  test("an empty query lists everything", () => {
    expect(names("skill", "")).toHaveLength(3);
  });

  test("under / a skill also answers to skill:", () => {
    expect(names("slash", "skill:file")).toEqual(["file-pr"]);
    expect(names("slash", "ski")).toHaveLength(3);
  });
});
