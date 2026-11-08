# Social Lite — Internal HTTP API

JSON over HTTPS with server-side session auth. This document is the contract between the web UI
and the route handlers. Status column: **Implemented** routes exist and are covered by tests listed in
`docs/REQUIREMENTS_MATRIX.md`.

## Conventions

- **Auth**: opaque session cookie (`sl_session`, `__Host-` prefixed in production; HttpOnly, SameSite=Lax, Secure in production).
- **Workspace scope**: every authenticated route acts on the session's *active workspace*
  (`POST /api/session/workspace` switches). Resources outside it return `404` (no existence leakage).
- **Mutations** (`POST/PUT/PATCH/DELETE`) require:
  - `Origin` matching `APP_BASE_URL`, and
  - `X-CSRF-Token: <session.csrfToken>` (from `GET /api/session`).
- **Idempotency**: create/publish endpoints marked 🔁 require `Idempotency-Key: <8-200 chars>`.
  Same key + same body ⇒ original response; same key + different body ⇒ `409 idempotency_conflict`.
- **Optimistic concurrency**: draft edits send `expected_version`; mismatch ⇒ `409 version_conflict`
  with `error.details.current` (latest version, updated_by, updated_at).
- **Errors**: `{ "error": { "code", "message", "fieldErrors"?, "details"? }, "correlation_id" }`.
  Codes: `unauthenticated 401`, `forbidden 403`, `csrf_failed 403`, `not_found 404`, `conflict/version_conflict/idempotency_conflict/invalid_state 409`,
  `provider_not_configured 412`, `payload_too_large 413`, `unsupported_media 415`, `validation_failed 422`, `rate_limited 429`,
  `budget_exhausted 402`, `provider_error 502`, `dispatch_disabled 503`, `internal 500`. Never raw provider responses or secrets.
- **Time**: all instants are ISO-8601 UTC strings. Schedules additionally carry `input_timezone` (IANA) and
  `input_local_time` (`YYYY-MM-DDTHH:mm`) exactly as entered.
- **Pagination**: cursor-based: `?cursor=<opaque>&limit=<=100` ⇒ `{ items, next_cursor }`.
- **Simulated destinations**: any object with `is_mock: true` is a simulated destination; UI must label
  results "Simulated", never "Published".

## Session, auth, workspace

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/auth/login` | `?returnTo=/path&invite=<token>` | 302 to OIDC provider (state+nonce+PKCE) |
| GET | `/api/auth/callback` | OIDC params | sets cookie; 302 to returnTo (or `/invite/<token>?error=...`) |
| POST | `/api/auth/logout` | – | `{ ok }` clears cookie, revokes session |
| GET | `/api/session` | – | `SessionInfo` (below) or 401 |
| POST | `/api/session/workspace` | `{ workspace_id }` | `SessionInfo` |
| GET | `/api/workspace` | – | `Workspace` |
| PATCH | `/api/workspace` | `{ name?, timezone? }` (owner/admin) | `Workspace` — timezone change affects defaults/display only (SC-03) |
| POST | `/api/workspace/pause` | `{ paused: boolean, reason? }` (owner/admin/approver) | `Workspace` |

```ts
type SessionInfo = {
  user: { id: string; email: string; name: string | null };
  csrf_token: string;
  workspace: { id: string; name: string; role: Role; is_demo: boolean; timezone: string; publishing_paused: boolean } | null;
  workspaces: Array<{ id: string; name: string; role: Role; is_demo: boolean }>;
  brands: Array<{ id: string; name: string; timezone: string; publishing_paused: boolean; approval_required: boolean; is_demo: boolean }>;
  permissions: Record<Action, boolean>;      // from packages/core/permissions.ts
  mock_providers_enabled: boolean;
  app_env: 'development' | 'test' | 'production';
};
type Workspace = { id; name; timezone; is_demo; publishing_paused; paused_reason; paused_at; limits; created_at };
```

## Team

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/members` | – | `{ members: Member[], invitations: Invitation[] }` |
| POST | `/api/invitations` 🔁 | `{ email, role, brand_ids?: string[] }` | `Invitation` (email sent via outbox) |
| DELETE | `/api/invitations/:id` | – | `{ ok }` (revoke) |
| GET | `/api/invitations/preview?token=` | public | `{ workspace_name, email_hint, role, expires_at, status }` |
| GET | `/api/members/:userId/removal-impact` | – | `{ approved_schedules_remaining, drafts_losing_access, pending_approvals }` |
| PATCH | `/api/members/:userId` | `{ role?, brand_ids?: string[] \| null }` | `Member` |
| DELETE | `/api/members/:userId` | – | `{ ok, impact }` |

