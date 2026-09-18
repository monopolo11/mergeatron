import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import * as schema from "./schema.ts";

/** Opens (creating if needed) the SQLite file and applies pending migrations from ./drizzle. */
export function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  return db;
}

export type AppDatabase = ReturnType<typeof openDatabase>;
