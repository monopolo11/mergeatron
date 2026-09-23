import { spawn } from "node:child_process";
import { join } from "node:path";
import { $ } from "bun";
import { SERVICE_LABEL } from "./shared.ts";

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
  current: string;
  latest: string;
  /** Commits on upstream that are not here yet, newest first. */
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

const run = (...args: string[]) => $`git ${args}`.cwd(root).text();

/** Fetches the tracked upstream and reports what a fast-forward would bring. */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const upstream = (await run("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")).trim();
  const [remote, ...branch] = upstream.split("/");
  await $`git fetch --quiet ${remote} ${branch.join("/")}`.cwd(root).quiet();
  const [current, latest, log, changedFiles, dirty] = await Promise.all([
    run("rev-parse", "HEAD"),
    run("rev-parse", upstream),
    run("log", "--format=%h %s", "HEAD..@{u}"),
    run("diff", "--name-only", "HEAD...@{u}"),
    run("status", "--porcelain", "--untracked-files=no"),
  ]);
  return summarize({ upstream, current: current.trim(), latest: latest.trim(), log, changedFiles, dirty }, await restartMode());
}

/**
 * Fast-forwards to upstream and installs dependencies when the lockfile moved.
 * Migrations are not run here: `openDatabase` applies them when the new code
 * starts. Call `restart` once the HTTP response is on its way.
 */
export async function applyUpdate(): Promise<UpdateResult> {
  const status = await checkForUpdate();
  if (status.dirty) throw new Error("checkout has uncommitted changes; commit or discard them first");
  if (status.commits.length === 0) throw new Error("already up to date");
  await $`git pull --ff-only --quiet`.cwd(root).quiet();
  if (status.dependencies) await $`bun install --frozen-lockfile`.cwd(root).quiet();
  return { from: status.current, to: status.latest, restart: status.restart };
}

/** Gets the pulled code running. Never returns in `launchd` and `respawn` modes. */
export function restart(mode: RestartMode): void {
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

let detectedRestartMode: Promise<RestartMode> | null = null;

/** Detected once: launchd owns this pid, or `--hot` is on, or neither. */
export function restartMode(): Promise<RestartMode> {
  return (detectedRestartMode ??= detect());
}

async function detect(): Promise<RestartMode> {
  if (process.execArgv.includes("--hot")) return "hot";
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 501;
    const print = await $`launchctl print gui/${uid}/${SERVICE_LABEL}`.quiet().nothrow();
    if (print.exitCode === 0 && new RegExp(`^\\s*pid = ${process.pid}$`, "m").test(print.stdout.toString())) return "launchd";
  }
  return "respawn";
}
