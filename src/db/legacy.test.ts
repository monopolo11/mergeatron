import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyLegacyDatabase } from "./legacy.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "mergeatron-db-"));

function seed(path: string, value: string) {
  const db = new Sqlite(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT);");
  db.run("INSERT INTO t VALUES (?)", [value]);
  return db;
}

const read = (path: string) => {
  const db = new Sqlite(path, { readonly: true });
  const rows = db.query("SELECT v FROM t").all();
  db.close();
  return rows;
};

test("copies the legacy database, WAL contents included, and keeps the original", async () => {
  const dir = tempDir();
  const legacy = join(dir, "orchestrator.sqlite");
  const target = join(dir, "home", "data", "mergeatron.sqlite");
  const open = seed(legacy, "kept"); // left open: its rows are still only in the WAL
  await Effect.runPromise(copyLegacyDatabase(legacy, target));
  open.close();
  expect(read(target)).toEqual([{ v: "kept" }]);
  expect(existsSync(legacy)).toBe(true);
});

test("leaves an existing target alone", async () => {
  const dir = tempDir();
  const legacy = join(dir, "orchestrator.sqlite");
  const target = join(dir, "mergeatron.sqlite");
  seed(legacy, "old").close();
  seed(target, "new").close();
  await Effect.runPromise(copyLegacyDatabase(legacy, target));
  expect(read(target)).toEqual([{ v: "new" }]);
});

test("does nothing without a legacy database", async () => {
  const target = join(tempDir(), "mergeatron.sqlite");
  await Effect.runPromise(copyLegacyDatabase(join(tempDir(), "missing.sqlite"), target));
  expect(existsSync(target)).toBe(false);
});
