# Relay MCP server — guide

Researched 2026-11-07 against modelcontextprotocol.io (authorization, transports, server/tools) and the installed SDK.

## Endpoint and versions

| Item | Value |
|---|---|
| Endpoint | `<APP_BASE_URL>/mcp` (override `MCP_RESOURCE_URL`); local: `http://localhost:3000/mcp` |
| Transport | Streamable HTTP. POST → SSE stream per request; GET → 405 (no standalone stream); DELETE ends the session |
| Protocol revision | **2025-11-25** (pinned; SDK also negotiates 2025-06-18, 2025-03-26). The site's "latest" page now describes 2026-07-28 (sessionless, no `initialize`); SDK 1.32.2 does not implement it → unsupported |
| SDK | `@modelcontextprotocol/sdk` 1.32.2 (`McpServer.registerTool` with zod schemas, `WebStandardStreamableHTTPServerTransport`) |
| Code | `packages/services/src/mcp/**`, route `apps/web/app/mcp/route.ts` |
| Protected-resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource/mcp` (path-inserted) and `/.well-known/oauth-protected-resource` (root) |

Sessions (`Mcp-Session-Id`) are in-process, bound to the authenticated principal, idle-expire after 30 min, max 20 per principal / 2000 total. They are **not** authorization: every HTTP request is re-authenticated and every call reloads authority from PostgreSQL. A different principal presenting a session id gets 404. Behind several web replicas a client may get 404 and must re-initialize (spec behaviour); use sticky routing for best results.

Transport protections: `Origin` present and not in `APP_BASE_URL`/resource origin/`MCP_ALLOWED_ORIGINS` → 403; `Host` not in configured hosts (`MCP_ALLOWED_HOSTS`) → 403; body > 256 KB → 413; per-principal rate limit (120 burst, 2/s; mutations 30 burst, 0.5/s; exports 5/h) → 429 + `Retry-After`; tool arguments ≤ 2000 elements; results ≤ 200 KB (`result_too_large`); page size ≤ 50; calendar ≤ 31 days; analytics/exports ≤ 92 days.

Cancellation: `notifications/cancelled` aborts the handler's signal; tools check it between steps (nothing after the checkpoint runs), the request's SSE stream is closed and the call is audited `cancelled`. Long work (exports) returns a job reference.

## Authentication (OAuth 2.x resource server)

Authorization server: the Keycloak realm (`OIDC_ISSUER`, override `MCP_AUTH_ISSUER`). Relay never issues tokens.

1. Client calls `/mcp` without a token → `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="social.read drafts.write"`.
2. Client reads PRM (`authorization_servers: [issuer]`, `scopes_supported`), then the issuer's OIDC discovery (Keycloak publishes `code_challenge_methods_supported` incl. S256 and `authorization_response_iss_parameter_supported: true`).
3. Authorization code + PKCE S256 with the pre-registered public client **`relay-mcp`** (`MCP_PUBLIC_CLIENT_ID`). Keycloak shows a consent screen; `default.acr.values=mfa` asks users with a second factor for it. `resource` is accepted but Keycloak 26.4 does not implement RFC 8707 — the audience comes from an audience mapper on every MCP scope (`included.custom.audience` = the MCP resource URI).
4. Each request: signature against the issuer's JWKS (RS256/PS256/ES256 only), `iss`, `aud` ∋ resource URI, `exp` (required), `iat`/`nbf`, `typ` (access tokens only), `azp`, `sub` → Relay user bound to (issuer, subject). Failures → `401 error="invalid_token"`.
5. Scopes the token lacks for a `tools/call` / `resources/read` → `403 error="insufficient_scope"` with `scope=` (current + required) before dispatch.
6. First valid token from (user, client) creates a **pending registration**; tools answer `consent_required` with `consent_url` (`/mcp/connect/<id>`) where the user, signed into Relay with step-up, picks the workspace (current), scopes and brands. A registration revoked in Relay rejects that client (`401 invalid_token`) until the user allows it again.

Client registration: pre-registration (`relay-mcp`, redirect URIs for MCP Inspector `http://localhost:6274/oauth/callback[/debug]` and `http://localhost:33418/callback`; add each real client's redirect URI in Keycloak). Client ID Metadata Documents: not supported by Keycloak 26.4. Dynamic client registration: Keycloak exposes `registration_endpoint`, but anonymous registration stays blocked by its default Trusted-Hosts policy (`MCP_DCR_ENABLED=false`); enabling it is an operator decision (Realm → Clients → Client registration policies; also allow the MCP client scopes).

