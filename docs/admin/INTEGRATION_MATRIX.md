# Admin integration matrix (V3.1 Admin)

Every implemented Relay module, its source of truth, how users work with it, how it is administered, and the evidence.
Scope: **W** = workspace administration (V2 grants of the active workspace, `authorize()`), **P** = platform
administration (`platform_operators`, migration 026). Admin status: **Connected** = working end-to-end admin workflow on
the shared service; **Reused** = the existing screen is mounted inside the admin shell (same component, same API);
**Partial** = admin can see/act on part of it; **Not available** = no product functionality exists (shown honestly in the
UI, never as a fake screen); **Main app** = operational work stays in the main app by design.

Evidence keys: `IT` = `tests/integration/v31-admin.test.ts`, `IT-MCP` = `tests/integration/v31-admin-mcp.test.ts`,
`E2E` = `tests/e2e/admin.spec.ts`, `UT` = `tests/unit/v31-admin.test.ts`, shots = `evidence/v3-1/admin/**`.

## People, workspace, security

| Feature | Product status | Source of truth | User workflow | Admin workflow (route) | Scope | Read / write permission | Service / API | Jobs / events | Data sensitivity | Admin status | Evidence | Remaining |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Members, scoped grants, restrictions | Implemented (V2) | `memberships`, `scoped_role_grants`, `access_restrictions` | Team | `/admin/people`, `/admin/people/members/:id` (effective access, grants, deny rules) | W | members.read / members.manage (+ delegation ceiling) | `members.ts`, `/api/members/**` | policy version bump; authority revalidation | Personal data (emails) | Reused | IT (role change → next request), E2E | – |
| Suspension, removal, offboarding + handover | Implemented (V2) | `memberships.status`, `publication_authorizations` | Team | member page: impact preview → suspend/remove with reassignment | W | members.manage | `lifecycle.ts` | holds publications at dispatch | Personal | Reused | IT (open session locked out; held publication → adopt offered) | – |
| Invitations (72 h, resend, revoke, bulk, guests) | Implemented (V2) | `invitations` | Team → Invitations | `/admin/people/invitations` | W | members.invite | `auth/invitations.ts` | outbox `invitation.created` (email) | Email addresses | Reused | E2E (390 px invite + revoke) | Real SMTP (activation) |
| Teams + delegation ceilings | Implemented (V2) | `teams`, `team_memberships`, `delegation_limits` | Team → Teams | `/admin/people/teams/**` | W | teams.read / teams.manage | `teams.ts` | policy version bump | – | Reused | existing `v2-teams-grants` IT | – |
| Ownership transfer + last-owner protection | Implemented (V2) | `ownership_transfers` | Team member page | member page | W | workspace.transfer_owner (+ step-up) | `lifecycle.ts` | – | – | Reused | IT (last owner can't be removed) | – |
| Held publications / adoption | Implemented (V2) | `publication_authorizations` | Team → Held | `/admin/people/held`; delivery drawer "Adopt" | W | content.schedule | `engine/authority.ts` | re-queues `delivery.due` | – | Reused + Connected | IT (adopt offered after suspension) | – |
| Workspace security policy (MFA, step-up) | Implemented (V2) | `workspaces.security_policy` | Settings | `/admin/settings/people/security-policy` | W | security.manage (+ step-up when weakening) | `security-policy.ts` | – | – | Reused | existing IT | – |
| Audit / activity centre | Implemented (V2) | `audit_events` (append-only for app roles) | Activity | `/admin/security/audit` (filters in URL, CSV export) | W | audit.read; export + exports.create | `product/activity.ts` | – | Safe diffs only | Reused | IT (audit completeness), existing db-roles IT | External immutable sink (gap) |
| **Support access** | New (026) | `support_access_grants` + expiring `viewer` grant | Banner in admin while active | `/admin/security/support` (approve / decline / end) ↔ `/admin/platform/support` | W + P | request: platform support+; decide: members.manage + fresh MFA; end: either side | `admin/support-access.ts`, `/api/admin/support-access/**`, `/api/platform/support-access/**` | lazy expiry sweep; grant expiry enforced by policy | Grants read access to private content | Connected | IT (full lifecycle, expiry, lapse, both audits), E2E (operator ↔ other workspace owner) | – |
| Problem reports | Implemented (V3.1) | `support_reports` (redacted) | Account menu → Report a problem | `/admin/security/reports` | W | audit.read | `gov/release.ts` | – | Redacted free text | Reused | – | Status/close workflow (not in product) |
| Personal security (factors, sessions) | Implemented (V2) | Keycloak + `sessions` | `/security` | Settings → Profile; own sessions only | user | self | `security.ts` | back-channel logout | Credentials stay in IdP | Main app | existing IT | Admin revocation of another user's sessions: by design only via workspace suspension or platform account suspension |
| **Platform account suspension** | New (026 audit) | `users.disabled_at`, `sessions.revoked_at` | – | `/admin/platform/accounts` | P | operator + fresh MFA | `admin/platform.ts` `setAccountDisabled` | sessions revoked | Personal | Connected | IT (memberships untouched, self-suspend refused) | – |

## Publishing

| Feature | Product status | Source of truth | User workflow | Admin workflow | Scope | Read / write | Service / API | Jobs / events | Sensitivity | Admin status | Evidence | Remaining |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Schedules + per-destination deliveries (10 networks) | Implemented | `schedules`, `deliveries`, `delivery_attempts` | Composer, Planner, History | `/admin/publishing` (all brands/networks, 14 display states, URL filters, keyset pages) + drawer (schedule zone, approval, authority, provider ids, attempts, reconciliation) | W | content.read (brand-scoped) | `admin/publishing.ts`, `/api/admin/deliveries/**` | outbox → pg-boss `delivery-due` | Post text (excerpt) | Connected | IT (scheduled ↔ admin ↔ cancel ↔ worker completion), E2E | – |
| Retry / resolve / cancel / reschedule / adopt | Implemented | same | Post page | drawer buttons → existing routes | W | publishing.retry / content.schedule | `engine/manual.ts`, `posts/scheduling.ts`, `engine/authority.ts` | audited; `delivery.due` | – | Connected | IT (never resend published; unknown needs explicit risk; two admins reschedule → one wins) | – |
| Emergency pause (workspace / brand / connection) | Implemented | `workspaces/brands/connections.paused` | Shell pause, brand settings | `/admin/operations` (workspace + per-brand), connection drawer | W | publishing.pause / resume | `workspaces.ts`, `brands.ts`, `connections` | dispatch-time gate | – | Connected | E2E (390 px pause → reload → resume) | – |
| Dead-lettered outbox events | Implemented (outbox) | `outbox.dispatch_state='dead'` | – | `/admin/operations` → requeue (safe types only) | W | workspace.manage | `admin/publishing.ts` | requeue once (conditional update) | – | Connected | IT (cross-ws 404, idempotent, unsafe types refused), UT | – |
| Approvals + policies | Implemented (V2) | `approvals`, `approval_policies` | Approvals | `/admin/approvals` (shared inbox) + `/admin/approvals/:id`; policies in settings | W | content.approve (eligible approvers) | `posts/scheduling.ts`, `collab/inbox.ts` | – | Post content | Reused | existing V2 IT; E2E reaches it | – |
| Publishing defaults, slots, safety, campaign links | Implemented | brand settings, `posting_slots`, `utm_defaults` | Settings | `/admin/settings/publishing/*` | W | brands.manage | existing | – | – | Reused | – | – |
| Brand rules / reviews / asset governance | Implemented (flag) | `brand_rules`, `brand_rule_reviews` | Settings | `/admin/settings/publishing/brand-rules` | W | brands.manage | `gov/brand-rules.ts` | dispatch hold | – | Reused | existing V3.1 IT | – |
| Content queue (evergreen) | Implemented (flag) | `content_queues` | `/queue` | Main app (per-brand); admin sees the deliveries it creates | W | content.schedule | `gov/reuse.ts` | – | – | Main app | – | – |
| Campaigns | Implemented | `campaigns` | `/campaigns` | Main app | W | – | – | – | – | Main app | – | – |

## Connections, content, analytics

| Feature | Product status | Source of truth | User workflow | Admin workflow | Scope | Read / write | Service / API | Jobs / events | Sensitivity | Admin status | Evidence | Remaining |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Social connections (Instagram, Facebook Pages, Telegram, X, TikTok, YouTube, LinkedIn, Threads, Pinterest, Bluesky) | Implemented (simulation + live adapters) | `connections`, `credentials` (envelope-encrypted) | Connections | `/admin/connections`: owner brand, account, auth health + fix, token/refresh expiry, granted scope count, last publication, last analytics sync/failure, upcoming affected work; reconnect / pause / diagnostics | W | connections.read / connections.manage | `admin/reads.ts`, health centre, `/api/connections/**` | health checks | Tokens never leave the server | Connected | IT (revocation → admin health + affected deliveries), shots | Live network approvals (activation) |
| Integration diagnostics | Implemented (flag) | computed, read-only | Connections → Test centre | `/admin/connections/diagnostics` + drawer | W | connections.read | `gov/diagnostics.ts` | none — never posts | – | Reused | existing IT | – |
| Provider app configuration | Implemented | env / `app_settings` | Instance setup | `/admin/platform/integrations` (configured / missing, never values) | P | platform support+ | `admin/platform.ts` `platformIntegrations` | – | Secrets never returned | Connected | shots | – |
| Google Drive / Docs, Notion connections | Implemented | `content_connections`, `source_items` | Settings → Connections | `/admin/settings/connections/{google,notion}` | W | connections.read/manage | `content-hub/**` | `source-import`, `writeback` queues | Customer documents (no previews in admin lists) | Reused | – | Live Google/Notion apps (activation) |
| Imports, exports, writebacks, report exports, bulk jobs, media processing | Implemented | `imports`, `export_jobs`, `writeback_jobs`, `report_exports`, `bulk_jobs`, `assets` | Content hub, Library, Analytics, bulk bar | `/admin/content` (history, safe errors, filters), links to where recovery lives | W | content.read (+ analytics.read for reports, assets.read for media) | `admin/reads.ts` `adminJobs` | worker queues | Item titles only; errors redacted | Connected | IT-MCP (import appears in admin history) | Per-job retry from admin (kept in owning screen) |
| Storage + trash | Implemented | `assets`, `posts.deleted_at` | Library, Trash | `/admin/content` storage tiles → Trash | W | assets.read | `adminJobs` | purge job | – | Partial | – | Retention policy editor (not in product) |
| Product analytics | Implemented | metric rollups | Analytics | Main app (`/analytics/**`) | W | analytics.read | `analytics/**` | – | – | Main app | – | – |
| **Operational analytics** (sync state, freshness, failures, backfills, resync, metric definitions) | Implemented | `sync_cursors`, `sync_runs`, metric registry | – | `/admin/analytics` | W | analytics.read | `admin/reads.ts` `adminAnalyticsOps`, `/api/analytics/sync` (resync, throttled) | `analytics-sync` queue | – | Connected | IT-MCP (sync → stale→fresh, jobs marker) | – |

## Developer tools, automation, operations, platform

| Feature | Product status | Source of truth | User workflow | Admin workflow | Scope | Read / write | Service / API | Jobs / events | Sensitivity | Admin status | Evidence | Remaining |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Service accounts + API keys | Implemented (V2) | `service_accounts`, `api_key_hashes` | Settings → Developer | `/admin/settings/developer/service-accounts` (create, rotate, revoke; secret shown once) | W | service_accounts.manage + step-up | `service-accounts.ts` | – | Hashes stored only | Reused | existing IT | – |
| MCP clients, policies, intents, audit | Implemented (V3) | `mcp_clients`, `mcp_policy_grants`, `mcp_publication_intents`, `mcp_audit` | Settings → Developer → MCP | `/admin/settings/developer/mcp` | W | owner/admin | `mcp/registry.ts` | `mcp_jobs` | – | Reused | IT-MCP (MCP draft appears in main + admin) | Public HTTPS for real clients (activation) |
| Inbound provider webhooks | Implemented | `webhook_receipts` | – | `/admin/developer/webhooks` (state, safe error; bodies never shown) | W | workspace.manage | `admin/reads.ts` | webhook processing | Bodies stored, not shown | Connected | shots | – |
| Outbound customer webhooks | **Not in product** | – | – | Shown as "Not available" | – | – | – | – | – | Not available | shots | Product decision |
| Inbound sources (TipSignal) | Implemented | `integration_bindings` | Settings | `/admin/settings/automation/inbound` | W | setup.manage | `integrations/**` | – | Signing secret write-only | Reused | existing IT | – |
| AI assistance | Implemented | `ai_usage`, `app_settings` | Composer | Usage caps (`/admin/usage`), key + model status (`/admin/platform/integrations`; D32) | W/P | – | `ai/**` | – | – | Partial | – | Per-feature AI policy (not in product) |
| Workload, queues, workers, diagnostics | Implemented (V3.1 PERF) | `workload_samples`, `worker_heartbeats`, `deliveries` | Operations | `/admin/operations` | W | workspace.manage | `/api/ops`, `/api/ops/workload`, `/api/diagnostics` | – | Counts only | Connected (fixed: `/api/ops/workload` returned 500 under the least-privilege web role) | shots | pg-boss gauges need a read grant for the web role (optional) |
| Feature flags (workspace overrides) | Implemented (V3.1) | `workspace_feature_flags` | Settings | `/admin/settings/operations/features` | W | workspace.manage | `gov/release.ts` | – | – | Reused | existing IT | – |
| **Feature rollouts (installation)** | Implemented rows; API new | `feature_flags` | – | `/admin/platform/rollouts` (default, %, kill switch) | P | operator + fresh MFA | `admin/platform.ts` | – | – | Connected | IT (kill beats override) | – |
| Usage budgets + caps | Implemented (V2) | `workspaces.limits`, `usage_budgets`, `usage_counters` | Settings | `/admin/usage` | W | read workspace.manage; change security.manage | `product/usage-admin.ts` | atomic reservations (app, worker, MCP) | – | Reused | existing IT | – |
| Billing, plans, invoices, seats pricing | **Not in product** | – | – | Shown as "Not available" | – | – | – | – | – | Not available | shots | Product + payment provider |
| Data export / handover | Implemented (V2) | generated zip | Settings | `/admin/settings/operations/export` | W | exports.create | `product/handover.ts` | – | All brand content | Reused | existing IT | – |
| Instance setup (provider keys, OIDC, SMTP, storage) | Implemented | env + `app_settings` | `/setup` | `/admin/setup` | W (owner) | setup.manage → security.manage | `setup.ts` | – | Secrets write-only | Reused | existing IT | Should be platform-operator-only (IMPLEMENTATION_GAPS G-A1) |
| **Platform health** | New | aggregates | – | `/admin/platform` (workers, queues, outbox, circuits, live vs simulated results, networks, alerts; global dispatch switch) | P | read support+; dispatch operator + MFA | `admin/platform.ts` | `system_flags.dispatch_enabled` at claim | Counts only | Connected | IT (metadata only; stale session refused) | – |
| **Workspace lifecycle** | New | `workspaces.state` (+ suspended_* in 026) | – | `/admin/platform/workspaces/**` (search, filter, pages, detail, suspend/reactivate, dispatch share) | P | operator + MFA | `admin/platform.ts` | dispatch gate holds suspended | Metadata only | Connected | IT (locked out, held, both audits, resumes) | – |
| **Operators + platform audit** | New | `platform_operators`, `platform_audit_events` (append-only) | – | `/admin/platform/operators`, `/admin/platform/audit` | P | operator | `admin/platform.ts`; CLI `pnpm platform:operator` | – | – | Connected | IT (append-only for app/worker roles; no self-change) | – |
| Release notes, onboarding checklist, Cmd+K search, trash, autosave | Implemented (V3.1) | various | Main app | Main app (user-facing); admin has its own jump palette | W | – | – | – | – | Main app | – | – |
| Meta data-deletion callbacks | Implemented | `data_deletion_requests` | – | No admin view | P | – | `meta-callbacks.ts` | – | Personal data | **Gap** (G-A3) | – | Admin list of deletion requests |

## Cross-cutting

| Concern | Implementation | Evidence |
|---|---|---|
| Sync between apps | `/api/admin/changes` markers, 10 s poll, backoff ≤ 60 s, 60 s safety refetch; session refresh on policy change | IT §18 tests, E2E two-tab test, `SYNC_AND_EVENT_MODEL.md` |
| Correlation ids | every route returns `x-correlation-id`; audits store it; delivery attempts store it | IT audit assertions |
| Idempotency | dead-letter requeue (conditional), support decision (state check), reschedule (generation + Idempotency-Key), retry (state machine) | IT |
| CSRF / origin | `route()` and `platformRoute()` | E2E (403 without token) |
