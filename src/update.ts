import { Context, Data, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { exec, execOk } from "./exec.ts";
import { logger } from "./log.ts";
import { LEGACY_SERVICE_LABEL, SERVICE_LABEL } from "./shared.ts";

const log = logger("update");

/** Repository root: the directory `index.ts` runs from. */
const root = join(import.meta.dir, "..");

/**
 * How this process gets the new code running once it is pulled:
 * - `launchd`: exit non-zero; the agent's KeepAlive restarts it.
 * - `hot`: `bun --hot` reloads `index.ts` by itself when the pulled files land.
 * - `respawn`: plain `bun index.ts`; start a detached replacement, then exit.
 */
export type RestartMode = "launchd" | "hot" | "respawn";

export type UpdateStatus = {
  /** Upstream the checkout tracks, e.g. `origin/main`. */
  upstream: string;
  /** Commit the running process was started from. */
  current: string;
  latest: string;
  /** Commits on upstream the running process lacks, newest first; some may already be pulled. */
  commits: { sha: string; subject: string }[];
  /** The update touches `drizzle/`; migrations run on the next start. */
  migrations: boolean;
  /** The update touches `bun.lock`; `bun install` runs before the restart. */
  dependencies: boolean;
  /** Uncommitted tracked changes block a fast-forward. */
  dirty: boolean;
  restart: RestartMode;
  checkedAt: string;
};

export type UpdateResult = { from: string; to: string; restart: RestartMode };

/** The check or the update could not be done; the message is shown in the UI. */
export class UpdateError extends Data.TaggedError("UpdateError")<{ readonly message: string }> {}

/** Pure part of the check, split out for tests: git outputs in, status out. */
export function summarize(
  git: { upstream: string; current: string; latest: string; log: string; changedFiles: string; dirty: string },
  restart: RestartMode,
  now = new Date(),
): UpdateStatus {
  const commits = git.log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", ...rest] = line.split(" ");
      return { sha, subject: rest.join(" ") };
    });
  const files = git.changedFiles.split("\n").filter(Boolean);
  return {
    upstream: git.upstream,
    current: git.current.slice(0, 7),
    latest: git.latest.slice(0, 7),
    commits,
    migrations: files.some((file) => file.startsWith("drizzle/")),
    dependencies: files.includes("bun.lock"),
    dirty: git.dirty.trim().length > 0,
    restart,
    checkedAt: now.toISOString(),
  };
}

export type UpdaterShape = {
  /** Fetches the tracked upstream and reports what updating the running process would bring. */
  readonly check: Effect.Effect<UpdateStatus, UpdateError>;
  /**
   * Fast-forwards to the upstream just fetched (a no-op when the checkout was
   * pulled already) and installs dependencies when the lockfile moved.
   * Migrations are not run here: `openDatabase` applies them when the new code
   * starts. Call `restart` once the HTTP response is on its way.
   */
  readonly apply: Effect.Effect<UpdateResult, UpdateError>;
  /** Gets the pulled code running. Never returns in `launchd` and `respawn` modes. */
  readonly restart: (mode: RestartMode) => Effect.Effect<void>;
};

/**
 * Remembers the commit this process loaded its code from, so updates compare
 * against it rather than the checkout's HEAD: a pull made outside the UI
 * still offers a restart. Detects once whether launchd owns this pid.
 */
const makeUpdater = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const provide = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner);
  const git = (...args: string[]) =>
    execOk("git", args, { cwd: root }).pipe(
      provide,
      Effect.map((output) => output.stdout),
      Effect.mapError((error) => new UpdateError({ message: error.message })),
    );
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

  const check: UpdaterShape["check"] = Effect.gen(function* () {
    const upstream = (yield* git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")).trim();
    const [remote, ...branch] = upstream.split("/");
    yield* git("fetch", "--quiet", remote ?? "origin", branch.join("/"));
    const [latest, logLines, changedFiles, dirty, restart] = yield* Effect.all(
      [
        git("rev-parse", upstream),
        git("log", "--format=%h %s", `${running}..@{u}`),
        git("diff", "--name-only", `${running}...@{u}`),
        git("status", "--porcelain", "--untracked-files=no"),
        restartMode,
      ],
      { concurrency: "unbounded" },
    );
    return summarize({ upstream, current: running, latest: latest.trim(), log: logLines, changedFiles, dirty }, restart);
  }).pipe(Effect.withSpan("update.check"));

  const apply: UpdaterShape["apply"] = Effect.gen(function* () {
    const status = yield* check;
    if (status.dirty) return yield* Effect.fail(new UpdateError({ message: "checkout has uncommitted changes; commit or discard them first" }));
    if (status.commits.length === 0) return yield* Effect.fail(new UpdateError({ message: "already up to date" }));
    yield* git("merge", "--ff-only", "--quiet", "@{u}");
    if (status.dependencies) {
      yield* execOk("bun", ["install", "--frozen-lockfile"], { cwd: root }).pipe(provide, Effect.mapError((error) => new UpdateError({ message: error.message })));
    }
    return { from: status.current, to: status.latest, restart: status.restart };
  }).pipe(Effect.withSpan("update.apply"));

  const shape: UpdaterShape = {
    check,
    apply,
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
