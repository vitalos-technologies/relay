---
title: API conventions
summary: Authentication, the error envelope, pagination, idempotency keys, optimistic concurrency and rate limits shared by every Relay HTTP route, with machine API examples.
section: developers
audience: developer
status: available
related: [api-route-reference, authentication-and-authorization, mcp-server, webhooks]
product_version: "2026-11"
reviewed: 2026-11-09
order: 40
keywords: [api, rest, errors, pagination, cursor, idempotency, rate limit, openapi, api key]
---

## Which interface to use

| Interface | Who it is for | Stability |
|---|---|---|
| `/api/v1/*` with a service-account API key | Scripts and integrations that create drafts | Supported for integrations |
| `/mcp` (Model Context Protocol) | AI assistants and agents acting for a person, or scripted clients with an API key | Supported; see [Connect an MCP client](/help/developers/mcp-server) |
| Other `/api/*` routes | The Relay web app itself (browser session + CSRF) | Internal: may change between releases |
| `/api/webhooks/*`, `/api/connectors/webhooks/*` | Networks and business apps calling Relay | Configured once per provider; see [Webhooks](/help/developers/webhooks) |

Every route, its access model and its purpose is listed in the generated [API route reference](/help/developers/api-route-reference). The repository also contains a generated OpenAPI 3.1 document at `docs/api/openapi.json`.

## Requests

- JSON request bodies, at most 256 KB. Larger bodies return `413 payload_too_large`; invalid JSON returns `422 validation_failed`. File uploads never go through the API: the app asks for an upload intent and the browser posts the file directly to storage.
- Bodies and query strings are validated with zod. Most schemas are strict: unknown fields are rejected.
- Ids are UUIDs. Timestamps are ISO 8601 with offset; scheduled times are sent as a local wall time plus an IANA time zone, and an ambiguous or skipped local time (daylight saving changes) is rejected with the choices instead of being guessed.
- Session routes accept an optional `X-Correlation-Id` (up to 64 characters) that is echoed back; otherwise one is generated.

## Responses and the error envelope

Successful responses are JSON (`{ "ok": true }` when there is nothing to return) with an `x-correlation-id` header. Every error uses one envelope:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Some fields are invalid",
    "fieldErrors": { "name": "Required" },
    "details": {}
  },
  "correlation_id": "6f1c…"
}
```

`message` is safe to show to people. `fieldErrors` maps a field path to a message (`_` for the whole body). `details` carries machine-readable context such as `reason`, `current` (the current version after a conflict) or `retry_after_seconds`. Quote `correlation_id` when reporting a problem; unexpected errors return `500 internal` and are logged under that id.

| Code | HTTP | Meaning |
|---|---|---|
| `unauthenticated` | 401 | No valid session or API key. |
| `step_up_required` | 401 | Re-authenticate (recent sign-in with second factor needed). |
| `forbidden` | 403 | Not allowed; `details.reason` explains (`no_grant`, `restricted`, …). |
| `csrf_failed` | 403 | Missing or wrong `X-CSRF-Token` or `Origin`. |
| `mfa_required` | 403 | The workspace policy requires two-step verification for this action. |
| `not_found` | 404 | Missing, or not visible to you (other workspaces look the same as missing). |
| `conflict` | 409 | Conflicting state (for example `workspace_changed`). |
| `version_conflict` | 409 | The resource changed since you read it; `details.current` has the new version. |
| `idempotency_conflict` | 409 | The `Idempotency-Key` was used with a different request. |
| `invalid_state` | 409 | The action is not possible in the current state (for example retrying a published delivery). |
| `budget_exhausted` | 402 | A usage budget (AI tokens, X writes or reads, exports) is used up. |
| `entitlement_required` | 402 | The plan does not include this feature or allowance. |
| `provider_not_configured` | 412 | The network or service has no app credentials on this installation. |
| `payload_too_large` | 413 | Body too large. |
| `unsupported_media` | 415 | File type not accepted. |
| `validation_failed` | 422 | Invalid input; see `fieldErrors`. |
| `rate_limited` | 429 | Too many requests; wait `details.retry_after_seconds`. |
| `internal` | 500 | Unexpected error. |
| `provider_error` | 502 | The network returned an error. |
| `dispatch_disabled` | 503 | Publishing is switched off for the installation. |

## Pagination

List endpoints that can grow use **keyset (cursor) pagination**:

1. Request the first page with an optional `limit` (each endpoint documents its maximum).
2. The response contains `items` and `next_cursor`.
3. Pass `cursor=<next_cursor>` unchanged for the next page. `next_cursor: null` means there are no more items.

Cursors are opaque (base64url of the last row's sort key and id). Do not build or modify them; they stay valid while the sort key does not change, and results are stable under concurrent inserts. A few feeds use an `after=<id>` change cursor instead (for example support activity). Bounded lists (brands, team members) return everything at once.

## Idempotency keys

Requests that create something or start an action that must not happen twice (scheduling, publishing, creating posts, invitations, imports, exports, replies) accept an `Idempotency-Key` header. The [API route reference](/help/developers/api-route-reference) marks every handler that reads it.

- Use a new random key (8–200 characters) per intended action and reuse the **same key** when retrying that action, for example after a timeout.
- Same key and same body within 24 hours: the original response is returned and nothing is repeated. A concurrent duplicate waits for the first request to finish.
- Same key with a different body: `409 idempotency_conflict`.
- Endpoints whose service reserves the key reject a missing key with `422 validation_failed`.
- Keys are scoped to the workspace and action.

## Optimistic concurrency

Editable resources carry a `version` (or `generation` for schedules and approval policies). Updates send `expected_version`; if someone else changed the resource first, the update fails with `409 version_conflict` and `details.current`. Reload, merge and retry with the new version.

## Rate limits

Limits are token buckets stored in PostgreSQL, so they hold across web replicas and restarts. Examples: sign-in 20 per minute per IP; upload intents 30 per minute per person; invitations 20 per hour per person; API keys 60 burst then 1 per second per key and per IP; MCP 120 burst then 2 per second per principal; the support widget per visitor and per IP. Exceeding a limit returns `429 rate_limited` with `details.retry_after_seconds` (`/mcp` also sends a `Retry-After` header).

## Machine API (`/api/v1`)

Authenticate with a service-account key created in workspace settings (shown once):

```shell
curl -s https://relay.example.com/api/v1/me \
  -H "Authorization: Bearer $RELAY_API_KEY"
```

Returns the service account, its workspace and its brand-scoped grants.

```shell
curl -s https://relay.example.com/api/v1/drafts \
  -H "Authorization: Bearer $RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: weekly-tip-2026-11-09" \
  -d '{"brand_id":"<brand uuid>","title":"Weekly tip","text":"Synthetic example text"}'
```

Creates a draft on that brand (needs `content.create_draft`, the `integration` role). It never schedules or publishes; a person reviews the draft in Relay. Send an `Idempotency-Key` header (8–200 characters) to make retries safe: the same key and body within 24 hours return the original draft's `id` instead of creating another, and the same key with a different body returns `409 idempotency_conflict`. Keys are scoped to the API key's service account. Without the header, each request creates a draft. An invalid, expired or revoked key returns `401` with `WWW-Authenticate: Bearer`.

## Health endpoints

| Endpoint | Meaning |
|---|---|
| `GET /api/health` | Web process is alive (no dependencies checked). |
| `GET /api/ready` | Database reachable and migrations applied. |
| Worker `GET :3001/health` | Worker alive (`503 draining` during shutdown). |
| Worker `GET :3001/ready` | Worker can reach the database; includes in-flight work and last loop runs. |
