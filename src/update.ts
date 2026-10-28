import { Context, Data, Effect, Layer, Schedule, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { exec, execOk } from "./exec.ts";
import { logger } from "./log.ts";
import { LEGACY_SERVICE_LABEL, SERVICE_LABEL, type UpdateChannel } from "./shared.ts";
import { formatVersion, latestVersion, parseVersion, pickRelease, type ReleaseInfo } from "./version.ts";

const log = logger("update");

/** Repository root: the directory `index.ts` runs from. */
const root = join(import.meta.dir, "..");

/** How often the server fetches releases on its own; `GET /api/update?refresh=1` fetches now. */
const CHECK_INTERVAL = "30 minutes";

/**
 * How this process gets the new code running once it is checked out:
 * - `launchd`: exit non-zero; the agent's KeepAlive restarts it.
 * - `hot`: `bun --hot` reloads `index.ts` by itself when the checked out files land.
 * - `respawn`: plain `bun index.ts`; start a detached replacement, then exit.
 */
export type RestartMode = "launchd" | "hot" | "respawn";

/**
 * What the running code is:
 * - `release`: a clean checkout of a release tag; updates follow the channel.
 * - `main`: a clean checkout of `main` on no release, as installs from before
 *   releases are; it may move onto the latest stable that contains it.
 * - `development`: uncommitted changes, or a commit no release points at;
 *   never updated from the UI.
 */
export type Build = { kind: "release"; version: string } | { kind: "main" } | { kind: "development"; reason: "dirty" | "untagged" };

/** The release an update would check out, and what moving to it involves. */
export type UpdateTarget = ReleaseInfo & {
  /** It touches `drizzle/`; migrations run on the next start. */
  migrations: boolean;
  /** It touches `bun.lock`; `bun install` runs before the restart. */
  dependencies: boolean;
};

export type UpdateStatus = {
  build: Build;
  /** Short id of the commit the running process was started from. */
  commit: string;
  channel: UpdateChannel;
  /** Null when up to date, or when the build takes no updates. */
  target: UpdateTarget | null;
  restart: RestartMode;
  /** When releases were last fetched. */
  checkedAt: string;
};

export type UpdateResult = { from: string; to: string; restart: RestartMode };

/** The commit this process runs and, when `from` is an earlier one, what changed since. */
export type Changes = { current: string; release: Release | null };

/** What a restart brought: the commits between two runs and the contributors who had never committed before. */
export type Release = {
  /** Non-merge commits, newest first. `author` is a GitHub username when git knows one, else the author name. */
  commits: { sha: string; subject: string; author: string }[];
  /** Authors in `commits` with no commit before the earlier run. */
  newContributors: string[];
};

/** The check or the update could not be done; the message is shown in the UI. */
export class UpdateError extends Data.TaggedError("UpdateError")<{ readonly message: string }> {}

/** Pure part of the check, split out for tests: the release tags at the running commit, `git status` output and the checked out branch. */
export function describeBuild(git: { tags: readonly string[]; dirty: string; branch: string | null }): Build {
  if (git.dirty.trim()) return { kind: "development", reason: "dirty" };
  const version = latestVersion(git.tags);
  if (version) return { kind: "release", version: formatVersion(version) };
  return git.branch === "main" ? { kind: "main" } : { kind: "development", reason: "untagged" };
}

/** The release a build would update to on a channel. A `main` build only moves onto stable; the caller checks it is not ahead of it. */
export function targetFor(build: Build, channel: UpdateChannel, releases: readonly ReleaseInfo[]): ReleaseInfo | null {
  switch (build.kind) {
    case "release":
      return pickRelease(releases, channel, parseVersion(build.version));
    case "main":
      return pickRelease(releases, "stable", null);
    case "development":
      return null;
  }
}

/** The fields of `GET repos/{owner}/{repo}/releases` the check reads. */
const GitHubReleases = Schema.Array(
  Schema.Struct({ tag_name: Schema.String, html_url: Schema.String, prerelease: Schema.Boolean, draft: Schema.Boolean }),
);

/** What a fetch learns, cached between checks: the channel is applied when the status is read. */
type Facts = { build: Build; releases: ReleaseInfo[]; checkedAt: string };

/** GitHub username from a noreply address (`123+login@users.noreply.github.com`), else the commit's author name. */
function username(name: string, email: string): string {
  return /^(?:\d+\+)?(.+)@users\.noreply\.github\.com$/i.exec(email)?.[1] ?? name;
}

/** Pure part of `since`, split out for tests. Both inputs are tab-separated `name, email[, sha, subject]` lines. */
export function summarizeRelease(log: string, history: string): Release {
  const rows = (text: string) => text.split("\n").filter(Boolean).map((line) => line.split("\t"));
  const known = new Set(rows(history).map(([name = "", email = ""]) => username(name, email).toLowerCase()));
  const commits = rows(log).map(([name = "", email = "", sha = "", ...subject]) => ({ sha, subject: subject.join("\t"), author: username(name, email) }));
  const newContributors = [...new Set(commits.map((commit) => commit.author))].filter((author) => !known.has(author.toLowerCase()));
  return { commits, newContributors };
}

export type UpdaterShape = {
  /**
   * The running build and the release it would update to on `channel`. Reads
   * the releases fetched last (on start, then every CHECK_INTERVAL) unless
   * `refresh` asks to fetch now.
   */
  readonly status: (channel: UpdateChannel, options?: { readonly refresh?: boolean }) => Effect.Effect<UpdateStatus, UpdateError>;
  /**
   * Fetches, checks out the target release's tag and installs dependencies
   * when the lockfile moved. A failed checkout or install goes back to what
   * was checked out before. Migrations are not run here: `openDatabase`
   * applies them when the new code starts. Call `restart` once the HTTP
   * response is on its way.
   */
  readonly apply: (channel: UpdateChannel) => Effect.Effect<UpdateResult, UpdateError>;
  /**
   * The running commit and what it has over `from`, a commit an earlier run
   * started from. No release when `from` is absent, current, or unknown to
   * git (force push, another checkout). Works offline: it never fetches.
   */
  readonly since: (from: string | null) => Effect.Effect<Changes>;
  /** Gets the checked out code running. Never returns in `launchd` and `respawn` modes. */
  readonly restart: (mode: RestartMode) => Effect.Effect<void>;
};

/**
 * Remembers the commit this process loaded its code from, so the version and
 * the diff to a release are the running code's, not whatever HEAD is now.
 * Fetches tags and GitHub Releases (through `gh`) in the background on start
 * and on an interval. Detects once whether launchd owns this pid.
 */
const makeUpdater = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const provide = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner);
  const fail = (error: { readonly message: string }) => new UpdateError({ message: error.message });
  const run = (command: string, args: string[]) => execOk(command, args, { cwd: root }).pipe(provide, Effect.map((output) => output.stdout), Effect.mapError(fail));
  const git = (...args: string[]) => run("git", args);
  /** Exit code of a git command that answers with it (`merge-base --is-ancestor`, `symbolic-ref -q`). */
  const gitExit = (...args: string[]) => exec("git", args, { cwd: root }).pipe(provide, Effect.mapError(fail));
  const install = run("bun", ["install", "--frozen-lockfile"]);
  const running = (yield* git("rev-parse", "HEAD")).trim();

  const restartMode = yield* Effect.cached(
    Effect.gen(function* () {
      if (process.execArgv.includes("--hot")) return "hot" as const;
      if (process.platform === "darwin") {
        const uid = process.getuid?.() ?? 501;
        // The legacy label counts until `bun service.ts migrate` is run: its agent restarts this process too.
        for (const label of [SERVICE_LABEL, LEGACY_SERVICE_LABEL]) {
          const print = yield* exec("launchctl", ["print", `gui/${uid}/${label}`]).pipe(provide, Effect.orElseSucceed(() => null));
          if (print?.exitCode === 0 && new RegExp(`^\\s*pid = ${process.pid}$`, "m").test(print.stdout)) return "launchd" as const;
        }
      }
      return "respawn" as const;
    }),
  );

  /** Branch name, or null on a detached HEAD (a release checkout). */
  const branch = Effect.map(gitExit("symbolic-ref", "--quiet", "--short", "HEAD"), (output) => (output.exitCode === 0 ? output.stdout.trim() : null));

  const fetchFacts: Effect.Effect<Facts, UpdateError> = Effect.gen(function* () {
    // Releases are the source of truth: a tag moved upstream replaces the local one.
    yield* git("fetch", "--quiet", "--tags", "--force", "origin");
    const [json, tags, dirty, head] = yield* Effect.all(
      [run("gh", ["api", "repos/{owner}/{repo}/releases?per_page=100"]), git("tag", "--points-at", running), git("status", "--porcelain", "--untracked-files=no"), branch],
      { concurrency: "unbounded" },
    );
    const releases = (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubReleases))(json).pipe(Effect.mapError(() => new UpdateError({ message: "gh returned unexpected release data" }))))
      .filter((release) => !release.draft)
      .map((release): ReleaseInfo => ({ tag: release.tag_name, url: release.html_url, prerelease: release.prerelease }));
    return { build: describeBuild({ tags: tags.split("\n").filter(Boolean), dirty, branch: head }), releases, checkedAt: new Date().toISOString() };
  }).pipe(Effect.withSpan("update.fetch"));

  // The interval refreshes well inside the TTL. A failed fetch is dropped, so the next read tries again.
  const [cached, invalidate] = yield* Effect.cachedInvalidateWithTTL(fetchFacts, "1 hour");
  const cachedFacts = Effect.tapError(cached, () => invalidate);
  const refresh = Effect.andThen(invalidate, cachedFacts);
  yield* Effect.forkScoped(
    Effect.repeat(
      refresh.pipe(Effect.catch((error) => log.warn("update check failed", { error: error.message }))),
      { schedule: Schedule.spaced(CHECK_INTERVAL) },
    ),
  );

  /** Channel applied to fetched facts. A `main` build only moves onto a release that contains its commit, so it never goes back. */
  const resolve = (facts: Facts, channel: UpdateChannel) =>
    Effect.gen(function* () {
      const release = targetFor(facts.build, channel, facts.releases);
      const ahead = release && facts.build.kind === "main" && (yield* gitExit("merge-base", "--is-ancestor", running, `refs/tags/${release.tag}`)).exitCode !== 0;
      const files = release && !ahead ? (yield* git("diff", "--name-only", running, `refs/tags/${release.tag}`)).split("\n").filter(Boolean) : null;
      const status: UpdateStatus = {
        build: facts.build,
        commit: running.slice(0, 7),
        channel,
        target: release && files ? { ...release, migrations: files.some((file) => file.startsWith("drizzle/")), dependencies: files.includes("bun.lock") } : null,
        restart: yield* restartMode,
        checkedAt: facts.checkedAt,
      };
      return status;
    });

  const status: UpdaterShape["status"] = (channel, options) =>
    Effect.flatMap(options?.refresh ? refresh : cachedFacts, (facts) => resolve(facts, channel)).pipe(Effect.withSpan("update.status"));

  const apply: UpdaterShape["apply"] = (channel) =>
    Effect.gen(function* () {
      const { build, target, restart } = yield* status(channel, { refresh: true });
      if (build.kind === "development") return yield* Effect.fail(new UpdateError({ message: build.reason === "dirty" ? "checkout has uncommitted changes; commit or discard them first" : "development build: not on a release, update it with git" }));
      if (!target) return yield* Effect.fail(new UpdateError({ message: "already up to date" }));
      // A branch name puts a `main` checkout back on its branch; a release goes back to its commit.
      const previous = (yield* branch) ?? (yield* git("rev-parse", "HEAD")).trim();
      const lockfileMoved = (yield* gitExit("diff", "--quiet", "HEAD", `refs/tags/${target.tag}`, "--", "bun.lock")).exitCode !== 0;
      const rollback = (error: UpdateError) =>
        Effect.gen(function* () {
          yield* log.warn("update failed, rolling back", { to: target.tag, back: previous, error: error.message });
          yield* git("checkout", "--quiet", previous);
          if (lockfileMoved) yield* install;
          return yield* Effect.fail(new UpdateError({ message: `update to ${target.tag} failed and was rolled back: ${error.message}` }));
        });
      yield* git("checkout", "--quiet", "--detach", `refs/tags/${target.tag}`).pipe(Effect.andThen(lockfileMoved ? install : Effect.void), Effect.catch(rollback));
      return { from: build.kind === "release" ? build.version : running.slice(0, 7), to: target.tag, restart };
    }).pipe(Effect.withSpan("update.apply"));

  const since: UpdaterShape["since"] = (from) =>
    Effect.gen(function* () {
      const current = running.slice(0, 7);
      // `from` comes from the query string and ends up in git's argv: only a bare commit id is accepted.
      if (!from || !/^[0-9a-f]{7,40}$/i.test(from) || running.startsWith(from.toLowerCase())) return { current, release: null };
      const [log, history] = yield* Effect.all(
        [git("log", "--no-merges", "--format=%aN%x09%aE%x09%h%x09%s", `${from}..${running}`), git("log", "--no-merges", "--format=%aN%x09%aE", from)],
        { concurrency: "unbounded" },
      );
      return { current, release: summarizeRelease(log, history) };
    }).pipe(
      Effect.orElseSucceed(() => ({ current: running.slice(0, 7), release: null })),
      Effect.withSpan("update.since"),
    );

  const shape: UpdaterShape = {
    status,
    apply,
    since,
    restart: (mode) =>
      Effect.gen(function* () {
        yield* log.info("restarting", { mode });
        restart(mode);
      }),
  };
  return shape;
});

function restart(mode: RestartMode): void {
  if (mode === "hot") return;
  if (mode === "respawn") {
    // Give this process a moment to release the port before the replacement binds it.
    const child = spawn("/bin/sh", ["-c", 'sleep 1; exec "$0" "$@"', process.execPath, ...process.execArgv, Bun.main], {
      cwd: root,
      detached: true,
      stdio: "inherit",
    });
    child.unref();
    process.exit(0);
  }
  // KeepAlive.SuccessfulExit is false in the agent plist: only a non-zero exit is restarted.
  process.exit(1);
}

export class Updater extends Context.Service<Updater, UpdaterShape>()("Updater") {
  static readonly layer = Layer.effect(this, makeUpdater);
}
