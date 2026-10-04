import { Database as Sqlite } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Context, Effect, Layer } from "effect";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import * as schema from "./schema.ts";

/** Opens (creating if needed) the SQLite file and applies pending migrations from ./drizzle. */
export function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Sqlite(path, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  // After migrating: SQLite rebuilds tables to alter them, and dropping a
  // referenced table with foreign keys on would cascade into its children.
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export type AppDatabase = ReturnType<typeof openDatabase>;

/** The Drizzle handle, opened for the life of the layer and closed when it is released. */
export class Database extends Context.Service<Database, AppDatabase>()("Database") {
  /** Pass `:memory:` for a throwaway database. */
  static readonly layer = (path: string) =>
    Layer.effect(
      this,
      Effect.acquireRelease(
        Effect.sync(() => openDatabase(path)),
        (db) => Effect.sync(() => db.$client.close()),
      ),
    );
}
