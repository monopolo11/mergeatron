/**
 * Prints the next release for the release workflow, as `GITHUB_OUTPUT` lines:
 *
 *   bun scripts/release-version.ts stable
 *   bun scripts/release-version.ts nightly <run_number>
 *
 * `version=` is the tag to publish, `previous=` the tag its notes start from
 * (empty for the first of a channel). Reads the tags of the checkout it runs in.
 */
import { $ } from "bun";
import { UPDATE_CHANNELS } from "../src/shared.ts";
import { nextRelease } from "../src/version.ts";

const channel = UPDATE_CHANNELS.find((candidate) => candidate === process.argv[2]);
const run = Number(process.argv[3] ?? 0);
if (!channel) {
  console.error(`usage: bun scripts/release-version.ts ${UPDATE_CHANNELS.join("|")} [run_number]`);
  process.exit(2);
}
const tags = (await $`git tag --list ${"v*"}`.text()).split("\n").filter(Boolean);
const { version, previous } = nextRelease(tags, channel, { date: new Date(), run });
console.log(`version=${version}\nprevious=${previous ?? ""}`);