```ts
type Member = { user_id; email; name; role: Role; brand_ids: string[] | null; joined_at };
type Invitation = { id; email; role; brand_ids; expires_at; created_at; invited_by_email; status: 'pending'|'expired' };
```

## Brands

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/brands` | – | `{ items: Brand[] }` |
| POST | `/api/brands` | `{ name, timezone? }` (owner/admin) | `Brand` |
| GET | `/api/brands/:id` | – | `Brand` |
| PATCH | `/api/brands/:id` | `{ name?, timezone?, approval_required?, editors_can_publish?, default_deadline_minutes?, voice? }` | `Brand` |
| POST | `/api/brands/:id/pause` | `{ paused: boolean, reason? }` | `Brand` |

```ts
type Brand = { id; name; timezone; approval_required; editors_can_publish; default_deadline_minutes;
  publishing_paused; paused_reason; paused_at; voice: { tone?; terminology?: string[]; prohibited?: string[]; default_cta?; hashtags?: string[]; footer? };
  is_demo; connection_count; created_at };
```

## Connections

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/providers` | – | `{ items: ProviderStatus[] }` |
| GET | `/api/brands/:id/connections` | – | `{ items: Connection[] }` |
| POST | `/api/brands/:id/connections/:provider/start` | `{}` (provider ∈ facebook, instagram, x) | `{ authorization_url }` or `412 provider_not_configured` |
| GET | `/api/oauth/:provider/callback` | provider params | 302 → `/accounts/select?flow=<id>` or `/accounts?error=<code>` |
| GET | `/api/connection-flows/:flowId` | – | `{ provider, brand_id, candidates: DestinationCandidate[], expires_at }` |
| POST | `/api/connection-flows/:flowId/select` | `{ provider_account_ids: string[] }` | `{ items: Connection[] }` (AC-02: explicit choice) |
| POST | `/api/brands/:id/connections/telegram` | `{ bot_token, channel }` (channel: `@name` or numeric `-100…`) | `Connection` (verified before Ready, AC-03) |
| POST | `/api/brands/:id/connections/mock` | `{ provider, display_name, scenario? }` (dev/demo only) | `Connection` (`is_mock: true`) |
| POST | `/api/connections/:id/check` | – | `Connection` (fresh health) |
| POST | `/api/connections/:id/pause` | `{ paused: boolean }` | `Connection` |
| POST | `/api/connections/:id/disconnect` | – | `{ connection, blocked_deliveries: number }` (AC-05) |
| POST | `/api/connections/:id/reconnect` | `{}` OAuth ⇒ `{ authorization_url }`; Telegram ⇒ `{ bot_token }` | `Connection` |
| PATCH | `/api/connections/:id/mock-scenario` | `{ scenario: MockScenario }` | `Connection` (mock only) |

```ts
type ProviderStatus = { provider: Provider; configured: boolean; missing: string[]; callback_url: string | null;
  required_scopes: string[]; mock_available: boolean; notes: string };
type Connection = { id; brand_id; provider; provider_account_id; display_name; username; status: ConnectionStatus;
  status_label: string; is_mock: boolean; capabilities: ChannelCapabilities | {}; health: { message; checked_at; missing_permissions?; expires_at? };
  paused: boolean; throttled_until: string | null; mock_scenario?: MockScenario; created_at; disconnected_at };
```

## Media library

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/assets/upload-intent` | `{ brand_id, filename, content_type, bytes }` | `{ asset_id, upload: { method: 'POST', url, fields } }` (presigned POST with content-length-range, 10 min) |
| POST | `/api/assets/:id/complete` | – | `Asset` (validation runs synchronously for images ≤ 20 MB; status `ready` or `rejected`) |
| GET | `/api/brands/:id/assets` | `?status=&tag=&q=&cursor=` | `{ items: Asset[], next_cursor }` |
| GET | `/api/assets/:id` | – | `Asset` |
| PATCH | `/api/assets/:id` | `{ alt_text?, tags? }` | `Asset` |
| POST | `/api/assets/:id/archive` | – | `Asset` or `409` if referenced by an active schedule (ME-05) |

```ts
type Asset = { id; brand_id; status: 'pending_upload'|'quarantined'|'ready'|'rejected'|'archived'; rejection_reason;
  original_filename; mime; bytes; width; height; alt_text; tags; created_at;
  preview_url: string | null; thumb_url: string | null;  // short-lived signed URLs (authorized only)
  usage_count: number };
