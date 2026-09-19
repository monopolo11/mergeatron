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
 * `data/` path resolve exactly as they do when run by hand.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { $ } from "bun";

const LABEL = "com.t3.review-orchestrator";
const projectDir = import.meta.dir;
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const logDir = join(homedir(), "Library", "Logs", "t3-review-orchestrator");
const logPath = join(logDir, "orchestrator.log");
const domain = `gui/${process.getuid?.() ?? 501}`;

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

async function isLoaded(): Promise<boolean> {
  return (await $`launchctl print ${domain}/${LABEL}`.quiet().nothrow()).exitCode === 0;
}

async function install() {
  if (!(await Bun.file(join(projectDir, ".env")).exists())) {
    console.warn("No .env in project directory; the service will exit until T3_TOKEN is set (see README).");
  }
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  await Bun.write(plistPath, agentPlist());
  if (await isLoaded()) await $`launchctl bootout ${domain}/${LABEL}`.quiet();
  await $`launchctl bootstrap ${domain} ${plistPath}`;
  console.log(`Installed ${LABEL}\n  plist ${plistPath}\n  logs  ${logPath}`);
}

async function uninstall() {
  if (await isLoaded()) await $`launchctl bootout ${domain}/${LABEL}`;
  const file = Bun.file(plistPath);
  if (await file.exists()) await file.delete();
  console.log(`Removed ${LABEL}`);
}

async function restart() {
  if (!(await isLoaded())) throw new Error(`${LABEL} is not installed; run: bun service.ts install`);
  await $`launchctl kickstart -k ${domain}/${LABEL}`;
  console.log(`Restarted ${LABEL}`);
}

async function status() {
  if (!(await isLoaded())) {
    console.log(`${LABEL} is not installed`);
    return;
  }
  const out = await $`launchctl print ${domain}/${LABEL}`.text();
  const lines = out.split("\n").filter((line) => /^\t(state|pid|last exit code|last terminating signal) = /.test(line));
  console.log([LABEL, ...lines.map((line) => `  ${line.trim()}`), `  logs = ${logPath}`].join("\n"));
}

async function logs() {
  await $`tail -n 50 -f ${logPath}`;
}

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
try {
  await commands[command]();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
