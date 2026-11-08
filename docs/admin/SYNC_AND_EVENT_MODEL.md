# Sync and event model (V3.1 Admin §5, §18)

## Mechanism
- **One authoritative record per entity.** Admin and main app read the same tables through the same services; there is
  no admin copy or cache of tenant data.
- **Change markers, not event streams.** `GET /api/admin/changes` returns one opaque marker per topic, computed in a
  single statement from index probes: `access` (policy version, workspace state, pause), `publishing` (latest
  `deliveries.updated_at`), `content` (latest `posts.updated_at`), `approvals`, `connections`, `audit` (latest audit id),
  `jobs` (sync runs, imports, report exports) and `support`. It contains no record data and needs `workspace.read`.
- **Client** (`components/admin/sync.tsx`): polls every **10 s** while the tab is visible; on failure backs off
  (20 s, 40 s, max **60 s**) and shows *Reconnecting* while keeping the last data; pauses when hidden and polls at once on
  focus/online. Views subscribe with `useAdminTopics([...], refetch)` and refetch **only** their own authorized endpoint
  when a subscribed marker changes. Every subscribed view also refetches every **60 s** while visible (safety net), and
  after its own mutations.
- **Permissions.** A changed `policy_version` triggers a session refresh, so navigation and buttons follow revoked
  permissions without signing in again. Authority itself is never cached: every request re-reads grants.
- **Outbox.** State changes that drive background work are written to the transactional outbox in the same transaction
  (existing V1–V3.1 contract); the workers' results become visible through the same markers.

## Why missed, duplicated and out-of-order notifications are harmless
A marker is current state. A client that missed N changes sees one changed marker and refetches once; a duplicate poll
returns identical markers and triggers nothing; ordering can't matter because the refetch reads authoritative rows.
Realtime delivery is therefore never treated as proof of consistency — the refetch is.

## Targets (and what was observed)
| Target | Bound | Observed |
|---|---|---|
| Normal operation: change committed → open admin view updated | ≤ 10 s poll + one fetch (≈ 11 s worst case) | E2E two-tab test on the production build: **9.8 s** (annotation `sync_ms`, n = 1) |
| Degraded (feed failing) | ≤ 60 s (backoff cap) and ≤ 60 s safety refetch per view | unit/IT: markers detect any number of missed changes |
| Permission revocation | next request (server); ≤ 10 s for navigation | IT: grant revoked ⇒ next `loadAccess` lacks it; open session locked out after suspension |

## Tested (tests/integration/v31-admin*.test.ts, tests/e2e/admin.spec.ts)
Role change → main-app access; membership suspension → open session; main-app schedule → admin list; admin cancel →
main app; worker completion → both; connection revocation → admin health + affected deliveries; import → content +
admin history; MCP draft → main app + admin feed + audit; analytics sync → freshness; two admins on one schedule → one
wins; missed events reconcile; duplicate poll no-op; stale permission → feed denied.
