import type { UpdateChannel } from "./shared.ts";

/**
 * Release versions, shared by the update check (update.ts) and the release
 * workflow (scripts/release-version.ts). Two tag shapes exist: stable
 * `vX.Y.Z`, and nightly `vX.Y.Z-nightly.YYYYMMDD.RUN`, a prerelease of the
 * next stable. Any other tag is not a release and is ignored.
 */
export type Version = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Build date (`YYYYMMDD`) and workflow run number of a nightly; null for a stable. */
  readonly nightly: { readonly date: number; readonly run: number } | null;
};

/** A published GitHub Release, as the update check sees it. */
export type ReleaseInfo = { tag: string; url: string; prerelease: boolean };

const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d{8})\.(\d+))?$/;

export function parseVersion(tag: string): Version | null {
  const match = TAG.exec(tag.trim());
  if (!match) return null;
  const [, major, minor, patch, date, run] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch), nightly: date && run ? { date: Number(date), run: Number(run) } : null };
}

export function formatVersion({ major, minor, patch, nightly }: Version): string {
  return `v${major}.${minor}.${patch}${nightly ? `-nightly.${nightly.date}.${nightly.run}` : ""}`;
}

/** Semver order: a nightly sorts below the stable of the same `X.Y.Z`, nightlies by date then run. */
export function compareVersions(a: Version, b: Version): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    (a.nightly ? (b.nightly ? a.nightly.date - b.nightly.date || a.nightly.run - b.nightly.run : -1) : b.nightly ? 1 : 0)
  );
}

/** The highest release among tags, or null; tags that are not releases are skipped. With several tags on one commit, a stable beats its nightly. */
export function latestVersion(tags: Iterable<string>, accept: (version: Version) => boolean = () => true): Version | null {
  let best: Version | null = null;
  for (const tag of tags) {
    const version = parseVersion(tag);
    if (version && accept(version) && (!best || compareVersions(version, best) > 0)) best = version;
  }
  return best;
}

/**
 * The release to update to. Stable sees stable releases only; nightly sees
 * both and takes the highest, so a nightly install rolls onto a stable that
 * passes it. Never a downgrade: with `current`, only a strictly newer release
 * is returned, so leaving nightly for stable waits for a newer stable.
 */
export function pickRelease(releases: readonly ReleaseInfo[], channel: UpdateChannel, current: Version | null): ReleaseInfo | null {
  let best: { release: ReleaseInfo; version: Version } | null = null;
  for (const release of releases) {
    const version = parseVersion(release.tag);
    if (!version) continue;
    if (channel === "stable" && (release.prerelease || version.nightly)) continue;
    if (current && compareVersions(version, current) <= 0) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { release, version };
  }
  return best?.release ?? null;
}

/**
 * What the release workflow publishes next, from the repository's tags.
 * Stable is a patch bump of the latest stable (`v0.1.0` when there is none);
 * nightly is a prerelease of that same next stable. `previous` is the tag the
 * release notes start from: the latest of the same channel.
 */
export function nextRelease(tags: readonly string[], channel: UpdateChannel, nightly: { date: Date; run: number }): { version: string; previous: string | null } {
  const stable = latestVersion(tags, (version) => !version.nightly);
  const next: Version = stable ? { ...stable, patch: stable.patch + 1 } : { major: 0, minor: 1, patch: 0, nightly: null };
  if (channel === "stable") return { version: formatVersion(next), previous: stable && formatVersion(stable) };
  const date = Number(nightly.date.toISOString().slice(0, 10).replaceAll("-", ""));
  const previous = latestVersion(tags, (version) => version.nightly !== null);
  return { version: formatVersion({ ...next, nightly: { date, run: nightly.run } }), previous: previous && formatVersion(previous) };
}
