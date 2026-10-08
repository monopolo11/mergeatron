import { Data, Effect, Schema } from "effect";
import { startQueued } from "./handler.ts";
import { logger } from "./log.ts";
import { RuleInput, RuleUpdate } from "./rules.ts";
import { Store } from "./store.ts";

const log = logger("rules");

/** The rule asked for does not exist. */
export class RuleNotFoundError extends Data.TaggedError("RuleNotFoundError")<{ readonly message: string }> {}

/**
 * Rule edits behind the MCP tools in mcp.ts. Payloads decode through the same
 * schemas as the UI's (RuleInput, RuleUpdate), so an agent gets the same
 * defaults and validation, reported as a SchemaError. The prompt changes
 * through versions (promptVersions.ts), not here.
 */

/** A new rule as sent: fields with a default may be left out. */
export type RuleCreate = typeof RuleInput.Encoded;

/** Changes to a rule: given fields replace the rule's, and `filters` replaces only the filters it names. */
export type RulePatch = Partial<Omit<typeof RuleUpdate.Encoded, "filters">> & { readonly filters?: typeof RuleUpdate.Encoded["filters"] };

const notFound = (id: string) => new RuleNotFoundError({ message: `No rule ${id}; ids come from list_rules.` });

export const createRule = Effect.fn("rules.create")(function* (input: RuleCreate) {
  const store = yield* Store;
  const rule = yield* store.createRule(yield* Schema.decodeUnknownEffect(RuleInput)(input, { errors: "all" }), "mcp");
  yield* log.info("rule created", { id: rule.id, name: rule.name });
  return rule;
});

export const updateRule = Effect.fn("rules.update")(function* (id: string, patch: RulePatch) {
  const store = yield* Store;
  const rule = yield* store.getRule(id);
  if (!rule) return yield* Effect.fail(notFound(id));
  const input = yield* Schema.decodeUnknownEffect(RuleUpdate)({ ...rule, ...patch, filters: { ...rule.filters, ...patch.filters } }, { errors: "all" });
  const updated = yield* store.updateRule(id, input);
  if (!updated) return yield* Effect.fail(notFound(id));
  // A raised limit lets queued runs start now rather than at the next settle.
  yield* startQueued(id);
  yield* log.info("rule updated", { id, fields: Object.keys(patch).join(",") });
  return updated;
});

/** Its prompt versions and runs stay. */
export const deleteRule = Effect.fn("rules.delete")(function* (id: string) {
  const store = yield* Store;
  if (!(yield* store.deleteRule(id))) return yield* Effect.fail(notFound(id));
  yield* log.info("rule deleted", { id });
  return { deleted: id };
});
