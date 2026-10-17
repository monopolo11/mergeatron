import { timingSafeEqual } from "node:crypto";
import { Data, Effect } from "effect";
import type { WebhookContext } from "./github.ts";
import { handleDelivery } from "./handler.ts";
import { compileSchema } from "./jsonSchema.ts";
import { logger } from "./log.ts";
import type { Webhook } from "./rules.ts";
import { customWebhookEvent } from "./shared.ts";
import { Store } from "./store.ts";

/**
 * Custom webhooks: endpoints you define in Settings that any service can POST
 * JSON to. A request with the right secret, whose body matches the webhook's
 * payload schema when it has one, fires the rules on `webhook.<slug>` with
 * the body as `{{payload}}`.
 */

const log = logger("webhook");

export class WebhookNotFoundError extends Data.TaggedError("WebhookNotFoundError")<{ readonly message: string }> {}
export class WebhookSecretError extends Data.TaggedError("WebhookSecretError")<{ readonly message: string }> {}
export class InvalidPayloadError extends Data.TaggedError("InvalidPayloadError")<{ readonly message: string }> {}

/** A new secret: 32 random bytes as hex, prefixed so it reads as one in a config file. */
export function generateSecret(): string {
  return `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
}

/** Compares the header to the secret in constant time. */
export function verifySecret(secret: string, header: string | undefined): boolean {
  if (!header) return false;
  const given = Buffer.from(header, "utf8");
  const expected = Buffer.from(secret, "utf8");
  // timingSafeEqual throws on buffers of different byte lengths, which non-ASCII headers can have at the same string length.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Why a payload does not match the webhook's schema, or null when it does (or the webhook has none). */
export function payloadError(webhook: Pick<Webhook, "payloadSchema">, payload: unknown): string | null {
  if (!webhook.payloadSchema) return null;
  const compiled = compileSchema(webhook.payloadSchema);
  if (!compiled.ok) return `the webhook's schema is invalid: ${compiled.error}`;
  if (compiled.validate(payload)) return null;
  return (compiled.validate.errors ?? []).map((error) => `${error.instancePath || "payload"} ${error.message ?? "is invalid"}`).join("; ");
}

/** Template variables of a delivery: the webhook's name and the body, pretty-printed so prompts read well. No repository: rules pick a project. */
export function webhookContext(webhook: Pick<Webhook, "name" | "slug">, payload: unknown): WebhookContext {
  return { repo: "", event: customWebhookEvent(webhook.slug), webhook: webhook.name, payload: JSON.stringify(payload, null, 2) };
}

/**
 * Handles `POST /webhooks/custom/:slug`: finds the webhook, checks the
 * secret, parses and validates the body, then runs the rules on
 * `webhook.<slug>` like any other delivery.
 */
export const receiveWebhook = Effect.fn("webhooks.receive")(function* (request: { slug: string; secret: string | undefined; body: string }) {
  const store = yield* Store;
  const webhook = yield* store.getWebhookBySlug(request.slug);
  if (!webhook) return yield* Effect.fail(new WebhookNotFoundError({ message: `no webhook named ${request.slug}` }));
  const deliveryId = crypto.randomUUID();
  const at = { delivery: deliveryId, webhook: webhook.slug };
  if (!verifySecret(webhook.secret, request.secret)) {
    yield* log.warn("rejected: invalid secret", at);
    return yield* Effect.fail(new WebhookSecretError({ message: "invalid secret" }));
  }
  const payload = yield* Effect.try({
    try: () => JSON.parse(request.body) as unknown,
    catch: () => new InvalidPayloadError({ message: "body is not JSON" }),
  });
  const invalid = payloadError(webhook, payload);
  if (invalid) {
    yield* log.warn("rejected: payload does not match the schema", { ...at, error: invalid });
    return yield* Effect.fail(new InvalidPayloadError({ message: invalid }));
  }
  yield* log.info("event received", at);
  return yield* handleDelivery({ deliveryId, event: customWebhookEvent(webhook.slug), ctx: webhookContext(webhook, payload) });
});
