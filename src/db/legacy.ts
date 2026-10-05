import { Database as Sqlite } from "bun:sqlite";
import { Effect } from "effect";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { StartupError } from "../config.ts";
import { logger } from "../log.ts";

const log = logger("db");

/**
 * First start after the move to `~/.mergeatron`: copies the database from where
 * earlier versions kept it. A no-op once the target exists or when there is no
 * old file. It is a copy, not a move, so the old file stays as a backup; the
 * copy goes through `VACUUM INTO`, which reads the WAL, so it is consistent
 * even if the old process did not shut down cleanly. A failed copy stops the
 * start: opening an empty database instead would look like lost data.
 */
export const copyLegacyDatabase = Effect.fn("copyLegacyDatabase")(function* (legacyPath: string, targetPath: string) {
  if (existsSync(targetPath) || !existsSync(legacyPath)) return;
  const partial = `${targetPath}.copying`;
  yield* Effect.try({
    try: () => {
      mkdirSync(dirname(targetPath), { recursive: true });
      rmSync(partial, { force: true });
      const source = new Sqlite(legacyPath);
      try {
        source.run("VACUUM INTO ?", [partial]);
      } finally {
        source.close();
      }
      renameSync(partial, targetPath);
    },
    catch: (error) => new StartupError({ message: `Could not copy the database from ${legacyPath} to ${targetPath}: ${error instanceof Error ? error.message : String(error)}` }),
  });
  yield* log.info("copied database to its new location; the old file is left in place and can be deleted", { from: legacyPath, to: targetPath });
});
