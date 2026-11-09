---
title: Connect an MCP client
summary: The Relay MCP endpoint, protocol and SDK versions, OAuth and API key authentication, consent, scopes, safe publication, limits, revocation and which clients were actually tested.
section: developers
audience: developer
status: available
related: [mcp-tool-reference, mcp-worked-examples, authentication-and-authorization, api-conventions]
product_version: "2026-11"
reviewed: 2026-11-09
order: 50
keywords: [mcp, model context protocol, ai agent, assistant, oauth, connector, claude code, tools]
---

## At a glance

| Item | Value |
|---|---|
| Endpoint | `<your Relay address>/mcp` (override with `MCP_RESOURCE_URL`) |
| Transport | Streamable HTTP. `POST` answers each request with its own event stream; `GET` returns 405 (the server sends no unsolicited messages); `DELETE` ends the protocol session. No stdio transport. |
| Protocol revision | 2025-11-25 (pinned). The SDK also negotiates 2025-06-18 and 2025-03-26. |
| SDK | `@modelcontextprotocol/sdk` 1.32.2 |
| Server | name `relay`, version 3.0.0, with tools, resources (templates) and prompts |
| Authentication | OAuth 2.1 bearer access tokens from the configured authorization server, or a Relay service-account API key |
| Discovery | OAuth Protected Resource Metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp` (and the root well-known URI) |
| Tools | 47 — see the [MCP tool reference](/help/developers/mcp-tool-reference) |

## Before you start

- Your workspace's plan must include MCP access; tool calls count towards the plan's MCP allowance.
- You need a Relay account you have signed in with at least once (the OAuth subject must map to a Relay user).
- The installation needs an authorization server that can issue access tokens whose audience is the Relay MCP resource URL. The reference setup uses a public client `relay-mcp` (authorization code + PKCE S256) in Keycloak; another identity provider works if it issues such tokens. Dynamic client registration is off unless `MCP_DCR_ENABLED=true`.

## Connect with OAuth (acting as you)

1. Add the server to your client. Examples generated from the live configuration are shown on the MCP settings page (`/mcp/settings`):
   - Claude Code: `claude mcp add --transport http relay https://relay.example.com/mcp`
   - VS Code (`.vscode/mcp.json`): `{ "servers": { "relay": { "type": "http", "url": "https://relay.example.com/mcp" } } }`
   - Generic: `{ "mcpServers": { "relay": { "type": "http", "url": "https://relay.example.com/mcp" } } }`
2. The client calls `/mcp` without a token, receives `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="social.read drafts.write"`, reads the protected-resource metadata and starts the authorization code flow at the authorization server. By default it asks only for `social.read` and `drafts.write`; request more scopes only if you need them.
3. Sign in at the identity provider (second factor if your account has one).
4. The first valid token registers the client in Relay as **pending**. Any tool call returns `consent_required` with a `consent_url` (`/mcp/connect/<id>`).
5. Open that link in Relay, choose the **workspace**, the **brands** (or all brands you can access) and the **scopes** to grant, and confirm. Approving needs a recent sign-in with your second factor.

**Expected outcome:** `list_workspaces` returns the approved workspace with the scopes the client may use there.

## Connect with an API key (scripts)

A workspace admin creates a service account (one brand, role `integration`, `viewer` or `editor`) and a key in workspace settings, then the script sends `Authorization: Bearer <service-account API key>`. The key's MCP registration is active immediately for the key's workspace.

```shell
curl -s https://relay.example.com/mcp \
  -H 'Authorization: Bearer <service-account API key>' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"script","version":"1"}}}'
```

API keys are limited on purpose:

- They act with the service account's grant only (an `integration` key can create drafts and little else; an `editor` key can also read content and brand guidelines).
- Drafts created with a key are text-only and go to all ready destinations of the brand (no `link`, no `connection_ids`).
- Publishing, review submission and other actions that need a human author return `unsupported_principal`.

## What a client can do

Effective permission for every call = the person's (or service account's) own Relay permissions **∩** the scopes in the token **∩** the scopes and brands approved for this client **∩** product rules (approvals, pauses, publication confirmation). Authority is re-read from the database on every call; the protocol session is never authorization.

| Scope | Allows |
|---|---|
| `social.read` | Read brands, destinations, posts and calendar |
| `drafts.write` | Create and edit drafts |
| `reviews.submit` | Submit drafts for review |
| `publishing.schedule` | Prepare and commit scheduled publications, cancel schedules, pause a brand |
| `publishing.publish` | Prepare and commit immediate publications |
| `analytics.read` | Read analytics, metric definitions and data coverage |
| `reports.export` | Create report exports |
| `inbox.read` | Read inbox conversations and cases (internal notes excluded) |
| `inbox.draft` | Save reply drafts for a person to send in Relay (never sends) |
| `inbox.assign` | Assign conversations |
| `cases.manage` | Create cases and change state, owner and priority |
| `listening.read` | Read listening searches, mentions and alerts |
| `ai.prepare` | Ask Relay AI to prepare summaries and suggestions (suggestions only) |