```

## Templates

| GET | `/api/brands/:id/templates` | – | `{ items: Template[] }` |
|---|---|---|---|
| POST | `/api/brands/:id/templates` | `{ name, body, tags? }` | `Template` |
| PATCH | `/api/templates/:id` | `{ name?, body?, tags? }` | `Template` |
| DELETE | `/api/templates/:id` | – | `{ ok }` (archive) |

## Posts, composer

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/brands/:id/posts` | `?status=&tag=&q=&cursor=` | `{ items: PostSummary[], next_cursor }` |
| POST | `/api/brands/:id/posts` 🔁 | `{ title?, template_id?, draft?: DraftContent, connection_ids?: string[] }` | `PostDetail` |
| GET | `/api/posts/:id` | – | `PostDetail` |
| PATCH | `/api/posts/:id` | `{ expected_version, draft?: DraftContent, title?, tags? }` | `{ version, updated_at }` or `409 version_conflict` |
| POST | `/api/posts/:id/validate` | `{ connection_ids?: string[] }` | `{ ok, issues: ValidationIssue[], per_destination: Record<connId, { ok, measured_length, limit }> }` |
| POST | `/api/posts/:id/duplicate` 🔁 | – | `PostDetail` |
| POST | `/api/posts/:id/archive` | – | `{ ok }` (refused while a schedule is active) |

```ts
type DraftContent = { baseText; baseLink?; baseAssetIds: string[]; variants: VariantDraft[] };  // packages/core/types.ts
type PostSummary = { id; brand_id; title; excerpt; tags; status: PostAggregateStatus; version; updated_at; due_at: string | null;
  destinations: Array<{ connection_id; provider; is_mock; state: DeliveryState | null }> };
type PostDetail = PostSummary & {
  draft: DraftContent; created_by; updated_by_email;
  brand: Brand; connections: Connection[];                 // brand's connections (for destination picking)
  assets: Asset[];                                         // assets referenced by the draft
  current_schedule: Schedule | null;
  approval: Approval | null;                               // latest approval for current schedule
  deliveries: Delivery[];
  can: { edit: boolean; schedule: boolean; schedule_reason?: string; submit: boolean; publish_now: boolean; cancel: boolean };
};
```

## Scheduling and approval

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/posts/:id/schedule` 🔁 | `ScheduleRequest` | `202 { schedule: Schedule, deliveries: Delivery[] }`; `422` with `issues` per destination; `409 ambiguous_time` with offset options |
| POST | `/api/posts/:id/publish` 🔁 | `{ expected_version, connection_ids }` | `202 { schedule, deliveries }` (same pipeline, due now) |
| POST | `/api/posts/:id/submit` 🔁 | `ScheduleRequest` (or omit time for "publish on approval") | `202 { schedule (status pending_approval), approval }` |
| POST | `/api/schedules/:id/cancel` | – | `{ schedule, deliveries, message }` — in-flight destinations report "Cancellation requested; publication may already be in progress." |
| POST | `/api/schedules/:id/reschedule` 🔁 | `{ input_local_time, timezone, offset?, expected_generation }` | `202 { schedule, deliveries }` — new generation; old jobs become no-ops (SC-08); invalidates approval |
| GET | `/api/approvals` | `?status=pending\|decided&cursor=` | `{ items: ApprovalSummary[] }` |
| GET | `/api/approvals/:id` | – | `ApprovalDetail` (exact outgoing variants + diff vs previous revision) |
| POST | `/api/approvals/:id/approve` | `{ expected_fingerprint }` | `{ approval, schedule, deliveries }` |
| POST | `/api/approvals/:id/reject` | `{ reason }` (required, AP-03) | `{ approval }` |

```ts
type ScheduleRequest = {
  expected_version: number; connection_ids: string[];
  input_local_time?: string;   // YYYY-MM-DDTHH:mm in `timezone`
  timezone?: string;           // IANA; defaults to brand timezone. Browser zone is never assumed.
  offset?: string;             // "+01:00" — required only for ambiguous (DST fold) times
  deadline_minutes?: number;   // publish-before grace; default brand setting (15)
};
type Schedule = { id; post_id; revision_id; revision_number; generation; due_at; input_timezone; input_local_time; input_offset;
  publish_before; is_immediate; status: 'pending_approval'|'active'|'superseded'|'cancelled'|'completed'|'rejected'; created_at; created_by_email };
