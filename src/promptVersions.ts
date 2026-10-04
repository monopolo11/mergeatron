import { Data, Effect } from "effect";
import { logger } from "./log.ts";
import type { Prompt, PromptVersion, PromptVersionInput, Rule } from "./rules.ts";
import type { PromptOwner, PromptVersionSource } from "./shared.ts";
import { Store } from "./store.ts";

const log = logger("prompts");

/** The preset, rule or version asked for does not exist. */
export class PromptNotFoundError extends Data.TaggedError("PromptNotFoundError")<{ readonly message: string }> {}

/** A preset or rule prompt without its text: which version runs, and the newest saved. */
export type PromptSummary = {
  owner: PromptOwner;
  id: string;
  name: string;
  liveVersion: number;
  latestVersion: number;
  /** Rules only: the preset whose live body replaces the rule's own prompt when it runs. */
  presetId: string | null;
};

/** A prompt with every version, newest first. */
export type PromptHistory = PromptSummary & { versions: PromptVersion[] };

/**
 * Versioned prompts behind the HTTP API and the MCP tools: dispatch presets
 * and each rule's own prompt. Saving appends a version; runs use the promoted
 * (live) one, so a draft can be saved, read back and promoted later.
 */

const notFound = (owner: PromptOwner, id: string, version?: number) =>
  new PromptNotFoundError({ message: `No ${owner} ${id}${version === undefined ? "" : ` with version ${version}`}.` });

const presetSummary = (preset: Prompt, latestVersion: number): PromptSummary => ({
  owner: "preset",
  id: preset.id,
  name: preset.name,
  liveVersion: preset.liveVersion,
  latestVersion,
  presetId: null,
});

const ruleSummary = (rule: Rule, latestVersion: number): PromptSummary => ({
  owner: "rule",
  id: rule.id,
  name: rule.name,
  liveVersion: rule.livePromptVersion,
  latestVersion,
  presetId: rule.presetId,
});

/** A preset with its newest version number, for the preset list: newer than `liveVersion` means a draft waits. */
export type PresetWithLatest = Prompt & { latestVersion: number };

export const listPresets = Effect.fn("prompts.listPresets")(function* () {
  const store = yield* Store;
  const latest = yield* store.latestPromptVersions();
  return (yield* store.listPrompts()).map((preset): PresetWithLatest => ({ ...preset, latestVersion: latest.get(`preset:${preset.id}`) ?? preset.liveVersion }));
});

/** Every preset, then every rule. */
export const listPrompts = Effect.fn("prompts.list")(function* () {
  const store = yield* Store;
  const latest = yield* store.latestPromptVersions();
  return [
    ...(yield* store.listPrompts()).map((preset) => presetSummary(preset, latest.get(`preset:${preset.id}`) ?? preset.liveVersion)),
    ...(yield* store.listRules()).map((rule) => ruleSummary(rule, latest.get(`rule:${rule.id}`) ?? rule.livePromptVersion)),
  ];
});

export const readPrompt = Effect.fn("prompts.read")(function* (owner: PromptOwner, id: string) {
  const store = yield* Store;
  const versions = yield* store.listPromptVersions(owner, id);
  const latest = versions[0]?.version ?? 1;
  const preset = owner === "preset" ? yield* store.getPrompt(id) : null;
  const rule = owner === "rule" ? yield* store.getRule(id) : null;
  const summary = preset ? presetSummary(preset, latest) : rule ? ruleSummary(rule, latest) : null;
  if (!summary) return yield* Effect.fail(notFound(owner, id));
  const history: PromptHistory = { ...summary, versions };
  return history;
});

/** Appends a version (see Store.createPromptVersion), promoting it when `promote` is set. */
export const createVersion = Effect.fn("prompts.createVersion")(function* (
  owner: PromptOwner,
  id: string,
  { promote, ...input }: PromptVersionInput,
  source: PromptVersionSource,
) {
  const store = yield* Store;
  const version = yield* store.createPromptVersion(owner, id, { ...input, source }, promote);
  if (!version) return yield* Effect.fail(notFound(owner, id));
  yield* log.info("version saved", { owner, id, version: version.version, promote, source });
  return version;
});

export const promoteVersion = Effect.fn("prompts.promote")(function* (owner: PromptOwner, id: string, version: number) {
  const store = yield* Store;
  const promoted = yield* store.promotePromptVersion(owner, id, version);
  if (!promoted) return yield* Effect.fail(notFound(owner, id, version));
  yield* log.info("version promoted", { owner, id, version });
  return promoted;
});
