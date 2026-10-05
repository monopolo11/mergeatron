import { defineConfig } from "drizzle-kit";
import { homedir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATA_PATH ?? join(homedir(), ".mergeatron", "data", "mergeatron.sqlite") },
});
