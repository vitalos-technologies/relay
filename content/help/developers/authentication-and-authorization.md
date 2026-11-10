---
title: Authentication and authorization
summary: How Relay signs people in (OpenID Connect), keeps sessions, protects against CSRF, requires two-step verification and step-up, and decides every permission.
section: developers
audience: developer
status: available
related: [api-conventions, mcp-server, architecture-and-modules, data-model-and-migrations]
product_version: "2026-11"
reviewed: 2026-11-10
order: 30
keywords: [auth, login, oidc, sso, session, csrf, mfa, step-up, permissions, roles, authz, api key]
---

## Principals

| Principal | How it authenticates | Where it is used |
|---|---|---|
| Person (member) | OpenID Connect sign-in at the identity provider, then an opaque session cookie | The web app and its `/api` routes |
| Service account | `Authorization: Bearer sl_live_<prefix>_<secret>` API key | `/api/v1/*` and `/mcp` |
| MCP client acting for a person | OAuth access token issued by the identity provider for the MCP resource | `/mcp` |
| Relay staff (platform operator) | A normal session plus a row in `platform_operators` | `/api/platform/*` and the admin console |
| Widget visitor | Widget visitor session cookie | `/api/widget/*` only |

Relay never stores passwords or second factors itself: they live at the identity provider (Keycloak in the reference setup).

## Sign-in (OpenID Connect)

1. `GET /api/auth/login?returnTo=/path` creates a single-use, hashed `state` with a nonce and a PKCE verifier (10-minute expiry), binds it to the browser with a short-lived HttpOnly cookie and redirects to the identity provider. The endpoint is rate-limited per IP (20 per minute).
2. The person signs in at the identity provider: passwordless (D34) — Google, or an email with a single-use link and a
   6-digit code. A second factor is asked only for Relay staff at sign-in and as a step-up (`acr_values=mfa`) for sensitive actions.
3. `GET /api/auth/callback` checks state, the browser binding, PKCE and the nonce, verifies the ID token, then creates a session. The session's assurance (`acr`, `amr`, `auth_time`) comes only from the verified ID token.
4. `POST /api/auth/logout` ends the session and redirects to the identity provider's logout.
5. `POST /api/auth/backchannel-logout` accepts signed logout tokens from the identity provider (replays rejected) and revokes the matching sessions immediately.

## Sessions

- Opaque random token in an HttpOnly, `SameSite=Lax` cookie: `sl_session` locally, `__Host-sl_session` with `Secure` in production. Only its SHA-256 is stored.
- Idle timeout 30 minutes, absolute lifetime 12 hours. There is no silent extension: after 12 hours the person signs in again.
- The token rotates on sign-in and step-up; the old value stops working at once.
- People see and revoke their sessions on the Security page. After a sign-in with a recovery code or any second-factor change, the person's other sessions are revoked and an email is sent.

## CSRF and request integrity

Every `POST`, `PUT`, `PATCH` and `DELETE` to a session route needs both:

1. an `Origin` header equal to the origin of `APP_BASE_URL` (outside production the request's own origin is also accepted), and
2. an `X-CSRF-Token` header equal to the `csrf_token` returned by `GET /api/session` (bound to the session).

Failure returns `403 csrf_failed`. The app also sends `X-Workspace-Id` with the workspace the page was rendered for; if the person switched workspace in another tab, the request fails with `409 conflict` (`reason: workspace_changed`) instead of mixing data. The header is never used as authority.

API keys and MCP tokens are not sent automatically by browsers, so `/api/v1/*` and `/mcp` have no CSRF token; `/mcp` validates `Origin` and `Host` instead.

## Two-step verification and step-up

- Each workspace's security policy (owners, permission `security.manage`) sets which roles must use two-step verification. Default: owner, admin, publisher and brand manager; owners always.
- **Sensitive permissions** (for example `content.publish`, `content.schedule`, `connections.manage`, `members.invite`, `service_accounts.manage`, `security.manage`, `exports.create`, `billing.manage`) are refused with `mfa_required` when the policy requires two-step verification for the person and the session was not verified with a second factor.
- **Step-up** actions (for example connecting or disconnecting accounts, creating API keys, platform changes, weakening the security policy) also need a recent authentication: within `step_up_seconds` (default 300 seconds). Otherwise the API returns `401 step_up_required`; the app then sends the browser to `GET /api/auth/step-up`, which asks for the second factor again at the identity provider with `acr_values=mfa` (the realm's LoA 2 has max age 0, so the code is always re-entered and `auth_time` is fresh). Without a second factor, the person enrols an authenticator app first and that counts as the verification.
- Second factors (authenticator app, passkeys, recovery codes) are managed at the identity provider through application-initiated actions. The app's identity-provider client can only read a person's factors; no Relay endpoint removes someone else's factor.

## Authorization model

The policy is one pure function, `evaluate()` in `packages/core/src/authz.ts`, used by every server path (web, worker, MCP). Decisions are re-loaded from the database on every request; the browser is never authority.

Order of evaluation:

1. No active membership, a suspended member, or a disabled or expired service account → deny.
2. An explicit restriction covering the action and scope → deny (`restricted`).
3. No active, unexpired grant whose role includes the permission and whose scope covers the resource → deny (`no_grant`, or `workspace_scope_required` for workspace-only permissions held only at brand scope).
4. Required assurance not met → deny (`mfa_required` or `step_up_required`).
5. Otherwise allow, with the grants that allowed it.

**Permissions** are fine-grained strings such as `content.create`, `content.schedule`, `connections.manage`, `inbox.reply`, `billing.manage` (48 in total). **Role presets** bundle them: owner, admin, team manager, brand manager, editor, approver, publisher, analyst, viewer, exporter, guest, integration and care agent. **Grants** give a role at workspace, brand or connection scope, directly or through a team, optionally with an expiry. The full role-to-permission matrix is maintained in the code and explained for administrators in the Teams and permissions section of the Help Centre.

Consequences you will see in the API:

- Lists only include brands the caller can see; an id outside the caller's workspace or brands returns `404 not_found`, never `403`, so existence does not leak.
- An action the caller may see but not perform returns `403 forbidden` with `details.reason` (`no_grant`, `restricted`, …).
- Platform routes return `404` to anyone without a platform operator role.

## Service accounts and API keys

- A service account belongs to a workspace and a named member (its owner) and has exactly one brand-scoped grant: role `integration` (create drafts only), `viewer` or `editor`.
- Keys look like `sl_live_<12-character prefix>_<64 hex characters>`, are shown once and stored as a SHA-256 hash. Up to 5 active keys per account; keys can expire, be rotated (the old key is revoked immediately) or revoked.
- Every request re-checks the key, its expiry, the account and its owner's membership; a suspended owner's keys are refused. Keys are rate-limited per IP and per key (60 burst, 1 per second).
- Creating accounts and keys needs `service_accounts.manage` plus step-up.

## MCP clients

MCP access is the intersection of: the person's (or service account's) own permissions, the scopes in the token, the scopes and brands the person approved for that client in Relay, and product rules such as approvals and publication confirmation. Details: [Connect an MCP client](/help/developers/mcp-server).

## Related

- [API conventions](/help/developers/api-conventions)
- [API route reference](/help/developers/api-route-reference)
- [Connect an MCP client](/help/developers/mcp-server)
