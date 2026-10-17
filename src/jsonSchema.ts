import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

/**
 * Compiles a JSON schema into a validator, or says why it is not a valid
 * schema. Draft-07 unless `$schema` names 2020-12. Unknown keywords and
 * formats are allowed, so schemas written for other tools still load.
 */
export function compileSchema(schema: Record<string, unknown>): { ok: true; validate: ValidateFunction } | { ok: false; error: string } {
  const options = { allErrors: true, strict: false, logger: false } as const;
  const ajv = typeof schema.$schema === "string" && schema.$schema.includes("2020-12") ? new Ajv2020(options) : new Ajv(options);
  try {
    return { ok: true, validate: ajv.compile(schema) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
