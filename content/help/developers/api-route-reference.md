---
title: API route reference
summary: Every HTTP route in Relay with its methods, access model, idempotency support and purpose, generated from the code.
section: developers
audience: developer
status: available
related: [api-conventions, mcp-tool-reference, authentication-and-authorization]
product_version: 2026-11
reviewed: 2026-11-10
order: 41
keywords: [api, endpoints, routes, openapi, rest]
---

> **Note:** This page is generated from the route handlers by `node scripts/docs-api-check.mjs --write`; CI fails when it is out of date. Do not edit it by hand.

## What is stable

Only two interfaces are meant for integrations: the machine API under `/api/v1` (service-account API keys) and the MCP endpoint `/mcp`. Every other route is the web app's own API: it needs a browser session cookie plus CSRF protection and can change between releases. Conventions shared by all routes (error envelope, pagination, idempotency, rate limits) are in [API conventions](/help/developers/api-conventions).

This page lists 491 route files with 612 handlers (Public: 27, Session: 556, Session (no workspace): 13, API key: 2, Widget: 10, MCP bearer: 4). 61 handlers used only by Relay staff in the admin console are not listed here.

## Access models

| Access | What the caller needs |
|---|---|
| Session | Signed-in session cookie and an active workspace membership; mutations also need a same-origin `Origin` and the `X-CSRF-Token` from `GET /api/session`. |
| Session (no workspace) | Signed-in session cookie; works without an active workspace. Mutations need `Origin` + `X-CSRF-Token`. |
| Public | No session. Webhooks and callbacks verify their own signature, token or OAuth state. |
| Widget | Support widget: a signed-in member session or the widget visitor session cookie; Origin checked. |
| API key | `Authorization: Bearer sl_live_…` service-account key; no cookies, no CSRF. |
| MCP bearer | OAuth access token for the MCP resource or a service-account API key (see the MCP reference). |

"Idempotency-Key" marks handlers that read the header. Request bodies are validated with zod; unknown fields are rejected (`422 validation_failed`) wherever a schema is `.strict()`.

## Routes by area

### .well-known

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/.well-known/oauth-protected-resource` | Public |  | OAuth 2.0 Protected Resource Metadata (RFC 9728) — root well-known URI (fallback for MCP clients). |
| GET | `/.well-known/oauth-protected-resource/mcp` | Public |  | OAuth 2.0 Protected Resource Metadata (RFC 9728 §3.1) for the /mcp resource (path-inserted well-known URI, referenced by resource_metadata in the endpoint's WWW-Authenticate challenges). |

### accounts

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/accounts/health` | Session |  | GET /api/accounts/health?brand_id= — account health centre: per connection, why it cannot publish, the exact fix and the affected upcoming schedules (only brands where the viewer holds connections.read). |

### activity

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/activity` | Session |  | GET /api/activity?category=&brand_id=&actor_user_id=&action=&q=&from=&to=&cursor=&limit= (audit.read) → { items, next_cursor, can_export }. Workspace-scoped; brand-restricted events are hidden. |
| POST | `/api/activity/export` | Session |  | POST /api/activity/export { ...same filters as GET /api/activity } → text/csv attachment. Needs audit.read + exports.create; rate-limited, budgeted (exports/month), audited, CSV-injection safe. POST (not GET) so a cross… |

### admin

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/admin/analytics` | Session |  | GET /api/admin/analytics — V3.1 Admin read model (stored data only; see services/admin/reads.ts for permissions). |
| GET | `/api/admin/care` | Session |  | GET /api/admin/care — V3.5 admin summary (stream F): each stream's own admin overview in one call (inbox, listening, AI + automation, integrations) + V3.5 audit counts. Counts and states only; no message, mention or pro… |
| GET | `/api/admin/changes` | Session |  | GET /api/admin/changes — per-topic change markers (V3.1 Admin §5). No record data; workspace.read. |
| GET | `/api/admin/collaboration` | Session |  | GET /api/admin/collaboration — tasks, review backlog, reassignment counts, notification delivery (admins only). |
| GET | `/api/admin/collaboration/notifications` | Session |  | GET /api/admin/collaboration/notifications?state=failed\|not_configured\|skipped\|pending&cursor= — delivery problems (metadata only). |
| POST | `/api/admin/collaboration/notifications/{id}/retry` | Session |  | POST /api/admin/collaboration/notifications/:id/retry — retry a failed / unconfigured email (recipient re-checked). |
| GET, POST | `/api/admin/collaboration/reassign` | Session |  | GET /api/admin/collaboration/reassign — work held by people who lost access. POST /api/admin/collaboration/reassign { from_user_id, to_user_id, include? } — move open work (members.manage). |
| GET | `/api/admin/collaboration/reviewers` | Session |  | GET /api/admin/collaboration/reviewers?brand_id= — eligible reviewers per approval stage. |
| GET | `/api/admin/connections` | Session |  | GET /api/admin/connections — V3.1 Admin read model (stored data only; see services/admin/reads.ts for permissions). |
| GET | `/api/admin/dead-letters` | Session |  | GET /api/admin/dead-letters — this workspace's dead-lettered outbox events. workspace.manage. |
| POST | `/api/admin/dead-letters/{id}/requeue` | Session |  | POST /api/admin/dead-letters/:id/requeue — requeue one dead event (safe types only; repeated clicks requeue once). |
| GET | `/api/admin/deliveries` | Session |  | GET /api/admin/deliveries — per-destination publishing operations list (V3.1 Admin §8). content.read, brand-scoped. |
| GET | `/api/admin/deliveries/{id}` | Session |  | GET /api/admin/deliveries/:id — delivery evidence + which recovery actions apply (actions use the existing routes). |
| GET | `/api/admin/inbox` | Session |  | GET /api/admin/inbox — inbox + connector health for the workspace admin console (counts/states only; no message text). |
| GET | `/api/admin/integrations` | Session |  | GET /api/admin/integrations — integration health + sync lag per installation (integrationHealth), Slack delivery and translation usage (diagnostics.read). Counts, states and safe error codes only. |
| GET | `/api/admin/jobs` | Session |  | GET /api/admin/jobs — V3.1 Admin read model (stored data only; see services/admin/reads.ts for permissions). |
| GET | `/api/admin/overview` | Session |  | GET /api/admin/overview — workspace admin overview (V3.1 Admin §6). workspace.read; cards filtered by permission. |
| GET | `/api/admin/support-access` | Session |  | GET /api/admin/support-access — support access requests/grants for this workspace. members.read. |
| POST | `/api/admin/support-access/{id}/decision` | Session |  | POST /api/admin/support-access/:id/decision { decision: approve\|decline, note? } — members.manage + fresh sign-in. |
| POST | `/api/admin/support-access/{id}/end` | Session |  | POST /api/admin/support-access/:id/end — workspace ends (or cancels) support access now. members.manage. |
| GET | `/api/admin/webhooks` | Session |  | GET /api/admin/webhooks — V3.1 Admin read model (stored data only; see services/admin/reads.ts for permissions). |