Revocation: per registration in Relay (Settings → Developer → MCP) — immediate on the next request; also revokes the client's automation policies, invalidates its open intents and cancels queued jobs. Access tokens are short-lived (300 s); Keycloak session logout additionally stops refresh. Membership/grant changes apply on the next call (no caching).

**No token passthrough**: the raw token never leaves `auth.ts` (`AuthInfo.token` is a fingerprint); MCP clients never receive Google/Notion/social credentials, signed storage URLs or API keys. The web-login token (no MCP audience) is rejected at `/mcp` (verified).

### Service-account API keys

`Authorization: Bearer sl_live_…` (V2 service accounts) is accepted for scripted clients. Workspace = the key's; scopes = all, so effective access is exactly the account's grants (integration/viewer/editor, one brand). An MCP registration is created automatically (listed with kind API key, revocable separately). Service accounts can read (per grants) and `create_draft` (integration path); mutations that record a human author (`update_draft`, reviews, publishing, pause, cancel, imports) return `unsupported_principal`.

## Scopes and effective permission

Effective permission per call = V2 grants of the user/service account (central `authorize()`, MFA rules, restrictions) ∩ token scopes ∩ scopes granted at consent ∩ consented workspace/brands ∩ product policy. Scopes and brand consent are applied as policy restrictions on the request's `AuthzState`, so every shared service enforces them.

| Scope | V2 permissions it can exercise | Tools |
|---|---|---|
| `social.read` (default) | workspace/brands/connections/content/assets read | list_workspaces, list_brands, list_connections, get_capabilities, search_content, get_post, list_calendar, validate_post, get_review_status, get_delivery_status, get_job_status |
| `drafts.write` (default) | content.create, content.edit, content.create_draft | create_draft, update_draft, import_source_to_draft, cancel_schedule (own pending review) |
| `reviews.submit` | content.submit | submit_for_review |
| `publishing.schedule` | content.schedule, publishing.pause | prepare/commit_publication (scheduled), cancel_schedule, pause_brand |
| `publishing.publish` | content.schedule, content.publish | prepare/commit_publication (immediate) |
| `analytics.read` | analytics.read | query_analytics, get_metric_definitions, get_data_coverage |
| `reports.export` | exports.create | create_report_export, get_job_status |

MFA: sensitive permissions (schedule/publish/export) need a token with `acr=mfa` and a second-factor `amr` for roles the workspace policy requires MFA for — except commits authorized by a trusted confirmation or automation policy (both created with step-up in Relay).

## Tools

