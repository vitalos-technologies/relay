# MCP connection and authorization failures

Audience: operators and workspace admins. Repo only. Reviewed 2026-11-09 (product 2026-11). Background:
`content/help/developers/mcp-server.md`.

**Affected resources:** `/mcp` endpoint, the authorization server (identity provider) client for MCP, `mcp_clients`,
`mcp_policy_grants`, `mcp_publication_intents`, `mcp_jobs`, `mcp_audit`.

## Symptoms and likely causes

| What the client sees | Likely cause |
|---|---|
| HTTP 401, `WWW-Authenticate` without `error` | No token sent; the client should start OAuth from `resource_metadata` |
| HTTP 401 `invalid_token` "not issued for this resource" | Token audience ≠ `MCP_RESOURCE_URL` (wrong client, missing audience mapper at the identity provider, or a changed public URL) |
| HTTP 401 "issued by an unexpected authorization server" | `MCP_AUTH_ISSUER`/`OIDC_ISSUER` differs from the token issuer |
| HTTP 401 "Sign in to Relay with this account before connecting" | The person never signed in to Relay, or their account is disabled |
| HTTP 401 "revoked in Relay" / "Invalid, expired or revoked API key" | Client revoked on the MCP settings page; key revoked, expired or its owner suspended |
| HTTP 401 "could not be verified" | Identity provider discovery or JWKS unreachable from the web servers (`mcp_jwks_unavailable` in logs) |
| HTTP 403 `insufficient_scope` | Token lacks the scope for the tool; the client must re-authorize asking for it |
| HTTP 403 "origin not allowed" / "host not allowed" | Browser-based client on another origin, or a proxy rewriting `Host` (`MCP_ALLOWED_ORIGINS`, `MCP_ALLOWED_HOSTS`) |
| HTTP 404 "Session not found" | Protocol session expired (30 min idle), web restarted, or requests spread across replicas without stickiness |
| HTTP 429 | Over 120 burst / 2 per second for that principal |
| Tool result `consent_required` | The person has not approved the client for the workspace yet (`consent_url`) |
| Tool result `not_found` | Wrong workspace or brand, or brand not approved for the client |
| Tool result `unsupported_principal` | API key used for a human-only action (publishing, review) |
| Tool result `confirmation_required` / `intent_stale` / `intent_expired` | Publication not confirmed in Relay, changed since prepare, or older than 30 minutes |
| Tool result `entitlement_required` | The workspace plan does not include MCP or the MCP allowance is used up |

## Diagnostics

1. **READ-ONLY** Discovery: `curl -s <APP_BASE_URL>/.well-known/oauth-protected-resource/mcp` must return `resource`
   = the public MCP URL and the issuer in `authorization_servers`.
2. **READ-ONLY** Client registration:
   ```sql
   SELECT id, kind, client_id, status, granted_scopes, brand_ids, consented_at, last_activity_at, last_tool, revoked_at, revoked_reason
     FROM mcp_clients WHERE owner_user_id='<user id>' ORDER BY created_at DESC;
   ```
3. **READ-ONLY** Recent calls and outcomes (no content is stored):
   ```sql
   SELECT created_at, tool, result, error_code, latency_ms FROM mcp_audit WHERE client_row_id='<client row id>' ORDER BY created_at DESC LIMIT 50;
   ```
   Also visible on the MCP settings page (own clients) and to members with `audit.read`.
4. **READ-ONLY** Identity provider client: the public MCP client must use authorization code + PKCE S256, allow the
   client's redirect URI, add the MCP resource URL as audience, and offer every scope the client requests. In the local
   reference realm the `relay-mcp` client offers only the seven original scopes; inbox, cases, listening and AI scopes
   must be added to the identity provider before OAuth clients can request them.

## Corrective actions

| Cause | Action |
|---|---|
| Client revoked by mistake | The owner allows it again from the MCP settings page (new consent, step-up). |
| Wrong audience or issuer | Fix the identity provider audience mapper or `MCP_RESOURCE_URL` / `MCP_AUTH_ISSUER`; clients re-authorize. |
| JWKS unreachable | Restore network access from web servers to the identity provider. |
| Sessions lost across replicas | Configure sticky routing on `Mcp-Session-Id`, or run one web replica for `/mcp`. Clients recover by re-initializing. |
| Suspected misuse by a client | **CHANGES DATA** Revoke the client (owner, or anyone with `service_accounts.manage`): `POST /api/mcp/clients/<id>/revoke`. Effective on the next request; policies revoked, open intents invalidated, queued jobs cancelled. Cancel any schedules it committed if needed. |
| Compromised API key | Revoke or rotate the key ([key-rotation-and-security-incidents.md](key-rotation-and-security-incidents.md)). |

## Verification

- `list_workspaces` succeeds for the client; `mcp_audit` shows `ok` results; the client's `last_activity_at` updates.

## Escalation

Authentication failures for every client at once (identity provider outage or key rollover), or audit entries showing
actions the person did not authorize: treat as a security incident ([key-rotation-and-security-incidents.md](key-rotation-and-security-incidents.md)).