type Approval = { id; decision: 'pending'|'approved'|'rejected'|'invalidated'; requested_by_email; reviewer_email; decided_at; reason; fingerprint };
type ApprovalDetail = Approval & { post_id; brand; schedule: Schedule; variants: Array<ResolvedVariant & { connection: Connection; assets: Asset[] }>;
  diff: { previous_revision_number: number | null; base_text: { before: string; after: string } | null; changed_destinations: string[] } };
```

## Delivery and history

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/posts/:id/deliveries` | – | `{ items: Delivery[] }` (with attempts) |
| POST | `/api/deliveries/:id/retry` | `{ acknowledge_duplicate_risk?: boolean }` | `Delivery` — only failed/expired/blocked(resolved); Unknown requires `acknowledge_duplicate_risk: true` and creates an audited manual attempt |
| POST | `/api/deliveries/:id/resolve` | `{ outcome: 'published'\|'not_published', provider_url?, note? }` | `Delivery` (manual reconciliation of Unknown) |
| GET | `/api/history` | `?brand_id=&provider=&state=&from=&to=&cursor=` | `{ items: HistoryRow[], next_cursor }` |
| GET | `/api/history/export.csv` | same filters | `text/csv` (DE-04) |
| GET | `/api/planner` | `?from=&to=&brand_id=&connection_id=&status=` (range ≤ 62 days) | `{ items: PlannerItem[] }` |

```ts
type Delivery = { id; schedule_id; post_id; connection_id; provider; display_name; is_mock; state: DeliveryState; state_label: string;
  due_at; publish_before; attempt_count; max_attempts; next_attempt_at; provider_ids: string[]; provider_url; published_at;
  last_error_code; last_error_message; blocked_reason; unknown_since; can_retry: boolean; retry_requires_ack: boolean;
  attempts?: Array<{ attempt_number; kind; phase; outcome; safe_code; safe_message; started_at; ended_at; actor_email; duplicate_risk_acknowledged }> };
type HistoryRow = Delivery & { brand_id; brand_name; post_title; excerpt; revision_number; scheduled_input: string; input_timezone };
type PlannerItem = { schedule_id; post_id; brand_id; title; excerpt; due_at; input_timezone; input_local_time; status: PostAggregateStatus;
  schedule_status; destinations: Array<{ connection_id; provider; is_mock; state: DeliveryState }> };
```

## Home, operations, notifications, audit

| GET | `/api/dashboard` | `?brand_id=` | `{ today: PlannerItem[], attention: { blocked: Delivery[], unknown: Delivery[], failed: Delivery[], expired: Delivery[] }, account_warnings: Connection[], recent: HistoryRow[], paused: { workspace: boolean, brands: string[] } }` |
|---|---|---|---|
| GET | `/api/ops` | owner/admin | `OpsSnapshot` (queue oldest age, worker heartbeats, outbox backlog, state counts, eligible vs unfiltered success rate, lateness p50/p95, dispatch_enabled) |
| GET | `/api/notifications` | `?unread=1` | `{ items: Notification[], unread_count }` |
| POST | `/api/notifications/:id/read` / `/api/notifications/read-all` | – | `{ ok }` |
| GET | `/api/audit` | `?cursor=&resource_type=` (owner/admin) | `{ items: AuditEvent[], next_cursor }` |

## Setup, diagnostics, health

| GET | `/api/health` | public | `{ status: 'ok' }` liveness |
|---|---|---|---|
| GET | `/api/ready` | public | `{ status, checks: { database, migrations } }` (503 when not ready) |
| GET | `/api/diagnostics` | owner/admin | `{ checks: Array<{ name, ok, detail }> }` (db, storage, oidc, smtp, worker heartbeat, dispatch flag) |
| GET | `/api/setup` | owner | `{ groups: Array<{ id, title, items: SetupItem[] }> }` |
| PUT | `/api/setup/:key` | owner `{ value }` | `SetupItem` — secrets are write-only; responses show `is_set` and last 4 chars at most |

```ts
type SetupItem = { key; label; secret: boolean; is_set: boolean; source: 'env' | 'setup' | null; hint; value?: string /* non-secret only */; docs_url?: string };
```

## Inbound

| POST | `/api/webhooks/:provider` | provider-signed | authenticate → persist receipt (dedupe) → `200` |
|---|---|---|---|
| POST | `/api/integrations/tipsignal/events` | HMAC-signed, timestamped | creates a **draft** (never auto-publishes) |