### ai

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/ai/status` | Session |  | GET /api/ai/status → {configured, reason, fixture, model, can_use, period, used, cap, remaining} Workspace-level; never reveals the key or where it is stored. |

### analytics

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/analytics` | Session |  | GET /api/analytics?brand_id=&provider=&cursor=&limit= — published deliveries with their latest native metrics (provider-native names, period, observed_at, source). Never summed across networks. |
| GET | `/api/analytics/audience` | Session |  | GET /api/analytics/audience?{filters} — see packages/core/src/contracts/analytics.ts. |
| GET | `/api/analytics/best-time` | Session |  | GET /api/analytics/best-time?{filters} — observational heuristic; status 'insufficient_data' (hide it) below the sample threshold. |
| GET | `/api/analytics/channels` | Session |  | GET /api/analytics/channels?{filters} — see packages/core/src/contracts/analytics.ts. |
| GET | `/api/analytics/content` | Session |  | GET /api/analytics/content?{filters}&sort=&dir=&page=&page_size= — thumbnail-led, sortable, paginated content table. |
| GET | `/api/analytics/content/{deliveryId}` | Session |  | GET /api/analytics/content/:deliveryId?tz= — drilldown: media, caption, source metrics, as-of history, observed changes, coverage. |
| GET, POST | `/api/analytics/exports` | Session |  | GET /api/analytics/exports — my recent exports. POST {view, format: csv\|pdf\|html, destination?, destination_ref?, report_id? \| query_string?} ⇒ 202-style queued export (rendered by the worker; poll GET /api/analytics/ex… |
| GET | `/api/analytics/exports/{exportId}` | Session |  | GET /api/analytics/exports/:id — export status, manifest and download path (requester only). |
| GET | `/api/analytics/exports/{exportId}/download` | Session |  | GET /api/analytics/exports/:id/download — the file, after re-checking the requester's CURRENT access. |
| GET | `/api/analytics/metrics` | Session |  | GET /api/analytics/metrics — the metric registry (dictionary) as MetricDefinitionDto[]. |
| GET | `/api/analytics/overview` | Session |  | GET /api/analytics/overview?{filters}&measure= — ≤4 KPIs, trend (+previous overlay), channel comparison, top content, calculated insights, data-health footer. Types: OverviewResponse (packages/core/src/contracts/analyti… |
| GET, POST | `/api/analytics/reports` | Session |  | GET /api/analytics/reports — saved views the caller can open. POST {name, view, query_string\|filters, visibility}. |
| GET, PATCH, DELETE | `/api/analytics/reports/{reportId}` | Session |  | GET /api/analytics/reports/:id — open a saved view (access re-checked now) → { report, data }. PATCH/DELETE: owner only. |
| GET, POST | `/api/analytics/sync` | Session |  | GET /api/analytics/sync?{filters} — sync status per account. POST {connection_id} — ask for a sync soon (throttled; the worker performs provider calls, never this request). |
| GET | `/api/analytics/video` | Session |  | GET /api/analytics/video?{filters} — see packages/core/src/contracts/analytics.ts. |
| GET | `/api/analytics/workflow` | Session |  | GET /api/analytics/workflow?{filters} — see packages/core/src/contracts/analytics.ts. |
| POST | `/api/analytics/{deliveryId}/refresh` | Session |  | POST /api/analytics/:deliveryId/refresh — on-demand metrics refresh, throttled per delivery (429 with next_allowed_at). X reads consume the workspace x.read budget and are skipped when it is exhausted. |

### approvals

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/approvals` | Session |  | GET /api/approvals?status=pending\|decided&brand_id= — V2 approval inbox (stream C): brand/assignee/due grouping data. |
| GET | `/api/approvals/{id}` | Session |  | GET /api/approvals/:id — exact outgoing variants + V2 policy progress, decisions and the caller's eligibility. |
| POST | `/api/approvals/{id}/approve` | Session |  | (no description in code) |
| POST | `/api/approvals/{id}/assignment` | Session |  | POST /api/approvals/:id/assignment — reviewer assignee + review due date (planning only; grants nothing). |
| POST | `/api/approvals/{id}/reject` | Session |  | (no description in code) |
| GET | `/api/approvals/{id}/reviewer-options` | Session |  | GET /api/approvals/:id/reviewer-options?q= — eligible reviewers for this request (bounded search). |
| GET, POST | `/api/approvals/{id}/reviewers` | Session |  | GET /api/approvals/:id/reviewers — requested reviewers. POST { user_ids } — ask eligible people to review. |

### assets

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/assets/upload-intent` | Session |  | POST /api/assets/upload-intent { brand_id, filename, content_type, bytes } → { asset_id, upload: { method: 'POST', url, fields } } — presigned POST (exact key, type, size range; 10 min). |
| GET, PATCH | `/api/assets/{id}` | Session |  | GET /api/assets/:id · PATCH /api/assets/:id { alt_text?, tags? } |
| POST | `/api/assets/{id}/archive` | Session |  | POST /api/assets/:id/archive — 409 while referenced by an active schedule/delivery (ME-05). |
| POST | `/api/assets/{id}/complete` | Session |  | POST /api/assets/:id/complete — synchronous validation + derivatives (status ready \| rejected). |
| GET, PATCH | `/api/assets/{id}/governance` | Session |  | V3.1 §12 — GET/PATCH /api/assets/:id/governance — ownership, licence notes, expiry, superseded/archived lifecycle. |

### assistant

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/assistant/actions/{id}/apply` | Session |  | POST /api/assistant/actions/:id/apply [{reviewed_hash}] → applies a proposed action through the normal service (permission re-checked). V5 external actions (schedule / submit for approval / send reply) need the reviewed… |
| POST | `/api/assistant/actions/{id}/dismiss` | Session |  | POST /api/assistant/actions/:id/dismiss |
| GET | `/api/assistant/actions/{id}/preview` | Session |  | GET /api/assistant/actions/:id/preview — exact destinations, content, timing and permission for a prepared external action, with the hash the confirmation must carry (POST /api/assistant/actions/:id/apply {reviewed_hash… |
| GET | `/api/assistant/admin` | Session |  | GET /api/assistant/admin — Workspace admin: AI workflow runs, failures, usage, budget, feature availability (diagnostics.read). |
| GET, POST | `/api/assistant/attachments` | Session |  | GET /api/assistant/attachments?brand_id= · POST {brand_id, filename, mime, text} — small text files (≤ 256 KB) used as untrusted sources for my tasks. Private to me; text purged after 30 days. |
| DELETE | `/api/assistant/attachments/{id}` | Session |  | DELETE /api/assistant/attachments/:id |
| GET | `/api/assistant/classification` | Session |  | GET /api/assistant/classification?conversation_id= → latest classification (signals only) or null. |
| GET, POST | `/api/assistant/knowledge` | Session |  | GET /api/assistant/knowledge?brand_id= · POST {brand_id, kind, ref_id, topics?, review_by?} (brands.manage on the brand) |
| GET | `/api/assistant/knowledge/candidates` | Session |  | GET /api/assistant/knowledge/candidates?brand_id= → Content Hub documents + saved replies that can be approved. |
| PATCH, DELETE | `/api/assistant/knowledge/{id}` | Session |  | PATCH /api/assistant/knowledge/:id {topics?, review_by?} · DELETE (revoke) |
| GET, POST | `/api/assistant/runs` | Session |  | GET /api/assistant/runs?context_id=&limit= (my runs) · POST {surface, task, context, prompt?, target_language?, idempotency_key} POST only queues the run (ai-assist queue); poll GET /api/assistant/runs/:id. Never sends,… |
| GET | `/api/assistant/runs/{id}` | Session |  | GET /api/assistant/runs/:id → run with evidence, suggestions, sources and proposed actions (requester only). |
| GET | `/api/assistant/status` | Session |  | GET /api/assistant/status → {configured, reason, provider, can_use, period, used, cap, remaining}. Never reveals the key. |
| GET | `/api/assistant/threads` | Session |  | GET /api/assistant/threads?cursor=&limit=&q= — my AI conversations, newest first, loaded incrementally (keyset cursor). |
| GET, PATCH | `/api/assistant/threads/{id}` | Session |  | GET /api/assistant/threads/:id (runs, oldest first) · PATCH {title?, archived?} |
| POST | `/api/assistant/workflows` | Session |  | POST /api/assistant/workflows {workflow, thread_id?, prompt?, inputs, idempotency_key} — QUEUES a workflow run ('ai-assist' queue, worker executes it). Never publishes or sends: external actions are only prepared as pre… |
| GET | `/api/assistant/workflows/{id}` | Session |  | GET /api/assistant/workflows/:id?after=<seq> — run state (steps, results, actions) + progress events after the cursor. |
| POST | `/api/assistant/workflows/{id}/cancel` | Session |  | POST /api/assistant/workflows/:id/cancel — stop: undispatched work never starts; finished work is kept and explained. |
| POST | `/api/assistant/workflows/{id}/input` | Session |  | POST /api/assistant/workflows/:id/input {field, value} — answer a needs_input question (only the offered options). |
| POST | `/api/assistant/workflows/{id}/retry` | Session |  | POST /api/assistant/workflows/:id/retry — resume a failed/partial/cancelled run; completed writes are never repeated. |
| GET | `/api/assistant/workspace` | Session |  | GET /api/assistant/workspace?brand_id= — V5 AI workspace context (brands, accounts, documents, permissions, plan features, data availability) + 4–6 suggestions derived from it. Read with the caller's own access; titles/… |

### audit

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/audit` | Session |  | GET /api/audit?cursor=&resource_type=&limit= (owner/admin) — { items, next_cursor } |

### auth

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/auth/backchannel-logout` | Public |  | POST /api/auth/backchannel-logout — OpenID Connect Back-Channel Logout 1.0 receiver (called by the IdP, not by browsers: no session/CSRF). The logout_token is verified (JWKS signature, iss, aud, iat, events, sid/sub, no… |
| GET | `/api/auth/callback` | Public |  | GET /api/auth/callback — completes OIDC for login, step-up and IdP (Keycloak) actions. login: binds/creates the user, accepts a pending invitation, revokes any session the browser already had, sets a NEW session cookie;… |
| GET | `/api/auth/login` | Public |  | GET /api/auth/login?returnTo=/path&invite=<token>[&mode=signup][&login_hint=email] — starts OIDC (state + nonce + PKCE) and 302s to the IdP's passwordless sign-in page (D34: Continue with Google · or · email link + code… |
| POST | `/api/auth/logout` | Session (no workspace) |  | POST /api/auth/logout — revokes the server-side session, clears the cookie and returns the IdP's RP-initiated logout URL (ends the identity-provider session too) for the client to navigate to. |
| GET | `/api/auth/step-up` | Public |  | GET /api/auth/step-up?returnTo=/path[&mode=fresh\|mfa] — verify the CURRENT session with the second factor at the IdP (D34). fresh (default): acr_values=mfa → the authenticator-app code again (no new email), auth_time mu… |

### automation

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/automation/admin` | Session |  | GET /api/automation/admin → AI usage/budget + automation health, counts only (diagnostics.read). For the admin app (stream F). |
| GET | `/api/automation/catalog` | Session |  | GET /api/automation/catalog → triggers/actions with availability, channels, categories, emergency stop (automation.manage). |
| GET, POST | `/api/automation/emergency-stop` | Session |  | GET /api/automation/emergency-stop · POST {active} — workspace-wide stop; cancels queued automated replies. |
| GET, POST | `/api/automation/policies` | Session |  | GET /api/automation/policies · POST (create as draft). automation.manage. |
| GET, PATCH | `/api/automation/policies/{id}` | Session |  | GET /api/automation/policies/:id · PATCH (full policy; editing an active policy pauses it). |
| POST | `/api/automation/policies/{id}/status` | Session |  | POST /api/automation/policies/:id/status {status: active\|paused\|stopped, reason?} — activating makes you the owner. |
| GET, POST | `/api/automation/rules` | Session |  | GET /api/automation/rules?policy_id= · POST (create). automation.manage. |
| POST | `/api/automation/rules/test` | Session |  | POST /api/automation/rules/test (rule body) → dry run over recent data in scope. Changes and sends nothing. |
| GET, PUT, DELETE | `/api/automation/rules/{id}` | Session |  | GET /api/automation/rules/:id · PUT (full rule, ?version= for optimistic concurrency) · DELETE |
| POST | `/api/automation/rules/{id}/enabled` | Session |  | POST /api/automation/rules/:id/enabled {enabled} |
| GET | `/api/automation/runs` | Session |  | GET /api/automation/runs?rule_id=&subject_id=&limit= → execution history (no customer text). |

### billing

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/billing` | Session |  | GET /api/billing — Settings → Billing overview (billing.read). Stored state only; no provider call. |
| POST | `/api/billing/cancel` | Session |  | POST /api/billing/cancel — cancel renewal at period end (billing.manage). Service continues until then; nothing is deleted. |
| GET | `/api/billing/catalogue` | Public |  | GET /api/billing/catalogue — the public plan catalogue (Standard / Professional, GBP, per user per month, 14-day trial). Public. |
| POST, DELETE | `/api/billing/change` | Session | POST | POST /api/billing/change { plan, seats, proration_date, expected_version } (Idempotency-Key) — apply an upgrade / seat increase now or schedule a downgrade / seat reduction for period end (billing.manage). DELETE — undo… |
| POST | `/api/billing/checkout` | Session |  | POST /api/billing/checkout { plan, seats? } — start or reuse the one open hosted checkout (billing.manage). Returns the hosted URL; activation only ever comes from verified provider state (webhook / reconciliation), nev… |
| GET | `/api/billing/invoices` | Session |  | GET /api/billing/invoices — provider invoice links cached from verified events (billing.read). |
| POST | `/api/billing/portal` | Session |  | POST /api/billing/portal { flow?: 'payment_method_update' \| 'subscription_cancel' } — provider-hosted billing portal URL (billing.manage). |
| POST | `/api/billing/preview` | Session |  | POST /api/billing/preview { plan, seats } — provider-computed price, timing and proration for a plan/seat change (billing.manage). |
| POST | `/api/billing/reactivate` | Session |  | POST /api/billing/reactivate — undo a scheduled cancellation before the period ends (billing.manage). |
| POST | `/api/billing/refresh` | Session |  | POST /api/billing/refresh — re-fetch this workspace's checkout/subscription/invoices from the provider (billing.read). |
| GET | `/api/billing/seats` | Session |  | GET /api/billing/seats?add=1 — paid seats, billable users and the recurring total after adding seats (members.invite or billing.read). |
| GET, POST | `/api/billing/signup` | Session (no workspace) |  | GET /api/billing/signup — signup handoff context. POST { name, timezone, plan, brand_name? } — create the workspace and start its 14-day no-card trial on the selected plan (same transaction). Works without an active wor… |
| GET, POST | `/api/billing/test/checkout` | Session |  | Test mode only (deterministic billing test double; refused when Stripe or production is configured). GET /api/billing/test/checkout?session=cs_test_… — summary of a test hosted checkout owned by the active workspace. PO… |
| GET, POST | `/api/billing/test/portal` | Session |  | Test mode only. GET /api/billing/test/portal?session=bps_test_… — the test customer portal for the active workspace. POST { session, action } — update card, cancel/resume renewal, and simulate renewal / failed payment /… |
| POST | `/api/billing/trial` | Session |  | POST /api/billing/trial { plan } — start the workspace's one 14-day no-card trial (billing.manage; only if never redeemed). |
| POST | `/api/billing/trial/plan` | Session |  | POST /api/billing/trial/plan { plan } — switch the plan of the running trial; the end date never changes (billing.manage). |

### brand-rules

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| PATCH, DELETE | `/api/brand-rules/{id}` | Session |  | V3.1 §12 — PATCH/DELETE /api/brand-rules/:id — edit or archive a rule (brands.manage). Returns { rule?, impact }. |

### brands

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, POST | `/api/brands` | Session |  | GET /api/brands · POST /api/brands { name, timezone? } (owner/admin) |
| GET, PATCH | `/api/brands/{id}` | Session |  | GET /api/brands/:id · PATCH /api/brands/:id (owner/admin) |
| GET, PUT | `/api/brands/{id}/approval-policy` | Session |  | GET/PUT /api/brands/:id/approval-policy — 0/1/2 stages, quorum, eligible roles/teams/guests, separation of duties. Weakening requires brands.manage + fresh authentication (401 step_up_required); every change is audited. |
| GET | `/api/brands/{id}/asset-governance` | Session |  | V3.1 §12 — GET /api/brands/:id/asset-governance — assets needing attention (expired, expiring ≤14 d, superseded, archived). |
| GET | `/api/brands/{id}/assets` | Session |  | GET /api/brands/:id/assets?status=&tag=&q=&cursor=&limit= — { items, next_cursor } |
| GET | `/api/brands/{id}/assignment-options` | Session |  | GET /api/brands/:id/assignment-options — people/teams entitled to this brand right now. |
| GET, POST | `/api/brands/{id}/campaigns` | Session |  | GET/POST /api/brands/:id/campaigns — brand-scoped campaigns. |
| GET | `/api/brands/{id}/connections` | Session |  | GET /api/brands/:id/connections — connections of a brand (credentials are never returned). |
| POST | `/api/brands/{id}/connections/bluesky` | Session |  | POST /api/brands/:id/connections/bluesky { handle, app_password, service? } — verified with Bluesky before Ready. The app password is never logged or returned; it is stored envelope-encrypted to re-create expired sessio… |
| POST | `/api/brands/{id}/connections/mock` | Session |  | POST /api/brands/:id/connections/mock { provider, display_name, scenario? } — simulated destination (dev/demo only). |
| POST | `/api/brands/{id}/connections/telegram` | Session |  | POST /api/brands/:id/connections/telegram { bot_token, channel } — verified before Ready (AC-03). The bot token is never logged or returned. |
| POST | `/api/brands/{id}/connections/{provider}/start` | Session |  | POST /api/brands/:id/connections/:provider/start {} — begin OAuth (facebook, instagram, x). => { authorization_url } or 412 provider_not_configured. |
| GET, POST, PATCH | `/api/brands/{id}/content-queue` | Session |  | V3.1 §13 — evergreen content queue for a brand. GET (inspect) · POST { post_id } (add an eligible post) · PATCH { paused, reason? } (pause/resume). |
| POST | `/api/brands/{id}/content-queue/next` | Session | POST | V3.1 §13 — POST /api/brands/:id/content-queue/next 🔁 (Idempotency-Key) — schedule the first eligible item into the next free slot occurrence through the normal pipeline. One item per call; never recurring. |
| GET, PATCH | `/api/brands/{id}/duplicate-window` | Session |  | GET/PATCH /api/brands/:id/duplicate-window { duplicate_window_hours: 0..720 } — duplicate/collision warning window for this brand (0 = off). PATCH needs brands.manage on the brand; audited. |
| POST | `/api/brands/{id}/handover-export` | Session |  | POST /api/brands/:id/handover-export { format?: 'zip' \| 'json' } → the brand's handover bundle (content, revisions, delivery history, assets with 15-minute signed links). Needs exports.create on this brand; rate-limited… |
| POST | `/api/brands/{id}/imports` | Session |  | POST CSV preview (validation per row and destination). Creates nothing. |
| POST | `/api/brands/{id}/imports/commit` | Session | POST | POST commit a previewed CSV: creates DRAFTS for valid rows only. Never schedules or publishes. |
| POST | `/api/brands/{id}/pause` | Session |  | POST /api/brands/:id/pause { paused, reason? } (owner/admin/approver) |
| GET, POST | `/api/brands/{id}/posts` | Session | POST | GET list posts · POST create post (Idempotency-Key) |
| GET, PATCH | `/api/brands/{id}/profile` | Session |  | V3.1 §12 — GET/PATCH /api/brands/:id/profile — brand profile (tone, colours, approved logos, CTA default) + active rules. PATCH needs brands.manage; never rewrites content: the response lists affected drafts/schedules (… |
| GET | `/api/brands/{id}/rule-reviews` | Session |  | V3.1 §12 — GET /api/brands/:id/rule-reviews?status=open\|decided\|all — drafts/schedules affected by rule changes. |
| GET, POST | `/api/brands/{id}/rules` | Session |  | V3.1 §12 — GET/POST /api/brands/:id/rules — list active rules / add a rule { kind, value, replacement?, severity, providers?, note? }. |
| GET, POST | `/api/brands/{id}/slots` | Session |  | GET /api/brands/:id/slots (any member with brand access) · POST (owner/admin) { label?, weekdays[1-7], local_time HH:MM, timezone?, connection_ids } |
| GET, POST | `/api/brands/{id}/templates` | Session |  | GET /api/brands/:id/templates · POST /api/brands/:id/templates { name, body, tags? } |
| GET, PUT | `/api/brands/{id}/utm-defaults` | Session |  | V3.1 §14 — GET /api/brands/:id/utm-defaults?campaign_id= · PUT { campaign_id?, params } (brands.manage). |

### bulk

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, POST | `/api/bulk/jobs` | Session | POST | GET /api/bulk/jobs — my recent bulk jobs · POST — start a previewed bulk job (Idempotency-Key + preview_hash). |
| GET | `/api/bulk/jobs/{id}` | Session |  | GET /api/bulk/jobs/:id — status + per-item results (items on brands the caller can no longer read are omitted). |
| POST | `/api/bulk/jobs/{id}/cancel` | Session |  | POST /api/bulk/jobs/:id/cancel — skip the remaining pending items. |
| POST | `/api/bulk/jobs/{id}/retry` | Session |  | POST /api/bulk/jobs/:id/retry { item_ids? } — re-run failed items only (successes are never re-run). |
| POST | `/api/bulk/jobs/{id}/undo` | Session | POST | POST /api/bulk/jobs/:id/undo — start a job reversing each succeeded item (concurrency-checked). Idempotency-Key required. |
| POST | `/api/bulk/preview` | Session |  | POST /api/bulk/preview — affected items + permission/policy consequences + preview_hash. Read-only. |

### campaigns

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| PATCH | `/api/campaigns/{id}` | Session |  | PATCH /api/campaigns/:id — rename, dates, archive. |
| GET | `/api/campaigns/{id}/measurement` | Session |  | V3.1 §14 — GET /api/campaigns/:id/measurement — native social metrics, app-observed clicks, website events and attributed conversions, kept separate (never summed; unimplemented families are labelled, never estimated). |

### collab

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/collab/events` | Session |  | GET /api/collab/events?post=<id>&after=<cursor\|now> — change-feed polling fallback (same filtering as the stream). after=now returns only the current cursor (where a freshly loaded page starts listening). |
| GET | `/api/collab/stream` | Session |  | GET /api/collab/stream?post=<id>&after=<cursor> — Server-Sent Events for one post's collaboration changes plus the caller's own notification events. Small, content-free events ({ id, kind, ref_id }); the client refetche… |

### collaboration

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, PUT | `/api/collaboration/settings` | Session |  | GET /api/collaboration/settings · PUT (workspace.manage) — workspace collaboration settings. |

### comments

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| PATCH, DELETE | `/api/comments/{id}` | Session |  | PATCH /api/comments/:id { body } — author edits (previous text kept in the edit history). DELETE /api/comments/:id — author (or brand manager) deletes; a tombstone stays in the thread. |
| GET | `/api/comments/{id}/history` | Session |  | GET /api/comments/:id/history — previous versions of an edited comment (anyone who can see it). |

### connection-flows

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/connection-flows/{flowId}` | Session |  | GET /api/connection-flows/:flowId — destinations offered by an OAuth authorization (initiating user only). |
| POST | `/api/connection-flows/{flowId}/select` | Session |  | POST /api/connection-flows/:flowId/select { provider_account_ids } — AC-02 explicit choice. |

### connections

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/connections/{id}/check` | Session |  | POST /api/connections/:id/check — fresh provider health check. |
| POST | `/api/connections/{id}/disconnect` | Session |  | POST /api/connections/:id/disconnect => { connection, blocked_deliveries } (AC-05; credential deleted immediately). |
| PATCH | `/api/connections/{id}/mock-scenario` | Session |  | PATCH /api/connections/:id/mock-scenario { scenario } — simulated destinations only. |
| POST | `/api/connections/{id}/pause` | Session |  | POST /api/connections/:id/pause { paused } |
| POST | `/api/connections/{id}/reconnect` | Session |  | POST /api/connections/:id/reconnect — OAuth: {} => { authorization_url }; Telegram: { bot_token }; Bluesky: { app_password } => Connection. |
| GET | `/api/connections/{id}/tiktok-creator-info` | Session |  | GET /api/connections/:id/tiktok-creator-info — the TikTok creator's current posting settings (creator_info): privacy options and interactions turned off in TikTok. Read-only; the composer calls it when it shows TikTok s… |

### connectors

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, POST | `/api/connectors` | Session |  | GET /api/connectors?connector= — V3.5 integration installations (integrations.read) POST /api/connectors/simulated is not exposed here; see POST below (simulated only, never in production). |
| GET | `/api/connectors/gbp/locations` | Session |  | GET /api/connectors/gbp/locations?brand_id= — selected Google Business Profile locations (also used by the inbox for reviews) |
| POST | `/api/connectors/gbp/locations/{id}/metrics` | Session |  | POST /api/connectors/gbp/locations/:resourceId/metrics — refresh metrics for one location (explicit; stored) |
| GET | `/api/connectors/gbp/metrics/{id}` | Session |  | GET /api/connectors/gbp/metrics/:integrationId — stored location metrics |
| GET, POST | `/api/connectors/gbp/posts` | Session |  | GET /api/connectors/gbp/posts?post_id= · POST — Google local posts for a post's schedule (≤ 10 locations; count confirmed; follows approval) |
| DELETE | `/api/connectors/gbp/posts/{id}` | Session |  | DELETE /api/connectors/gbp/posts/:id — cancel a not-yet-sent Google post |
| GET | `/api/connectors/hub` | Session |  | GET /api/connectors/hub — Integrations hub: operator readiness ("needs app setup"), installations per connector. |
| POST | `/api/connectors/hub/operator` | Session |  | POST /api/connectors/hub/operator { connector } — connect with operator credentials (Cloud Translation). |
| POST | `/api/connectors/hub/simulated` | Session |  | POST /api/connectors/hub/simulated { connector, brand_id? } — simulated installation (development/demo only; refused in production). |
| GET, DELETE | `/api/connectors/hub/{id}` | Session |  | GET /api/connectors/hub/:id — installation detail (setup, resources) · DELETE — disconnect (provider revoke where offered; links kept as unavailable) |
| POST | `/api/connectors/hub/{id}/diagnose` | Session |  | POST /api/connectors/hub/:id/diagnose — live health check (explicit action; result stored + shown) |
| GET | `/api/connectors/hub/{id}/discover` | Session |  | GET /api/connectors/hub/:id/discover?type=&parent= — resources the provider offers for EXPLICIT selection (nothing imported) |
| PUT | `/api/connectors/hub/{id}/hubspot-defaults` | Session |  | PUT /api/connectors/hub/:id/hubspot-defaults { default_pipeline, default_stage } |
| GET | `/api/connectors/hub/{id}/jobs` | Session |  | GET /api/connectors/hub/:id/jobs — recent sync jobs (state, attempts, errors) |
| PUT | `/api/connectors/hub/{id}/scenario` | Session |  | PUT /api/connectors/hub/:id/scenario { scenario } — simulated installs only (outage, rate limit, lost response, revoked…) |
| POST | `/api/connectors/hub/{id}/webhook` | Session |  | POST /api/connectors/hub/:id/webhook { resource_id? } — Asana/monday: register "receive updates" on a project/board; Mailchimp: issue the webhook URL (key shown once) |
| GET | `/api/connectors/hubspot/cases/{id}` | Session |  | GET /api/connectors/hubspot/cases/:id?refresh=1 — ticket linked to a case (+ job state) |
| POST | `/api/connectors/hubspot/contacts/link` | Session |  | POST /api/connectors/hubspot/contacts/link { integration_id, customer_id, contact_id } — explicit, audited, reversible (DELETE /api/connectors/links/:id) |
| POST | `/api/connectors/hubspot/contacts/search` | Session |  | POST /api/connectors/hubspot/contacts/search { integration_id, email \| query } — masked results; linking is a separate explicit step |
| GET | `/api/connectors/hubspot/customers/{id}` | Session |  | GET /api/connectors/hubspot/customers/:id?refresh=1 — linked contact context (stored snapshot unless refresh) |
| POST | `/api/connectors/hubspot/notes` | Session |  | POST /api/connectors/hubspot/notes { case_id, text, approved: true } — the exact approved summary as a ticket note |
| POST | `/api/connectors/hubspot/tickets` | Session |  | POST /api/connectors/hubspot/tickets — case → ONE ticket (idempotent per case; durable job) |
| POST | `/api/connectors/hubspot/tickets/preview` | Session |  | POST /api/connectors/hubspot/tickets/preview — what leaves Relay |
| GET | `/api/connectors/jobs/{id}` | Session |  | GET /api/connectors/jobs/:id — sync job state (queued … succeeded \| failed \| unknown) |
| POST | `/api/connectors/jobs/{id}/retry` | Session |  | POST /api/connectors/jobs/:id/retry — explicit, audited retry of a failed or unconfirmed job |
| DELETE | `/api/connectors/links/{id}` | Session |  | DELETE /api/connectors/links/:id — unlink (reversible + audited; the external record is not touched) |
| POST | `/api/connectors/mailchimp/campaign-links` | Session |  | POST /api/connectors/mailchimp/campaign-links { integration_id, campaign_id, mailchimp_campaign_id } — link social ↔ email campaign |
| GET, POST | `/api/connectors/mailchimp/exports` | Session |  | GET /api/connectors/mailchimp/exports?post_id= · POST — draft campaign from approved content (never sends, never subscribes) |
| POST | `/api/connectors/mailchimp/exports/preview` | Session |  | POST /api/connectors/mailchimp/exports/preview — exact content + audience before export |
| POST | `/api/connectors/mailchimp/exports/refresh` | Session |  | POST /api/connectors/mailchimp/exports/refresh { post_id } — campaign status + report (explicit; stored) |
| GET | `/api/connectors/oauth/{connector}/callback` | Public |  | GET /api/connectors/oauth/:connector/callback — public redirect target; the state is consumed only by the session user who started the flow; authority re-checked; 302 → /integrations/<connector>?connected=<id> \| ?error=… |
| POST | `/api/connectors/oauth/{connector}/start` | Session |  | POST /api/connectors/oauth/:connector/start { brand_id?, reconnect_id? } → { authorization_url } (integrations.manage; needs operator app setup) |
| GET | `/api/connectors/registry` | Session |  | GET /api/connectors/registry — connector definitions (scopes, inbound mechanism, prerequisites, docs checked date). |
| GET | `/api/connectors/slack/deliveries` | Session |  | GET /api/connectors/slack/deliveries?integration_id= — delivery history |
| POST | `/api/connectors/slack/link` | Session |  | POST /api/connectors/slack/link { token } — the signed-in Relay user confirms the Slack identity that clicked (single use, 10 min) |
| GET | `/api/connectors/slack/links` | Session |  | GET /api/connectors/slack/links?integration_id= — Slack ↔ Relay identity links (explicit only) |
| DELETE | `/api/connectors/slack/links/{id}` | Session |  | DELETE /api/connectors/slack/links/:id — unlink (self, or integration managers) |
| GET, POST | `/api/connectors/slack/routes` | Session |  | GET /api/connectors/slack/routes?integration_id= · POST — channel alert preferences (categories, brands, quiet hours, rate) |
| DELETE | `/api/connectors/slack/routes/{id}` | Session |  | DELETE /api/connectors/slack/routes/:id |
| GET, POST | `/api/connectors/tasks` | Session |  | GET /api/connectors/tasks?relay_type=&relay_id= — external tasks linked to a Relay item · POST — create (Asana task / monday item; durable job) |
| POST | `/api/connectors/tasks/link` | Session |  | POST /api/connectors/tasks/link { integration_id, relay_type, relay_id, resource_id, external_ref } — link an existing task (URL or id) |
| POST | `/api/connectors/tasks/preview` | Session |  | POST /api/connectors/tasks/preview — exactly what would leave Relay (shown before creating) |
| GET, PATCH, DELETE | `/api/connectors/tasks/{id}` | Session |  | GET /api/connectors/tasks/:id · PATCH (Relay edit → push; explicit conflict resolution) · DELETE (unlink; external task untouched) |
| POST | `/api/connectors/tasks/{id}/refresh` | Session |  | POST /api/connectors/tasks/:id/refresh — read the external task now (explicit) |
| POST | `/api/connectors/translate` | Session |  | POST /api/connectors/translate — machine translation (original kept; never sends; workspace controls + caps) |
| GET | `/api/connectors/translate/languages` | Session |  | GET /api/connectors/translate/languages — target languages the provider supports |
| GET, PUT | `/api/connectors/translate/settings` | Session |  | GET /api/connectors/translate/settings · PUT — workspace control (off by default; billing acknowledged; customer content switch; cap) |
| POST | `/api/connectors/webhooks/{connector}` | Public |  | POST /api/connectors/webhooks/:connector[?i=<installation id>] — business-connector webhooks. Verified on the RAW body (Slack/HubSpot signed timestamps, Asana hook secret, monday JWT, Mailchimp URL key, WhatsApp X-Hub-S… |
| GET, PATCH, DELETE | `/api/connectors/{id}` | Session |  | GET /api/connectors/:id — health (events, jobs, activity, rate limits) · PATCH { paused, reason? } · DELETE (disconnect; links kept as unavailable) |
| GET, PUT | `/api/connectors/{id}/mappings` | Session |  | GET /api/connectors/:id/mappings · PUT one mapping (synchronization contract; protected fields never two-way) |
| GET, PUT | `/api/connectors/{id}/resources` | Session |  | GET /api/connectors/:id/resources · PUT { resources: [{ resource_type, external_id, name, url?, selected }] } — explicit selection only |

### content-hub

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/content-hub` | Session |  | GET /api/content-hub?brand_id= → ContentHubOverviewDto (stored data only; no source calls). |
| GET | `/api/content-hub/connections` | Session |  | GET /api/content-hub/connections → ContentConnectionDto[] visible to the caller (including disconnected, for history). |
| POST | `/api/content-hub/connections/notion-internal` | Session |  | POST /api/content-hub/connections/notion-internal { brand_id } — internal token for a TEST installation only. |
| POST | `/api/content-hub/connections/start` | Session |  | POST /api/content-hub/connections/start { source, brand_id\|null, reconnect_connection_id? } → { authorization_url } |
| POST | `/api/content-hub/connections/test` | Session |  | POST /api/content-hub/connections/test { source, brand_id } — labelled TEST connection (non-production only). |
| POST | `/api/content-hub/connections/{id}/disconnect` | Session |  | POST /api/content-hub/connections/:id/disconnect — revoke, wipe tokens, stop sync/writeback, hide previews. |
| GET | `/api/content-hub/connections/{id}/picker` | Session |  | GET /api/content-hub/connections/:id/picker?brand_id= → Picker config (API key, app id, client id). Never a token. |
| POST | `/api/content-hub/connections/{id}/watch` | Session |  | POST /api/content-hub/connections/:id/watch — optional Drive change notifications (manual refresh stays required). |
| POST | `/api/content-hub/connections/{id}/writeback` | Session |  | POST /api/content-hub/connections/:id/writeback { enabled } |
| POST | `/api/content-hub/exports` | Session | POST | POST /api/content-hub/exports — ReportExporter (new Doc / Drive file / Notion page). Destination + content checked independently. |
| POST | `/api/content-hub/exports/content-plan` | Session | POST | POST /api/content-hub/exports/content-plan { brand_id, campaign_id?, destination, title? } |
| GET | `/api/content-hub/exports/{id}` | Session |  | GET /api/content-hub/exports/:id |
| POST | `/api/content-hub/imports` | Session |  | POST /api/content-hub/imports — request an import (idempotent per source identity/version + brand + action + selection). |
| GET | `/api/content-hub/imports/{id}` | Session |  | GET /api/content-hub/imports/:id |
| GET, DELETE | `/api/content-hub/items/{id}` | Session |  | GET /api/content-hub/items/:id (item + snapshot history) · DELETE (delete snapshots + link; refused while on hold) |
| POST | `/api/content-hub/items/{id}/hold` | Session |  | POST /api/content-hub/items/:id/hold { hold } |
| PUT | `/api/content-hub/items/{id}/mapping` | Session |  | PUT /api/content-hub/items/:id/mapping { mapping, import_statuses, writeback, expected_version } |
| GET | `/api/content-hub/items/{id}/preview` | Session |  | GET /api/content-hub/items/:id/preview?kind=file\|document&mode=exclude\|accept\|inline — authorized import preview. |
| POST | `/api/content-hub/items/{id}/refresh` | Session | POST | POST /api/content-hub/items/:id/refresh → ImportDto (queued; diff + new draft revision when the worker runs). |
| GET | `/api/content-hub/items/{id}/rows` | Session |  | GET /api/content-hub/items/:id/rows?cursor — mapped row preview with row-level errors. |
| GET | `/api/content-hub/items/{id}/schema` | Session |  | GET /api/content-hub/items/:id/schema — Notion data source properties + saved mapping. |
| GET | `/api/content-hub/notion/search` | Session |  | GET /api/content-hub/notion/search?connection_id&brand_id&type=page\|data_source&q&cursor — objects shared with the connection. |
| GET | `/api/content-hub/oauth/{source}/callback` | Public |  | GET /api/content-hub/oauth/:source/callback — public redirect target; the state is consumed only by the session user who started the flow. 302 → /settings/connections/<source>?connected=<id> \| ?error=<code>. Provider te… |
| POST | `/api/content-hub/selection` | Session |  | POST /api/content-hub/selection — register Picker / Notion selections (server verifies each id with the saved authorization). |
| POST, PUT | `/api/content-hub/settings` | Session |  | PUT /api/content-hub/settings { snapshot_retention_days } · POST adopts the latest Notion webhook verification token (owner). |
| GET | `/api/content-hub/status` | Session |  | GET /api/content-hub/status → ContentHubSourceStatus[] (configuration readiness; no secret values). |
| GET | `/api/content-hub/writebacks` | Session |  | GET /api/content-hub/writebacks?brand_id&status |
| POST | `/api/content-hub/writebacks/{id}/resolve` | Session |  | POST /api/content-hub/writebacks/:id/resolve { decision: overwrite \| keep_external } |

### content-queue

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| DELETE | `/api/content-queue/items/{id}` | Session |  | V3.1 §13 — DELETE /api/content-queue/items/:id — remove a queued item (scheduled items: cancel the schedule instead). |

### dashboard

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/dashboard` | Session |  | (no description in code) |

### deliveries

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/deliveries/{id}/resolve` | Session |  | (no description in code) |
| POST | `/api/deliveries/{id}/retry` | Session |  | (no description in code) |

### diagnostics

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/diagnostics` | Session |  | GET /api/diagnostics (owner/admin) — { checks: [{ name, ok, detail }] } |

### entitlements

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/entitlements` | Session |  | GET /api/entitlements — the workspace's plan, features and access (every member; drives UI gating + upgrade prompts); usage allowances, held work and overrides for billing.read / workspace.manage holders. Server state o… |
| GET, PUT | `/api/entitlements/selections` | Session |  | GET /api/entitlements/selections — accounts/searches and which stay active under a lowered limit (billing.read or workspace.manage) · PUT { allowance, resource_ids } (billing.manage) — choose what stays active. Nothing… |

### feature-flags

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/feature-flags` | Session |  | V3.1 §16 — GET /api/feature-flags — effective flags for the active workspace (safe default: off). |
| PUT | `/api/feature-flags/{key}` | Session |  | V3.1 §16 — PUT /api/feature-flags/:key { enabled: true\|false\|null } — workspace override (workspace.manage, audited). |

### grants

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| DELETE | `/api/grants/{id}` | Session |  | DELETE /api/grants/:id — revoke a member grant (delegation ceiling; owner grants: owner + last-owner rule). |

### health

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/health` | Public |  | (no description in code) |

### help

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/help/bundle` | Session (no workspace) |  | GET /api/help/bundle — offline copy of the Help Centre (HC): static HTML (zip) of the articles this signed-in reader may open (their audiences, resolved on the server). Same builder as scripts/docs-bundle.mjs. Runbooks… |
| GET | `/api/help/search` | Public |  | GET /api/help/search?q=&limit= — Help Centre search (HC). Works signed out (public articles only); signed-in readers get what their audiences allow, resolved on the server from the session. Never returns article bodies. |

### history

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/history` | Session |  | (no description in code) |
| GET | `/api/history/export.csv` | Session |  | (no description in code) |

### inbox

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/inbox/capabilities` | Session |  | GET /api/inbox/capabilities — per-channel capability record (provider support vs what Relay implements). |
| GET, POST | `/api/inbox/cases` | Session |  | GET /api/inbox/cases?state=&brand_id=&owner=me · POST /api/inbox/cases { conversation_id, title, category?, priority?, owner_id?, sla_policy_id? } |
| GET, PATCH | `/api/inbox/cases/{id}` | Session |  | GET /api/inbox/cases/:id · PATCH { version, state?, resolution_reason?, priority?, owner_id?, title?, category? } (409 on stale version) |
| GET, POST | `/api/inbox/channels` | Session |  | GET /api/inbox/channels — channels in the caller's inbox brands (status, missing permissions, capability record) POST /api/inbox/channels { connection_id, enabled_types? } — use a connected account in the inbox (inbox.m… |
| POST | `/api/inbox/channels/integration` | Session |  | POST /api/inbox/channels/integration { integration_id, account_id, brand_id? } — add a WhatsApp number or a Google Business Profile location (selected in Integrations) to the inbox (inbox.manage). Stream B. |
| PATCH, DELETE | `/api/inbox/channels/{id}` | Session |  | PATCH /api/inbox/channels/:id { paused } · DELETE /api/inbox/channels/:id (history kept; queued replies cancelled) |
| PUT | `/api/inbox/channels/{id}/csat` | Session |  | PUT /api/inbox/channels/:id/csat { enabled } — satisfaction requests on this channel (inbox.manage; private chats only). |
| POST | `/api/inbox/channels/{id}/poll` | Session |  | POST /api/inbox/channels/:id/poll — "Check now" for a polling channel (inbox.manage). Stream B. |
| PUT | `/api/inbox/channels/{id}/rates` | Session |  | PUT /api/inbox/channels/:id/rates { rates: { marketing?: {amount, currency}, … } \| null } — operator-entered WhatsApp rate card used for the estimate shown before a charged send (Meta's rates vary by country). |
| POST | `/api/inbox/channels/{id}/simulate` | Session |  | POST /api/inbox/channels/:id/simulate { kind: dm\|comment, text, name?, thread?, minutes_ago? } — SIMULATED channels only; refused in production. Goes through the same parser + ingestion as a verified webhook. |
| POST | `/api/inbox/channels/{id}/telegram` | Session |  | POST /api/inbox/channels/:id/telegram { action: 'check' \| 'claim' \| 'release', confirm_no_other_consumer? } — the Telegram update-ownership plan (never overwrites another app's webhook; claim needs explicit confirmation… |
| GET, POST | `/api/inbox/channels/{id}/templates` | Session |  | GET /api/inbox/channels/:id/templates — cached approved WhatsApp templates (no provider call) POST /api/inbox/channels/:id/templates — refresh the list from Meta (inbox.manage) |
| GET | `/api/inbox/conversations` | Session |  | GET /api/inbox/conversations?queue=&brand_id=&channel_id=&kind=&assignee_id=&priority=&language=&label=&q=&cursor=&limit= |
| GET, PATCH | `/api/inbox/conversations/{id}` | Session |  | GET /api/inbox/conversations/:id?before= — detail + timeline (messages, internal notes, pending/failed sends, events) PATCH /api/inbox/conversations/:id — status (open\|waiting\|snoozed\|resolved\|spam), snoozed_until, prio… |
| POST | `/api/inbox/conversations/{id}/assign` | Session |  | POST /api/inbox/conversations/:id/assign { assignee_id \| null, team_id? } — assignee must have inbox access on the brand. |
| GET | `/api/inbox/conversations/{id}/assignees` | Session |  | GET /api/inbox/conversations/:id/assignees — people with inbox access on the conversation's brand (bounded). |
| GET, POST | `/api/inbox/conversations/{id}/csat` | Session |  | GET /api/inbox/conversations/:id/csat — satisfaction request state POST /api/inbox/conversations/:id/csat { idempotency_key } — send the request (a normal customer-facing send) |
| GET | `/api/inbox/conversations/{id}/customer` | Session |  | GET /api/inbox/conversations/:id/customer — provider identity, linked customer, other identities + conversations the viewer may read, and the link history. Stream B. |
| POST | `/api/inbox/conversations/{id}/customer/link` | Session |  | POST /api/inbox/conversations/:id/customer/link { customer_id \| new_customer_name, reason } — explicit, audited link. |
| POST | `/api/inbox/conversations/{id}/customer/unlink` | Session |  | POST /api/inbox/conversations/:id/customer/unlink { reason } — reversible: history is kept. |
| PUT | `/api/inbox/conversations/{id}/draft` | Session |  | PUT /api/inbox/conversations/:id/draft { mode, body, base_version } — server copy of the unsent reply (empty body deletes it). |
| POST | `/api/inbox/conversations/{id}/notes` | Session |  | POST /api/inbox/conversations/:id/notes { body, mentions? } — INTERNAL note. Never sent to the customer. |
| POST | `/api/inbox/conversations/{id}/presence` | Session |  | POST /api/inbox/conversations/:id/presence { state: viewing\|composing } — heartbeat; returns others here (informational only). |
| GET, POST | `/api/inbox/conversations/{id}/replies` | Session |  | GET /api/inbox/conversations/:id/replies — send attempts with their actual provider result. POST /api/inbox/conversations/:id/replies { mode, body, base_version, idempotency_key, acknowledge_version? } 201 queued (or 20… |
| GET | `/api/inbox/counts` | Session |  | GET /api/inbox/counts — per-queue counts for the caller's inbox brands. |
| GET | `/api/inbox/csat/report` | Session |  | GET /api/inbox/csat/report?days=&brand_id= — sent, responses, response rate, average and distribution (with definitions). |
| GET | `/api/inbox/customers` | Session |  | GET /api/inbox/customers?q=&brand_id= — pick an existing customer to link (picker only; never automatic). |
| GET | `/api/inbox/events` | Session |  | GET /api/inbox/events?after=<id> — content-free change feed (poll); clients refetch what changed. |
| GET | `/api/inbox/integrations/{id}/accounts` | Session |  | GET /api/inbox/integrations/:id/accounts — numbers (WhatsApp) or selected locations (Google Business Profile) that can become inbox channels, with the channel already using each one. Stream B. |
| GET | `/api/inbox/messages/{id}/attachments/{idx}` | Session |  | GET /api/inbox/messages/:id/attachments/:idx — an inbound attachment, fetched safely on first open, always served as a download (no inline rendering, nosniff, private cache). Authorization is checked on every request. |
| POST | `/api/inbox/messages/{id}/moderate` | Session |  | POST /api/inbox/messages/:id/moderate { action: 'hide' \| 'unhide' \| 'delete_own' } — only actions the network permits. |
| GET | `/api/inbox/replies/{id}` | Session |  | GET /api/inbox/replies/:id — one send attempt (poll for its result). |
| POST | `/api/inbox/replies/{id}/resolve` | Session |  | POST /api/inbox/replies/:id/resolve { outcome: sent \| not_sent } — a person settles an unconfirmed send after checking. |
| GET | `/api/inbox/report` | Session |  | GET /api/inbox/report?days=30&brand_id= — first response, resolution, backlog, breaches, reopened (with definitions) |
| GET, POST | `/api/inbox/saved-replies` | Session |  | GET /api/inbox/saved-replies?brand_id= · POST { brand_id?, title, body } (inbox.manage) |
| PATCH, DELETE | `/api/inbox/saved-replies/{id}` | Session |  | PATCH /api/inbox/saved-replies/:id · DELETE (archive) |
| GET, POST | `/api/inbox/sla-policies` | Session |  | GET /api/inbox/sla-policies (+ definitions) · POST (create or update with id) — inbox.manage |
| GET | `/api/inbox/stream` | Session |  | GET /api/inbox/stream?after=<id> — Server-Sent Events for the inbox (stream B; same pattern as /api/collab/stream). Small, content-free events ({ id, conversation_id, kind, at }) for conversations on brands the caller c… |
| POST | `/api/inbox/telegram/{id}` | Public |  | POST /api/inbox/telegram/:channelId — Telegram webhook for a channel whose updates Relay owns. Authenticated by the per-channel secret token (X-Telegram-Bot-Api-Secret-Token), persisted + deduplicated BEFORE the 200. |
| GET, POST | `/api/inbox/views` | Session |  | GET /api/inbox/views · POST { name, filters } — personal saved views |
| DELETE | `/api/inbox/views/{id}` | Session |  | DELETE /api/inbox/views/:id |
| POST | `/api/inbox/whatsapp/connect` | Session |  | POST /api/inbox/whatsapp/connect { brand_id, waba_id, phone_number_id, access_token } — protected setup form: the number is verified at Meta before anything is stored; the token goes to the encrypted vault and is never… |

### integrations

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/integrations/diagnostics` | Session |  | V3.1 §15 — GET /api/integrations/diagnostics?brand_id=&connection_id= — read-only integration test centre. Never calls a provider, never publishes, never returns tokens. |
| GET, PUT, DELETE | `/api/integrations/tipsignal/binding` | Session |  | Owner only. GET binding + signing-secret status (is_set/source only) · PUT { brand_id, acting_user_id } · DELETE (unbind). Audited. |
| POST | `/api/integrations/tipsignal/events` | Public |  | Signed TipSignal events → drafts (never posts). HMAC over `${t}.${rawBody}`, ±5 min window, dedupe on event_id. |

### invitations

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, POST | `/api/invitations` | Session | POST | GET /api/invitations — open invitations · POST 🔁 { email, role?, brand_ids?, grants?, team_ids?, access_expires_at? } Scoped grants are validated against the inviter's delegation ceiling. accept_url (token-bearing) is… |
| POST | `/api/invitations/accept` | Session (no workspace) |  | POST /api/invitations/accept { token } — a signed-in user joins another workspace with THEIR identity (issuer+subject; IdP-verified email must match). Switches the session to the new workspace. |
| POST | `/api/invitations/bulk` | Session | POST | POST /api/invitations/bulk 🔁 { rows: [...] } — per-row results; duplicates/members/pending reported. |
| GET | `/api/invitations/preview` | Public |  | GET /api/invitations/preview?token= (public) — { workspace_name, email_hint, role, expires_at, status } |
| DELETE | `/api/invitations/{id}` | Session |  | DELETE /api/invitations/:id — revoke. |
| POST | `/api/invitations/{id}/resend` | Session |  | POST /api/invitations/:id/resend — rotates the token (old link stops working) and restarts the expiry. |

### l

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/l/{code}` | Public |  | V3.1 §14 — GET /api/l/:code — public short-link redirect. NOT an open redirect: the only input is an unguessable code; the target is the stored, validated destination. Unknown/disabled codes get a plain 404 (no redirect… |

### links

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, POST | `/api/links` | Session |  | V3.1 §14 — GET /api/links?brand_id=&campaign_id= · POST { brand_id, campaign_id?, post_id?, url } — Relay short links. |
| POST | `/api/links/preview` | Session |  | V3.1 §14 — POST /api/links/preview { brand_id, campaign_id?, url, provider?, overrides? } — validated link with UTM params (existing params preserved, no duplicate keys) + origin of each param. Read-only. |
| POST | `/api/links/{id}/disable` | Session |  | V3.1 §14 — POST /api/links/:id/disable — the short link stops redirecting (404). |

### listening

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/listening/actions` | Session |  | POST /api/listening/actions { action: task\|case\|draft, observation_id\|alert_id\|search_id, idempotency_key } — insight → work |
| GET | `/api/listening/admin` | Session |  | GET /api/listening/admin — coverage + ingestion health (counts/states only; workspace.read). Admin screen: stream F. |
| GET | `/api/listening/alerts` | Session |  | GET /api/listening/alerts?brand_id=&state=&search_id= |
| GET, PATCH | `/api/listening/alerts/{id}` | Session |  | GET /api/listening/alerts/:id — alert + evidence (the real mentions counted) + coverage · PATCH { state } |
| PUT | `/api/listening/channels/{id}` | Session |  | PUT /api/listening/channels/:id { excluded } — exclude/include an inbox channel from listening (listening.manage) |
| GET, POST | `/api/listening/dashboards` | Session |  | GET /api/listening/dashboards?brand_id= · POST { brand_id, name, widgets, shared } |
| GET, PATCH, DELETE | `/api/listening/dashboards/{id}` | Session |  | GET/PATCH/DELETE /api/listening/dashboards/:id |
| GET, PATCH | `/api/listening/mentions/{id}` | Session |  | GET /api/listening/mentions/:id · PATCH { sentiment: label\|null } \| { excluded, reason } (listening.manage) |
| POST | `/api/listening/rules` | Session |  | POST /api/listening/rules — create a spike alert rule (listening.manage) |
| PATCH, DELETE | `/api/listening/rules/{id}` | Session |  | PATCH /api/listening/rules/:id { …, expected_version } · DELETE (archive) |
| GET, POST | `/api/listening/searches` | Session |  | GET /api/listening/searches?brand_id= · POST /api/listening/searches (listening.manage) |
| POST | `/api/listening/searches/preview` | Session |  | POST /api/listening/searches/preview — test a definition against stored mentions (last 30 days) without saving |
| GET, PATCH, DELETE | `/api/listening/searches/{id}` | Session |  | GET /api/listening/searches/:id (+ versions) · PATCH { …definition, expected_version } · DELETE (archive) |
| GET | `/api/listening/searches/{id}/mentions` | Session |  | GET /api/listening/searches/:id/mentions?days=\|from=&to=&dataset= — with coverage (sources, history, query version, denominators) |
| GET | `/api/listening/searches/{id}/rules` | Session |  | GET /api/listening/searches/:id/rules — spike alert rules of a search |
| GET | `/api/listening/searches/{id}/sentiment` | Session |  | GET /api/listening/searches/:id/sentiment?days=\|from=&to=&dataset= — with coverage (sources, history, query version, denominators) |
| GET | `/api/listening/searches/{id}/summary` | Session |  | GET /api/listening/searches/:id/summary?days=\|from=&to=&dataset= — with coverage (sources, history, query version, denominators) |
| GET | `/api/listening/searches/{id}/timeline` | Session |  | GET /api/listening/searches/:id/timeline?days=\|from=&to=&dataset= — with coverage (sources, history, query version, denominators) |
| GET | `/api/listening/searches/{id}/topics` | Session |  | GET /api/listening/searches/:id/topics?days=\|from=&to=&dataset= — with coverage (sources, history, query version, denominators) |
| GET | `/api/listening/share-of-voice` | Session |  | GET /api/listening/share-of-voice?search_ids=a,b&days= — within observed data, comparable sources only |
| GET | `/api/listening/sources` | Session |  | GET /api/listening/sources?brand_id= — coverage registry (connected + broad sources, channels, monitoring start) |

### mcp

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/mcp` | Session |  | GET /api/mcp — Settings → Developer → MCP overview: setup (generated from live config) + clients visible to the caller. |
| GET | `/api/mcp/audit` | Session |  | GET /api/mcp/audit?client_row_id=&cursor=&limit= — MCP call audit (own clients; whole workspace with audit.read). |
| GET | `/api/mcp/clients/{id}` | Session |  | GET /api/mcp/clients/:id — consent page data (the caller's own registration only). |
| POST | `/api/mcp/clients/{id}/consent` | Session |  | POST /api/mcp/clients/:id/consent — approve/edit a client for this workspace (scopes, brands). Step-up required. |
| POST | `/api/mcp/clients/{id}/revoke` | Session |  | POST /api/mcp/clients/:id/revoke — revoke a client (its own owner, or service_accounts.manage). Immediate. |
| GET | `/api/mcp/intents/{id}` | Session |  | GET /api/mcp/intents/:id — what an MCP client asked to publish (only the person it acts for). |
| POST | `/api/mcp/intents/{id}/confirm` | Session |  | POST /api/mcp/intents/:id/confirm — the trusted, server-side confirmation for ONE publication intent. Session + CSRF + Origin (route()), same person the client acts for, authority on the brand, step-up/MFA. |
| POST | `/api/mcp/intents/{id}/decline` | Session |  | POST /api/mcp/intents/:id/decline — refuse an intent (it can never be committed). |
| GET | `/api/mcp/jobs/{id}/download` | Session |  | GET /api/mcp/jobs/:id/download — CSV produced by an MCP report export (signed-in, exports.create on the brand). |
| GET, POST | `/api/mcp/policies` | Session |  | GET /api/mcp/policies — automation policies · POST create (step-up; for the caller's own approved client). |
| POST | `/api/mcp/policies/{id}/revoke` | Session |  | POST /api/mcp/policies/:id/revoke — revoke an automation policy (its owner, or service_accounts.manage). |
| GET, POST, DELETE, OPTIONS | `/mcp` | MCP bearer |  | /mcp — Relay MCP endpoint (Streamable HTTP, MCP revision 2025-11-25, @modelcontextprotocol/sdk 1.32.2). All protocol, authentication (OAuth bearer / API key), Origin/Host validation, sessions and limits live in packages… |

### members

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/members` | Session |  | GET /api/members?q=&status=&team_id=&role= — V2 member directory (members.read): grants (scope, source, expiry), teams, status, last sign-in; plus open invitations for those who may invite. |
| GET, PATCH, DELETE | `/api/members/{userId}` | Session |  | GET /api/members/:userId · PATCH { role?, brand_ids? } (legacy "set role", translated to scoped grants) DELETE { reassign_to?, reason? } → removal (handover optional). Owners change only via ownership transfer. |
| GET | `/api/members/{userId}/access` | Session |  | GET /api/members/:userId/access — effective access: brands/connections, actions, source grant (direct/team), expiry, restrictions and the policy version used. |
| POST | `/api/members/{userId}/grants` | Session |  | POST /api/members/:userId/grants { role, brand_id?, connection_id?, expires_at? } — add a scoped grant. Scope, workspace, granted_by and source are derived server-side; unknown keys are rejected. |
| GET, POST | `/api/members/{userId}/handover` | Session |  | GET /api/members/:userId/handover — what is affected (drafts, approvals, scheduled, service accounts, connections) + authorised candidates per affected brand. POST { to_user_id, items? } — reassign. |
| GET | `/api/members/{userId}/history` | Session |  | GET /api/members/:userId/history — membership status history (active/suspended/removed transitions). |
| POST | `/api/members/{userId}/reactivate` | Session |  | POST /api/members/:userId/reactivate — end a suspension (held publications stay held until adopted). |
| GET | `/api/members/{userId}/removal-impact` | Session |  | GET /api/members/:userId/removal-impact — handover preview (kept for the V1 removal dialog). |
| GET, POST | `/api/members/{userId}/restrictions` | Session |  | GET /api/members/:userId/restrictions · POST { actions[], brand_id?, reason?, expires_at? } — explicit deny. |
| POST | `/api/members/{userId}/scope` | Session |  | POST /api/members/:userId/scope { brand_ids } — scope reduction: revoke direct grants on these brands. |
| POST | `/api/members/{userId}/suspend` | Session |  | POST /api/members/:userId/suspend { reason? } — temporary suspension (distinct from removal). |

### meta

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/meta/data-deletion` | Public |  | Meta "Data Deletion Request URL": <APP_BASE_URL>/api/meta/data-deletion → { url, confirmation_code }. |
| GET | `/api/meta/data-deletion/status` | Public |  | (no description in code) |
| POST | `/api/meta/deauthorize` | Public |  | Meta "Deauthorize callback URL": <APP_BASE_URL>/api/meta/deauthorize (signed_request, form-encoded). |

### notification-preferences

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, PUT | `/api/notification-preferences` | Session |  | GET/PUT /api/notification-preferences — per event type in-app/email/digest, quiet hours, digest hour. |

### notifications

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/notifications` | Session |  | GET /api/notifications?unread=1&category=mentions\|discussion\|tasks\|reviews\|reminders\|publishing&cursor= — { items, unread_count, next_cursor } |
| POST | `/api/notifications/read-all` | Session |  | POST /api/notifications/read-all |
| POST | `/api/notifications/{id}/open` | Session |  | POST /api/notifications/:id/open — re-check access, mark read, return the page to open. Never acts on the resource. |
| POST | `/api/notifications/{id}/read` | Session |  | POST /api/notifications/:id/read |
| POST | `/api/notifications/{id}/unread` | Session |  | POST /api/notifications/:id/unread — mark one notification unread again. |

### oauth

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/oauth/{provider}/callback` | Public |  | GET /api/oauth/:provider/callback — public (provider redirect) but REQUIRES the current session user to be the user who started the flow. 302 => /accounts/select?flow=<id> or /accounts?error=<code>. Provider error text… |

### onboarding

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, PATCH | `/api/onboarding` | Session |  | V3.1 §7 — GET /api/onboarding — resumable, role-adapted checklist + per-connection readiness. PATCH { dismissed?, acknowledge?, unacknowledge? } — the viewer's own choices only. |

### ops

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/ops` | Session |  | (no description in code) |
| GET | `/api/ops/workload` | Session |  | GET /api/ops/workload?window_minutes=60 — V3.1 workload classes, publishing pressure, queue age vs dispatch delay vs processing time (provider time separate). Contract: packages/core/src/contracts/v31-perf.ts. Permissio… |

### planner

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/planner` | Session |  | (no description in code) |

### platform

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/platform/me` | Session (no workspace) |  | GET /api/platform/me — is this user a platform operator, and is the session fresh enough for platform changes. |
| GET | `/api/platform/v1/status` | Public |  | GET /api/platform/v1/status — installation status for the Vitalos Super Admin (ADR-044): aggregates only, Bearer token (RELAY_PLATFORM_STATUS_TOKEN), 404 when not configured, no-store. Server-to-server: no session, cook… |

### posts

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, PATCH | `/api/posts/{id}` | Session |  | GET post detail · PATCH autosave draft (expected_version) |
| GET | `/api/posts/{id}/activity` | Session |  | GET /api/posts/:id/activity?cursor= — who did what on this post (no comment text). |
| POST | `/api/posts/{id}/ai/suggest` | Session |  | POST /api/posts/:id/ai/suggest {task, connection_ids?, tone?, source_url?, source_post_id?} → {suggestions:[{scope, before, text, hashtags, note, issues, rejected}], usage, fixture, model, post_version, notices} Suggest… |
| POST | `/api/posts/{id}/archive` | Session |  | (no description in code) |
| PUT | `/api/posts/{id}/autosave` | Session |  | PUT /api/posts/:id/autosave — V3.1 debounced autosave (base_version + per-tab client_revision). 409 version_conflict carries the current server copy (details.current) and the kept conflict copy id. Contract: core/contra… |
| POST | `/api/posts/{id}/brand-check` | Session |  | V3.1 §12 — POST /api/posts/:id/brand-check { connection_ids?, at? } — read-only brand rule evaluation for the composer ({ ok, mandatory[], advisory[] }). Mandatory findings are also enforced by submit/schedule/publish. |
| GET, POST | `/api/posts/{id}/comments` | Session |  | GET/POST /api/posts/:id/comments — internal notes (staff with comments.internal) and shared comments. |
| GET | `/api/posts/{id}/compare` | Session |  | GET /api/posts/:id/compare?from=<version id\|current\|revision:<id>>&to=... — structured comparison (lazy-loaded). |
| GET | `/api/posts/{id}/deliveries` | Session |  | (no description in code) |
| POST | `/api/posts/{id}/duplicate` | Session | POST | (no description in code) |
| GET, PUT | `/api/posts/{id}/evergreen` | Session |  | V3.1 §13 — GET /api/posts/:id/evergreen (eligibility) · PUT { evergreen, expires_at?, note? } (explicit marking). |
| GET | `/api/posts/{id}/history` | Session |  | GET /api/posts/:id/history?cursor= — paginated versions with change summaries + submitted revisions (reviews, publications). |
| GET | `/api/posts/{id}/mentions` | Session |  | GET /api/posts/:id/mentions?visibility=internal\|shared&q= — bounded search of people who can see this discussion. |
| GET, PATCH | `/api/posts/{id}/planning` | Session |  | GET/PATCH /api/posts/:id/planning — campaign, assignee (must be entitled to the brand), due date, owning team. |
| GET, POST | `/api/posts/{id}/presence` | Session |  | GET /api/posts/:id/presence — who is viewing / editing (informational only). POST /api/posts/:id/presence { client_id, state: viewing\|editing\|left } — heartbeat; returns the current list. |
| GET | `/api/posts/{id}/provenance` | Session |  | V3.1 §13 — GET /api/posts/:id/provenance — { derived_from, derivatives[] }. |
| POST | `/api/posts/{id}/publish` | Session | POST | POST publish now (202) — same durable pipeline as scheduling. Idempotency-Key required. |
| POST | `/api/posts/{id}/readiness` | Session |  | POST /api/posts/:id/readiness { mode, connection_ids, input_local_time?, timezone?, offset?, deadline_minutes? } Read-only publishing preflight: every reason (permission, tokens, media, approval, deadline, provider limi… |
| POST | `/api/posts/{id}/recover` | Session |  | POST /api/posts/:id/recover — sync content recovered from browser storage. Permission and revision are re-checked; a newer server version is never overwritten (the content is kept as a conflict copy). Never schedules or… |
| GET | `/api/posts/{id}/recovery-status` | Session |  | GET /api/posts/:id/recovery-status?base_version=N — call before offering to sync recovered local content. |
| POST | `/api/posts/{id}/reuse` | Session |  | V3.1 §13 — POST /api/posts/:id/reuse { mode: reuse\|duplicate, title? } — new draft with provenance, eligibility and similar-post warnings per destination. TipSignal picks/results are refused (never recycled). |
| GET, POST | `/api/posts/{id}/review-shares` | Session |  | GET/POST /api/posts/:id/review-shares — share this post's review requests with a guest of the brand. |
| DELETE | `/api/posts/{id}/review-shares/{userId}` | Session |  | DELETE /api/posts/:id/review-shares/:userId — revoke (takes effect on the guest's next request). |
| POST | `/api/posts/{id}/schedule` | Session | POST | POST schedule (202). Idempotency-Key required. |
| GET | `/api/posts/{id}/similar` | Session |  | V3.1 §13 — GET /api/posts/:id/similar?days=30 — similar-post warnings per destination (V2 duplicate detection). |
| POST | `/api/posts/{id}/submit` | Session | POST | POST submit for review (202). Idempotency-Key required. |
| GET, POST | `/api/posts/{id}/threads` | Session |  | GET /api/posts/:id/threads?status=open\|resolved\|all&cursor=&approval_id= — one page of discussion threads (staff). POST /api/posts/:id/threads — start a thread { visibility, body, anchor?, approval_id?, client_key? }. |
| POST | `/api/posts/{id}/threads/read` | Session |  | POST /api/posts/:id/threads/read { thread_ids? } — mark threads read for the caller (unread indicators). |
| POST | `/api/posts/{id}/validate` | Session |  | (no description in code) |
| GET | `/api/posts/{id}/versions` | Session |  | GET /api/posts/:id/versions — draft versions (incl. conflict copies) + immutable revisions. |
| POST | `/api/posts/{id}/versions/{versionId}/restore` | Session |  | POST /api/posts/:id/versions/:versionId/restore — restore as the working draft (optimistic concurrency). |

### providers

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/providers` | Session |  | GET /api/providers — provider app configuration status (no secrets). |

### publication-holds

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/publication-holds` | Session |  | GET /api/publication-holds — adoption queue: queued publications held because their scheduling authority (or a required approver) lost rights. can_adopt per item for the caller. |

### queue

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, POST | `/api/queue` | Session | POST | GET /api/queue?brand_id=&days= — upcoming slot occurrences (free / taken / DST-skipped). POST /api/queue 🔁 { post_id, expected_version, slot_id? } — "Add to queue": next free slot via the normal scheduling pipeline (su… |

### ready

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/ready` | Public |  | GET /api/ready (public) — { status, checks: { database, migrations } }; 503 when not ready. |

### release-notes

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, POST | `/api/release-notes` | Session |  | V3.1 §16 — GET /api/release-notes — changelog for this version + unseen count. POST { version } marks seen. |

### restrictions

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| DELETE | `/api/restrictions/{id}` | Session |  | DELETE /api/restrictions/:id — lift an explicit restriction (never auto-releases held publications). |

### review

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/review` | Session |  | GET /api/review — the caller's shared review requests (guest portal). |
| GET | `/api/review/me` | Session |  | GET /api/review/me — { guest_only } so the main app can send guests to the review portal. |
| GET | `/api/review/{id}` | Session |  | GET /api/review/:id — exact outgoing variants, media previews, shared comments, stage progress (share re-checked). |
| POST | `/api/review/{id}/approve` | Session |  | POST /api/review/:id/approve — explicit approval (never triggered by a link or notification click). |
| POST | `/api/review/{id}/comments` | Session |  | POST /api/review/:id/comments — shared comment from the review portal. |
| POST | `/api/review/{id}/reject` | Session |  | POST /api/review/:id/reject — request changes (reason required). |

### rule-reviews

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/rule-reviews/{id}/decision` | Session |  | V3.1 §12 — POST /api/rule-reviews/:id/decision { decision: keep\|will_edit\|cancel_schedule, note? } — explicit, audited. |

### schedules

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/schedules/{id}/adopt` | Session |  | POST /api/schedules/:id/adopt — an authorised publisher adopts a held publication: revalidates the approval/approvers, becomes the scheduling authority and re-queues (expired if past publish-before). |
| POST | `/api/schedules/{id}/cancel` | Session |  | (no description in code) |
| POST | `/api/schedules/{id}/reschedule` | Session | POST | (no description in code) |

### search

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/search` | Session |  | GET /api/search?q=&kinds=post,campaign&limit=&include_archived= — authorized global search (command menu). Aborting the request (client cancels an obsolete query) cancels the SQL statement. Never cached. |
| GET, POST | `/api/search/recent` | Session |  | GET /api/search/recent — my recent items (re-authorized) · POST { kind, id } — record that I opened an item. |

### security

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/security` | Session (no workspace) |  | GET /api/security — the caller's own assurance, sign-in factors (from the IdP), sessions and recent security events. |
| POST | `/api/security/factors` | Session (no workspace) |  | POST /api/security/factors { action, credential_id? } — start a Keycloak application-initiated action for the caller's OWN account (set up TOTP / passkey / recovery codes, or remove a factor). Removal, regeneration and… |
| POST | `/api/security/sessions/revoke-others` | Session (no workspace) |  | POST /api/security/sessions/revoke-others — sign out every other session of the caller. |
| DELETE | `/api/security/sessions/{id}` | Session (no workspace) |  | DELETE /api/security/sessions/:id — revoke one of the caller's own sessions (takes effect on its next request). |

### service-accounts

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, POST | `/api/service-accounts` | Session | POST | GET /api/service-accounts — owner/admin list (keys by prefix only) · POST create (step-up) → first key shown ONCE. |
| POST | `/api/service-accounts/{id}/disable` | Session |  | POST /api/service-accounts/:id/disable — every key stops working immediately; grants revoked. |
| POST | `/api/service-accounts/{id}/keys` | Session |  | POST /api/service-accounts/:id/keys { label?, expires_at? } — new key (step-up), shown ONCE. |
| DELETE | `/api/service-accounts/{id}/keys/{keyId}` | Session |  | DELETE /api/service-accounts/:id/keys/:keyId — revoke immediately. |
| POST | `/api/service-accounts/{id}/keys/{keyId}/rotate` | Session |  | POST /api/service-accounts/:id/keys/:keyId/rotate — replacement key (step-up, shown ONCE); old key revoked now. |

### session

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/session` | Session (no workspace) |  | GET /api/session — SessionInfo (user, csrf token, active workspace, permissions). |
| POST | `/api/session/workspace` | Session (no workspace) |  | POST /api/session/workspace { workspace_id } — switch the active workspace. |

### setup

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/setup` | Session |  | GET /api/setup (owner) — grouped configuration readiness. Secrets are never returned. |
| PUT | `/api/setup/{key}` | Session |  | PUT /api/setup/:key { value } (owner) — store a provider/AI/TipSignal setting (secrets encrypted, write-only). An empty value clears a setting entered here. Env-provided settings are read-only (409). |

### slots

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| PATCH, DELETE | `/api/slots/{id}` | Session |  | PATCH /api/slots/:id (owner/admin) — never moves posts already queued · DELETE /api/slots/:id (archive) |

### support

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/support/attachments` | Session |  | V4 Relay support — POST /api/support/attachments { filename, content_type, size }: upload intent (private storage, quarantined until validated). |
| GET | `/api/support/attachments/{id}` | Session |  | V4 Relay support — GET /api/support/attachments/:id: authorized download (re-checked per request; never internal-note files). |
| POST | `/api/support/attachments/{id}/complete` | Session |  | V4 Relay support — POST /api/support/attachments/:id/complete: validate the uploaded bytes (type, size, signature) → ready \| rejected. |
| GET | `/api/support/participants` | Session |  | V4 Relay support — GET /api/support/participants: members the caller may add to a request (needs members.read). |
| GET, POST | `/api/support/reports` | Session |  | V3.1 §16 — POST /api/support/reports { category, summary, route?, app_version?, occurred_at?, correlation_ids?, include_draft_post_id? } — redacted problem report. GET (audit.read) lists the workspace's reports. |
| GET, POST | `/api/support/reports/{id}/share` | Session | POST | V4 Relay support — GET /api/support/reports/:id/share: what would be shared (review); POST { diagnostics[], include_draft_excerpt?, category?, subject?, message?, ticket_id? } (Idempotency-Key): explicitly send this pro… |
| GET, POST | `/api/support/requests` | Session | POST | V4 Relay support — GET /api/support/requests?scope=mine\|workspace&status=open\|resolved\|all&q=&cursor= (requests the caller may see); POST { category, subject, message, attachment_ids?, diagnostics? } (Idempotency-Key) c… |
| GET | `/api/support/requests/{ref}` | Session |  | V4 Relay support — GET /api/support/requests/:ref (RLY-… or id): one request the caller may see (public messages only; marks it read). |
| GET | `/api/support/requests/{ref}/events` | Session |  | V4 Relay support — GET /api/support/requests/:ref/events?after=<id>: content-free change feed (customer audience only); the client refetches the request through the authorized API when something changed. |
| POST | `/api/support/requests/{ref}/messages` | Session | POST | V4 Relay support — POST /api/support/requests/:ref/messages { body, attachment_ids? } (Idempotency-Key): customer reply. |
| POST | `/api/support/requests/{ref}/participants` | Session |  | V4 Relay support — POST /api/support/requests/:ref/participants { user_id }: add a member of this workspace. |
| DELETE | `/api/support/requests/{ref}/participants/{userId}` | Session |  | V4 Relay support — DELETE /api/support/requests/:ref/participants/:userId: remove a participant (or leave). |
| POST | `/api/support/requests/{ref}/reopen` | Session |  | V4 Relay support — POST /api/support/requests/:ref/reopen: reopen a resolved request (inside the reopen window). |
| POST | `/api/support/requests/{ref}/resolve` | Session |  | V4 Relay support — POST /api/support/requests/:ref/resolve: the customer marks the request resolved. |
| GET | `/api/support/requests/{ref}/transcript` | Session |  | V4 Relay support — GET /api/support/requests/:ref/transcript: plain-text export of the public conversation. |

### tasks

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, POST | `/api/tasks` | Session |  | GET /api/tasks?view=mine\|created\|team&status=open\|done\|all&due=overdue\|upcoming\|none\|reassign&brand_id&post_id&approval_id&assignee_id&cursor POST /api/tasks — create a task linked to a post, campaign or review request. |
| GET | `/api/tasks/assignees` | Session |  | GET /api/tasks/assignees?brand_id=&q= — bounded search of people who can be assigned on a brand. |
| GET | `/api/tasks/workload` | Session |  | GET /api/tasks/workload?brand_id= — my counts + team workload (open / overdue / due this week per assignee). |
| GET, PATCH | `/api/tasks/{id}` | Session |  | GET /api/tasks/:id — task with followers and activity history. PATCH /api/tasks/:id — { expected_version, ...fields, status, assignee_id } (optimistic concurrency). |
| POST, DELETE | `/api/tasks/{id}/follow` | Session |  | POST /api/tasks/:id/follow · DELETE /api/tasks/:id/follow — follow / unfollow a task. |

### teams

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, POST | `/api/teams` | Session |  | GET /api/teams?q=&archived= — teams directory (teams.read) · POST { name, description? } (teams.manage). |
| GET, PATCH | `/api/teams/{id}` | Session |  | GET /api/teams/:id (members, grants, ceiling) · PATCH { name?, description?, archived? }. |
| GET | `/api/teams/{id}/candidates` | Session |  | GET /api/teams/:id/candidates — active workspace members not yet in the team (picker). |
| PUT | `/api/teams/{id}/delegation` | Session |  | PUT /api/teams/:id/delegation { grantable_roles, brand_ids } — ceiling for this team's managers. |
| POST | `/api/teams/{id}/grants` | Session |  | POST /api/teams/:id/grants { role, brand_id?, connection_id? } — team grant (team roles only; ceiling of the actor). |
| DELETE | `/api/teams/{id}/grants/{grantId}` | Session |  | DELETE /api/teams/:id/grants/:grantId — revoke a team grant (holds affected queued publications). |
| POST | `/api/teams/{id}/members` | Session |  | POST /api/teams/:id/members { user_id, is_manager? } — admins, or this team's managers within the ceiling. Joining a team with grants is a privilege grant (ceiling-checked + audited). |
| PATCH, DELETE | `/api/teams/{id}/members/{userId}` | Session |  | DELETE /api/teams/:id/members/:userId · PATCH { is_manager } (admins only). |

### templates

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| PATCH, DELETE | `/api/templates/{id}` | Session |  | PATCH /api/templates/:id { name?, body?, tags? } · DELETE /api/templates/:id (archive) |

### threads

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, PATCH | `/api/threads/{id}` | Session |  | GET /api/threads/:id — one thread with all replies (staff, or a guest for shared threads of a shared review). PATCH /api/threads/:id — { resolved } or { visibility, confirm_count } (explicit, audited visibility change). |
| POST | `/api/threads/{id}/replies` | Session |  | POST /api/threads/:id/replies { body, client_key? } — reply (a retried client_key returns the original reply). |

### trash

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET | `/api/trash` | Session |  | GET /api/trash?kind=post\|asset&brand_id=&cursor=&limit= — trashed items the caller can read. |
| GET | `/api/trash/consequences` | Session |  | GET /api/trash/consequences?kind=&id= — what deleting this item means (shown before confirming). |
| POST | `/api/trash/items` | Session |  | POST /api/trash/items — move a post or asset to Trash. Returns an undo token (POST /api/trash/restore). |
| POST | `/api/trash/restore` | Session |  | POST /api/trash/restore — restore from Trash (permission re-checked; never republishes). expected_deleted_at = undo check. |

### v1

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/v1/drafts` | API key | POST | POST /api/v1/drafts { brand_id, title?, text } — create a DRAFT as the calling service account. Requires content.create_draft on that brand (integration preset). Never schedules or publishes. Optional Idempotency-Key: a… |
| GET | `/api/v1/me` | API key |  | GET /api/v1/me — the calling service account (API key auth): name, workspace, brand-scoped grants. |

### webhooks

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/webhooks/google-drive` | Public |  | POST /api/webhooks/google-drive — Drive push notifications (empty body; channel id + token headers). Signal only. |
| POST | `/api/webhooks/notion` | Public |  | POST /api/webhooks/notion — verified (X-Notion-Signature over the raw body), deduplicated; signal only. |
| POST | `/api/webhooks/stripe` | Public |  | POST /api/webhooks/stripe — billing provider webhooks. Raw body + Stripe-Signature (v1 HMAC, 5 min tolerance, rotation) are verified before anything is stored; duplicates are acknowledged without re-processing; processi… |
| GET, POST | `/api/webhooks/{provider}` | Public |  | Provider webhooks: authenticated on the raw body, persisted and deduplicated before acknowledging. |

### widget

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/widget/attachments` | Widget |  | V5 WID — POST /api/widget/attachments { filename, content_type, size, workspace_id?, reference? }: upload intent through the V4 quarantine pipeline (private bucket, presigned POST, server-side validation before a file c… |
| GET | `/api/widget/attachments/{id}` | Widget |  | V5 WID — GET /api/widget/attachments/:id: authorized download, re-checked per request (never internal-note files). |
| POST | `/api/widget/attachments/{id}/complete` | Widget |  | V5 WID — POST /api/widget/attachments/:id/complete: validate the uploaded bytes (type, size, signature) — owner only. |
| POST | `/api/widget/conversations` | Widget |  | V5 WID — POST /api/widget/conversations: start a conversation (a V4 support ticket, source 'widget'). Member: { client_id, workspace_id?, message, topic?, attachment_ids? } — workspace validated on the server. Visitor:… |
| GET | `/api/widget/conversations/{ref}` | Widget |  | V5 WID — GET /api/widget/conversations/:ref?after=<cursor>: one conversation the caller may see (visitor identity / verified email, or the member's V4 visibility). after=0 → full history; after>0 → only what was publish… |
| POST | `/api/widget/conversations/{ref}/messages` | Widget |  | V5 WID — POST /api/widget/conversations/:ref/messages { client_id, body, attachment_ids?, after? }: reply (deduplicated by client_id). Reopens a recently resolved conversation like the V4 customer flow. |
| GET | `/api/widget/session` | Widget |  | V5 WID — GET /api/widget/session: who the widget talks as (member / visitor), availability ("Send us a message" unless staffed chat is configured), CSRF tokens for this browser's identities, a signed form token, and rec… |
| POST | `/api/widget/session/end` | Widget |  | V5 WID — POST /api/widget/session/end: "End chat on this device" (revokes the visitor session; clears the cookie). Conversations are kept; reopening them on this device needs the emailed one-time code. |
| POST | `/api/widget/verify` | Widget |  | V5 WID — POST /api/widget/verify { email }: email a one-time code + link IF that address has widget conversations. Always answers 202 the same way (no enumeration); rate-limited per IP and per address. |
| POST | `/api/widget/verify/confirm` | Widget |  | V5 WID — POST /api/widget/verify/confirm { code } \| { token }: prove control of the email; this browser session may then see conversations started with it. Never links a user account or workspace. |

### workspace

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| GET, PATCH | `/api/workspace` | Session |  | GET /api/workspace, PATCH /api/workspace { name?, timezone? } (owner/admin). |
| GET, PUT | `/api/workspace/data-policy` | Session |  | GET/PUT /api/workspace/data-policy — draft recovery policy (persistent / session / off local recovery). |
| GET, PATCH | `/api/workspace/limits` | Session |  | GET /api/workspace/limits (owner/admin): caps + current-period usage · PATCH (owner) { x_monthly_writes?, x_monthly_reads?, ai_monthly_tokens? } (null = no cap). Audited. |
| PATCH | `/api/workspace/limits/teams/{teamId}` | Session |  | PATCH /api/workspace/limits/teams/:teamId { "ai.tokens"?, "x.write"?, "x.read"?, "storage.bytes"?, "exports.count"? } (null = no team cap). Owner only (security.manage); audited. Returns the Budgets view. |
| GET, POST | `/api/workspace/ownership-transfers` | Session |  | GET /api/workspace/ownership-transfers — pending transfers involving me (or all, for owners) POST { to_user_id, keep_previous_owner_as? } — owner proposes (fresh authentication required). |
| DELETE | `/api/workspace/ownership-transfers/{id}` | Session |  | DELETE /api/workspace/ownership-transfers/:id — cancel (proposer) or decline (proposed owner). |
| POST | `/api/workspace/ownership-transfers/{id}/accept` | Session |  | POST /api/workspace/ownership-transfers/:id/accept — the proposed owner accepts (fresh MFA session); atomic. |
| POST | `/api/workspace/pause` | Session |  | POST /api/workspace/pause { paused, reason? } (owner/admin/approver) — emergency pause (SC-05). |
| GET, PUT | `/api/workspace/security-policy` | Session |  | GET /api/workspace/security-policy (owner): two-step requirement, step-up window, guest/invitation expiry. PUT (owner, verified MFA; weakening also needs a fresh verification → 401 step_up_required). Audited, bumps poli… |

### workspaces

| Methods | Path | Access | Idempotency-Key | Purpose |
|---|---|---|---|---|
| POST | `/api/workspaces` | Session (no workspace) |  | POST /api/workspaces { name, timezone, brand_name? } — first-run workspace creation (workspace + owner membership + first brand). Works without an active workspace. |

## Related

- [API conventions](/help/developers/api-conventions)
- [MCP tool reference](/help/developers/mcp-tool-reference)
- [Authentication and authorization](/help/developers/authentication-and-authorization)
