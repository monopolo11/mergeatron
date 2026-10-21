# Webhooks

Two ways to start threads from events: GitHub, and any service that can send an HTTP request.

## GitHub

The endpoint is `POST /webhooks/github`.

1. Expose the port to GitHub. For a laptop, `cloudflared tunnel --url http://localhost:8787` or [smee.io](https://smee.io).
2. In the repo or org settings add a webhook: content type `application/json`, your `GITHUB_WEBHOOK_SECRET`, and the events you want (Pull requests, Pull request reviews, Issue comments, Issues).
3. Add [rules](rules.md) on the events, such as `pull_request.review_requested`.

GitHub retries deliveries; the same delivery id never starts a second thread for the same rule.

No tunnel wanted? The [inbox](inbox.md) polls GitHub through `gh` and its automations fire the same rules.

## Custom webhooks

**Settings → Webhooks** defines one with a name, a slug and an optional JSON schema for its payload. The service generates a secret.

```sh
curl -X POST http://localhost:8787/webhooks/custom/<slug> \
  -H "X-Webhook-Secret: whsec_…" -d '{"service": "api", "deploy": {"sha": "abc123"}}'
```

| Response | Meaning |
| --- | --- |
| 401 | Wrong secret |
| 400 | Body is not JSON, or does not match the schema (the reasons are in the reply). Nothing runs |
| accepted | Fires the rules on `webhook.<slug>` (**Webhooks** in the event picker) |

Prompts get `{{webhook}}` (its name), `{{payload}}` (the body as JSON) and paths into it such as `{{payload.deploy.sha}}`. With a schema, the editor offers every property as a chip.

A custom webhook has no repository, so its rules pick a T3 project. The schema is draft-07 unless its `$schema` names 2020-12. **Rotate** replaces the secret. The slug is fixed once created, since rules name it.