There is no scope that sends a customer reply, approves content, changes members or settings, or reads credentials.

## Safe publication

Publishing is a two-step contract. An AI client cannot confirm on your behalf:

1. `prepare_publication` resolves exactly what would be published (post version, content hash, destinations, time with an explicit time zone, validation, approval state) and returns an intent id and hash that expire after 30 minutes. Nothing is scheduled. An ambiguous local time (daylight saving change) returns the choices (`needs_choice`).
2. The intent must be **authorized** in one of two ways:
   - you confirm it in Relay at `/mcp/confirm/<intent id>` (signed in as the person the client acts for, with authority on the brand and a recent second-factor sign-in); or
   - an **automation policy** you created for this client covers it (brand, destinations, validity window, how many days ahead, local hours, posts per day, text length, links and media allowed).
3. `commit_publication` re-checks the post version, content, destinations and time. Any change invalidates the intent (`intent_stale`); an old intent fails with `intent_expired`. It then schedules through the same service as the app, with an idempotency key derived from the intent, so retrying a commit never creates a second schedule.

Brands that require approval must go through `submit_for_review`; an intent proves integrity, not editorial approval.

## Idempotency

Every mutating tool takes an `idempotency_key` (8–120 characters of letters, digits, `.`, `_`, `:` and `-`). Reuse the same key when retrying the same action: the stored result is returned with `duplicate: true`. The same key with different arguments returns `idempotency_conflict`; a call still running returns `in_progress`. Mutations that take `expected_version` fail with `version_conflict` when the resource changed.

## Revocation and audit

- Revoke a client on the MCP settings page (or `POST /api/mcp/clients/<id>/revoke`). It takes effect on the next request: the client receives `401 invalid_token`, its automation policies are revoked, its prepared or confirmed publication intents are invalidated and its queued report jobs are cancelled. Publications it already committed stay scheduled; cancel them in Relay if needed. You can allow the client again later.
- Revoking or rotating an API key, disabling its service account or suspending its owner also stops MCP access immediately.
- Every tool and resource call is audited (tool, result, error code, ids, latency — no content). Owners of a client see its calls on the MCP settings page; members with `audit.read` see the whole workspace.

## Errors and limits

| Situation | Response |
|---|---|
| No token | HTTP `401`, `WWW-Authenticate` with `resource_metadata` and the default scopes |
| Invalid, expired, wrong-audience or revoked token or key | HTTP `401` `invalid_token` with a description |
| Token lacks the scope a `tools/call` needs | HTTP `403` `insufficient_scope` with the scope to request |
| Unknown or expired protocol session | HTTP `404` — start a new session with `initialize` |
| Body over 256 KB | HTTP `413` |
| Over the rate limit (120 burst, 2 per second per principal) | HTTP `429` with `Retry-After` |
| Foreign `Origin` or `Host` | HTTP `403` |
| Tool-level problem | Tool result with `isError: true` and `{ "error": { "code", "message" } }` — codes in the [tool reference](/help/developers/mcp-tool-reference#errors) |

Further limits: mutating tools 30 burst then 1 per 2 seconds; report exports 5 per hour; page size up to 50; calendar range up to 31 days; analytics range up to 92 days; structured results up to 200 KB (`result_too_large` asks for a narrower request); protocol sessions expire after 30 minutes idle, at most 20 per principal. Clients may cancel a request (`notifications/cancelled`); the server stops between steps and records the call as cancelled. Long work (report exports, imports) returns a job id to poll.

> **Note:** Protocol sessions are kept in the web process's memory. With more than one web replica, route `/mcp` requests with the same `Mcp-Session-Id` to the same replica, or clients will see `404` and re-initialize.

## Tested compatibility

| Client | Status | Evidence |
|---|---|---|
| MCP TypeScript SDK 1.32.2 `Client` + `StreamableHTTPClientTransport` | Tested | Repository protocol test (21 tests: discovery, tenant isolation, drafts and review, safe publication, policy grants, cancellation, API keys) and a live run on 2026-11-09 against a freshly set-up instance with an API key (initialize at 2025-11-25, 47 tools, idempotent replay, conflict, revocation → 401). |
| Raw HTTP (`curl` / `fetch`) JSON-RPC | Partly tested | The 401 challenge and protected-resource metadata were checked over plain HTTP. |
| MCP Inspector | Not tested | The local realm allows its redirect URI. |
| Claude Code (remote HTTP server) | Not tested | |
| Claude (web/desktop) custom connectors, ChatGPT connectors | Not tested | Need a public HTTPS endpoint and an OAuth client registered for their redirect URI. |
| Clients that only speak the sessionless 2026-07-28 revision | Unsupported | |
| stdio-only clients | Unsupported | Relay is a remote server; no stdio bridge is provided. |

## Related

- [MCP tool reference](/help/developers/mcp-tool-reference)
- [MCP worked examples](/help/developers/mcp-worked-examples)
- [Authentication and authorization](/help/developers/authentication-and-authorization)
