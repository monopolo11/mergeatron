import { Data, Effect, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

/**
 * Runs command line tools (`gh`, `git`, `launchctl`) as Effect child
 * processes: interrupting the fiber kills the process, output is collected
 * once it exits, and failures are typed instead of thrown.
 */

export type ExecOutput = { readonly stdout: string; readonly stderr: string; readonly exitCode: number };

/** The command could not be spawned, or (with `execOk`) exited non-zero; the message is stderr when there is any. */
export class CommandError extends Data.TaggedError("CommandError")<{ readonly command: string; readonly exitCode: number; readonly stderr: string }> {
  override get message(): string {
    return this.stderr || `${this.command} exited with ${this.exitCode}`;
  }
}

/** Runs the command to completion. A non-zero exit is a value here, so callers can read stderr and decide. */
export const exec = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string } = {},
): Effect.Effect<ExecOutput, CommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(command, [...args], options);
    const [stdout, stderr, exitCode] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: "unbounded" });
    return { stdout, stderr: stderr.trim(), exitCode: Number(exitCode) };
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => new CommandError({ command: [command, ...args].join(" "), exitCode: -1, stderr: error.message })),
    Effect.withSpan("exec", { attributes: { command } }),
  );

/** Like `exec`, but a non-zero exit fails with `CommandError` carrying stderr. */
export const execOk = (command: string, args: ReadonlyArray<string>, options: { readonly cwd?: string } = {}) =>
  exec(command, args, options).pipe(
    Effect.flatMap((output) =>
      output.exitCode === 0
        ? Effect.succeed(output)
        : Effect.fail(new CommandError({ command: [command, ...args].join(" "), exitCode: output.exitCode, stderr: output.stderr })),
    ),
  );

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => stream.pipe(Stream.decodeText, Stream.mkString);