All take explicit ids (`workspace_id` from `list_workspaces` + brand/post/schedule/intent/job ids); mutations take `idempotency_key` (8–120 chars; reuse on retry) and, where content is versioned, `expected_version`. Results are `structuredContent` (+ same JSON as text) with `app_url` links; errors are `isError` results whose text is `{"error":{"code","message","details?"}}`. Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint:false`) come from `MCP_TOOLS` in `packages/core/src/contracts/mcp.ts` and are metadata, not enforcement. Text from posts/sources/guidelines/analytics is labelled untrusted (`content_notice`).

| Tool | Arguments | Output |
|---|---|---|
| list_workspaces | — | approved workspaces with scopes/brand_ids; `consent_url` if pending |
| list_brands | workspace_id | brands (timezone, paused, approval_required) |
| list_connections | workspace_id, brand_id? | destinations (provider, status, simulated) — no credentials |
| get_capabilities | workspace_id, brand_id?, connection_id? | effective actions per brand; per-destination constraints/formats/publish mode |
| search_content | workspace_id, brand_id, query?, tag?, archived?, cursor?, limit≤50 | posts page + next_cursor |
| get_post | workspace_id, post_id | version, text, destinations, schedule, approval, deliveries |
| list_calendar | workspace_id, from, to (≤31 d), brand_id? | schedules in range |
| create_draft | workspace_id, brand_id, text, title?, link?, connection_ids?, idempotency_key | post_id, version |
| update_draft | workspace_id, post_id, expected_version, title?/text?/link?/connection_ids?, idempotency_key | new version (stale → version_conflict); invalidates intents |
| list_sources | workspace_id, brand_id | Google Docs/Drive files and Notion pages the user selected for the brand in Relay (MCP cannot browse beyond that selection) |
| preview_source | workspace_id, source_item_id | title, fingerprint, sections (id, title, word_count, 280-char excerpt; untrusted), warnings |
| import_source_to_draft | workspace_id, source_item_id, fingerprint, section_ids, combine?, connection_ids?, idempotency_key | import_id, status (queued); the worker runs it; a changed source fails it (preview again); retries return the same import |
| get_import_status | workspace_id, import_id | status, post_ids, warnings, error |
| validate_post | workspace_id, post_id, connection_ids? | ok, issues, per_destination (composer validation) |
| submit_for_review | workspace_id, post_id, expected_version, connection_ids, local_time?, timezone?, offset?, idempotency_key | schedule (pending_approval), approval id |
| get_review_status | workspace_id, post_id | review state |
| prepare_publication | workspace_id, post_id, expected_version, connection_ids, when{mode, local_time?, timezone?, offset?}, deadline_minutes? | status `ready` (intent id+hash, expiry, revision hash, resolved time, validation, authorization method + confirm_url) / `approval_required` / `invalid` / `needs_choice` (DST choices) |
| commit_publication | workspace_id, intent_id, intent_hash, idempotency_key | committed schedule + deliveries; repeat → original result (`duplicate:true`) |
| get_delivery_status | workspace_id, post_id | per-destination state (simulated labelled) |
| cancel_schedule | workspace_id, schedule_id, idempotency_key | schedule + honest in-flight message |
| pause_brand | workspace_id, brand_id, reason?, idempotency_key | paused (resume only in Relay) |
| analytics_overview | workspace_id, brand_id?, network?, from?, to? (local dates), timezone?, dataset? (live/simulated) | meta, ≤4 KPIs vs previous period, trend, channels, top content, insights, data health (same service as the Analytics page) |
| query_analytics | workspace_id, brand_id?, provider?, from?, to?, cursor?, limit | per-post metrics: name, label, unit, period, source, caveats |
| get_metric_definitions | — | metric dictionary per network |
| get_data_coverage | workspace_id, brand_id? | per destination: supported, posts with metrics, freshness |
| create_report_export | workspace_id, report (delivery_history/post_metrics), brand_id?, from, to (≤92 d), target=relay_download, idempotency_key | job reference |
| get_job_status | workspace_id, job_id | status; on success an in-app download link (session-authenticated) |

Error codes: `not_found, forbidden, insufficient_scope, consent_required, client_revoked, mfa_required, validation_failed, version_conflict, conflict, invalid_state, idempotency_conflict, in_progress, rate_limited, budget_exhausted, approval_required, needs_choice, intent_stale, intent_expired, confirmation_required, unsupported_principal, source_connections_unavailable, result_too_large, cancelled, internal`. Invisible resources are always `not_found`.

Analytics/export note: `query_analytics` currently reads the V1.1 per-post snapshots (`services/analytics/index.ts`); switch to the analytics stream's query API when it lands. Exports are produced by the worker loop `mcp-jobs` (`runMcpJobs`) with a bounded CSV (≤ 5 MB, 7-day retention) downloadable only inside Relay; Drive/Notion targets plug in with the Content Hub exporters.

No SQL, shell, URL fetch, token, role/member management or approval tools exist.

## Resources and prompts

- `relay://mcp/scopes` — scope/tool map.
- `relay://workspaces/{workspace_id}/brands/{brand_id}/guidelines` — brand voice (listed for approved workspaces/brands).
- `relay://workspaces/{workspace_id}/connections/{connection_id}/capabilities`.
- `relay://workspaces/{workspace_id}/reports/{job_id}` — export metadata (this client's jobs only).
Unauthorized and missing both read as "Resource not found". Prompts `plan_week`, `summarise_performance` only compose guidance text and read nothing; they grant no authority.

## Write authorization model (publication)

1. `prepare_publication` resolves the exact version, destinations, time (timezone explicit; an ambiguous wall time returns choices), validation and approval state, and stores an intent (30-min expiry, SHA-256 `intent_hash` over all fields). Approval-required brands → `approval_required` (use `submit_for_review`; approvers decide in Relay).
2. Authorization, one of:
   - **Trusted confirmation**: the person the client acts for opens `confirm_url` (`/mcp/confirm/<intent>`), sees text/destinations/time, and confirms. Server route with session + CSRF + Origin, authority on the brand and step-up (fresh auth + MFA per policy). Only that person can see/confirm it.
   - **Automation policy** (`mcp_policy_grants`, created with step-up by the client's owner): brand, destinations, scheduled/immediate, validity window, max days ahead, local hours, max per day (reserved atomically), text length, links/media. Revocable.
   A model-supplied `confirmed: true` is not an input and is ignored.
3. `commit_publication` checks the hash, expiry and basis, rechecks version, content hash, destinations, resolved time and approval policy (any change → `intent_stale`, intent invalidated), then calls the same `schedulePost`/`publishNow` as the UI with idempotency key `mcp-intent:<id>`: permissions, validation, approvals and pause behave identically, and retries never create a second schedule.

## Idempotency

`create_draft`, `submit_for_review`, commits use the services' own atomic idempotency (`idempotency_keys`, keys namespaced `mcp:<client registration>:<key>`); `update_draft`, `cancel_schedule`, `pause_brand`, `import_source_to_draft` use an MCP reservation (same table; concurrent duplicate → `in_progress`, failure releases the key); exports are unique per (workspace, client, key). Same key + different arguments → `idempotency_conflict`.

## Audit

`mcp_audit`: actor (user / service account), client registration, tool or `resource:<name>`, resource ids only, result (`ok/error/denied/cancelled`), error code, correlation id, latency — never arguments or text. Consent, revocation, confirmation, policy and commit events also go to `audit_events`.

## Setup examples

Generated from live config in Settings → Developer → MCP (`McpSetupGuide`; temporary route `/mcp/settings`). Local values:

```shell
claude mcp add --transport http relay http://localhost:3000/mcp
```
```json
{ "servers": { "relay": { "type": "http", "url": "http://localhost:3000/mcp" } } }
```
OAuth client: `relay-mcp` (public, code + PKCE S256), issuer `http://localhost:5556/realms/social-lite`, default scopes `social.read drafts.write`. Discovery check: `curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp`.

## Tested clients

| Client | Status | Evidence |
|---|---|---|
| MCP TypeScript SDK `Client` + `StreamableHTTPClientTransport` 1.32.2 (protocol test client) | **Tested** (2025-11-25) | `tests/integration/mcp.test.ts` (19 tests) against the real handler and PostgreSQL |
| Keycloak 26.4 as authorization server | **Tested** | Scratch Keycloak with this realm import: real code+PKCE+OTP+consent flow for `relay-mcp` → token `aud=http://localhost:3000/mcp`, `azp=relay-mcp`, `acr=mfa`, `amr=[pwd,otp]` verified by the resource-server verifier; web-login client sign-in unchanged and its token rejected at `/mcp` |
| MCP Inspector | Not tested | activation item |
| Claude Code | Not tested | activation item |
| Claude (web/desktop) connectors | Not tested | needs public HTTPS + registered redirect URI |
| ChatGPT connectors | Not tested | needs public HTTPS + registered redirect URI |
| 2026-07-28-only (sessionless) clients | Unsupported | SDK 1.32.2 |
| stdio-only clients | Unsupported | remote HTTP server only |

No claim is made that any ChatGPT/Claude plan or client works with this endpoint until tested.

## Activation

- Re-create the Keycloak container to load the new realm import (`docker compose -f infra/compose.yaml up -d --force-recreate oidc`), or add the `relay-mcp` client and the seven MCP client scopes (audience mapper) in the admin console; production: set the audience to the public `https://…/mcp` URL.
- Production: `MCP_RESOURCE_URL` (https), `MCP_ALLOWED_HOSTS`/`MCP_ALLOWED_ORIGINS` for proxies, register each real client's redirect URI (or decide on DCR policy), then test MCP Inspector / Claude / ChatGPT and update the table above.
- Users must sign in to Relay once with the same Keycloak account before connecting a client.
