/**
 * Runs the orchestrator as a macOS launchd user agent: starts at login and is
 * restarted by launchd whenever it exits with a non-zero status (a crash).
 *
 *   bun service.ts install     write the agent plist and start it now
 *   bun service.ts uninstall   stop it and remove the plist
 *   bun service.ts restart     stop the running process; launchd starts it again
 *   bun service.ts status      launchd's view of the agent (pid, last exit status)
 *   bun service.ts logs        tail the service log
 *
 * The agent runs `bun index.ts` from this directory, so `.env` and the default
 * `data/` path resolve exactly as they do when run by hand. `install` also copies
 * SSL_CERT_FILE / NODE_EXTRA_CA_CERTS into the plist; re-run it when they change.
 */
import { BunChildProcessSpawner, BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Data, Effect, FileSystem, Layer, Schedule, type PlatformError } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { exec, execOk } from "./src/exec.ts";
import { SERVICE_LABEL as LABEL } from "./src/shared.ts";

const projectDir = import.meta.dir;
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const logDir = join(homedir(), "Library", "Logs", "t3-review-orchestrator");
const logPath = join(logDir, "orchestrator.log");
const domain = `gui/${process.getuid?.() ?? 501}`;

/** A command cannot proceed; printed as is, without a stack. */
class ServiceError extends Data.TaggedError("ServiceError")<{ readonly message: string }> {}

/**
 * CA bundle variables Bun reads at startup. launchd starts the agent with none of
 * the shell's environment, so behind a TLS-inspecting proxy these must be baked
 * into the plist or Slack never gets past "connecting". Taken from the installing
 * shell, or from `.env` (Bun loads it when running this script from the project).
 */
const CA_ENV_KEYS = ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"] as const;

function caCertEnv(): Record<string, string> {
  return Object.fromEntries(
    CA_ENV_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value ? [[key, value]] : [];
    }),
  );
}

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

/** Serialises a plain object to XML plist. Only the types launchd needs. */
function plist(value: PlistValue, indent = "\t"): string {
  if (typeof value === "string") return `${indent}<string>${Bun.escapeHTML(value)}</string>`;
  if (typeof value === "number") return `${indent}<integer>${value}</integer>`;
  if (typeof value === "boolean") return `${indent}<${value}/>`;
  if (Array.isArray(value)) {
    return [`${indent}<array>`, ...value.map((v) => plist(v, `${indent}\t`)), `${indent}</array>`].join("\n");
  }
  const entries = Object.entries(value).flatMap(([key, v]) => [
    `${indent}\t<key>${Bun.escapeHTML(key)}</key>`,
    plist(v, `${indent}\t`),
  ]);
  return [`${indent}<dict>`, ...entries, `${indent}</dict>`].join("\n");
}

function agentPlist(): string {
  const bunPath = process.execPath;
  const definition: PlistValue = {
    Label: LABEL,
    ProgramArguments: [bunPath, "index.ts"],
    WorkingDirectory: projectDir,
    RunAtLoad: true,
    // Restart only after an unclean exit. `uninstall`/`launchctl bootout` stop it for good.
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 10,
    StandardOutPath: logPath,
    StandardErrorPath: logPath,
    EnvironmentVariables: {
      NODE_ENV: "production",
      HOME: homedir(),
      PATH: [dirname(bunPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      ...caCertEnv(),
    },
  };
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    plist(definition, ""),
    `</plist>`,
    "",
  ].join("\n");
}

const launchctl = (...args: string[]) => execOk("launchctl", args).pipe(Effect.mapError((error) => new ServiceError({ message: error.message })));

const isLoaded = Effect.map(exec("launchctl", ["print", `${domain}/${LABEL}`]), (output) => output.exitCode === 0).pipe(Effect.orElseSucceed(() => false));

/** `launchctl bootout` returns before the agent is gone; bootstrapping too early fails with I/O error 5. */
const bootoutAndWait = Effect.gen(function* () {
  yield* launchctl("bootout", `${domain}/${LABEL}`);
  // Up to 50 checks, 100ms apart.
  yield* isLoaded.pipe(Effect.repeat({ schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ times: 50 })), while: (loaded) => loaded }));
});

const install = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(join(projectDir, ".env")))) {
    yield* Console.warn("No .env in project directory; the service will exit until T3_TOKEN is set (see README).");
  }
  const caEnv = caCertEnv();
  for (const [key, path] of Object.entries(caEnv)) {
    if (!(yield* fs.exists(path))) return yield* Effect.fail(new ServiceError({ message: `${key} points to a missing file: ${path}` }));
  }
  yield* fs.makeDirectory(dirname(plistPath), { recursive: true });
  yield* fs.makeDirectory(logDir, { recursive: true });
  yield* fs.writeFileString(plistPath, agentPlist());
  if (yield* isLoaded) yield* bootoutAndWait;
  yield* launchctl("bootstrap", domain, plistPath);
  const caLine = Object.entries(caEnv)
    .map(([key, path]) => `  ${key.toLowerCase().replaceAll("_", " ")} ${path}`)
    .join("\n");
  yield* Console.log(
    [`Installed ${LABEL}`, `  plist ${plistPath}`, `  logs  ${logPath}`, caLine || "  no CA bundle baked in (SSL_CERT_FILE / NODE_EXTRA_CA_CERTS unset)"].join("\n"),
  );
});

const uninstall = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (yield* isLoaded) yield* launchctl("bootout", `${domain}/${LABEL}`);
  if (yield* fs.exists(plistPath)) yield* fs.remove(plistPath);
  yield* Console.log(`Removed ${LABEL}`);
});

const restart = Effect.gen(function* () {
  if (!(yield* isLoaded)) return yield* Effect.fail(new ServiceError({ message: `${LABEL} is not installed; run: bun service.ts install` }));
  yield* launchctl("kickstart", "-k", `${domain}/${LABEL}`);
  yield* Console.log(`Restarted ${LABEL}`);
});

const status = Effect.gen(function* () {
  if (!(yield* isLoaded)) return yield* Console.log(`${LABEL} is not installed`);
  const out = (yield* launchctl("print", `${domain}/${LABEL}`)).stdout;
  const lines = out.split("\n").filter((line) => /^\t(state|pid|last exit code|last terminating signal) = /.test(line));
  yield* Console.log([LABEL, ...lines.map((line) => `  ${line.trim()}`), `  logs = ${logPath}`].join("\n"));
});

/** Streams the log to this terminal until interrupted. */
const logs = Effect.scoped(Effect.flatMap(ChildProcess.make("tail", ["-n", "50", "-f", logPath], { stdout: "inherit", stderr: "inherit" }), (handle) => handle.exitCode));

const commands = { install, uninstall, restart, status, logs };
const command = process.argv[2] as keyof typeof commands | undefined;

if (process.platform !== "darwin") {
  console.error("service.ts manages a launchd agent and only works on macOS.");
  process.exit(1);
}
if (!command || !(command in commands)) {
  console.error(`usage: bun service.ts <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}

const program: Effect.Effect<unknown, ServiceError | PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> = commands[command];

BunRuntime.runMain(
  program.pipe(
    Effect.asVoid,
    Effect.catch((error) => Effect.andThen(Console.error(error.message), Effect.sync(() => process.exit(1)))),
    Effect.provide(Layer.mergeAll(BunServices.layer, BunChildProcessSpawner.layer.pipe(Layer.provide(BunServices.layer)))),
  ),
);
