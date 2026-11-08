# V3.1 data API: drafts, recovery, trash, bulk, search

Backend for brief §8–§11 and §17 (DATA stream). Types: `packages/core/src/contracts/v31-data.ts`. Services: `packages/services/src/data/*`. Migration: `021_v31_data.sql`.

Every route goes through `route()`: session, CSRF on mutations, fresh V2 policy per request. Errors use the standard envelope `{ error: { code, message, fieldErrors?, details? } }`. Resources you can't see return 404.

## 1. Draft resilience (§9)

| Route | Use |
|---|---|
| `PUT /api/posts/:id/autosave` | Debounced autosave. Body: `base_version`, `client_id` (one per tab, 8–64 `[A-Za-z0-9_-]`), `client_revision` (monotonic per tab; a retry reuses it), `draft?`, `title?` |
| `POST /api/posts/:id/recover` | Sync content recovered from browser storage. Body: `base_version`, `client_id`, `draft`, `title?`, `local_saved_at?` |
| `GET /api/posts/:id/recovery-status?base_version=N` | Call before offering to sync. Returns `editable`, `blocked_reason`, `server_newer`, your conflict copies and the policy |
| `GET /api/posts/:id/versions` | Revision history (existing): versions, conflict copies, immutable revisions |
| `GET/PUT /api/workspace/data-policy` | Local-recovery policy. Changing it needs `workspace.manage` and is audited |

### Autosave responses
- `{status:'saved', version, saved_at, unchanged, duplicate}`: the server committed this content. `version` becomes your new `base_version`.
  - `unchanged`: the content already matched the server, so no new version was created.
  - `duplicate`: a retry of a save that had already landed.
- `{status:'stale_ignored', version}`: a newer save from the same tab already landed. Nothing changed.
- `409 version_conflict`: `details.current` is `{version, updated_at, updated_by, title, draft}` (the server copy). `details.conflict_copy_id` is the id of your rejected content, which is kept in History. Show both copies. To resolve, autosave the merged content with `base_version = current.version`.

### Recovery rules (server-enforced)
- Permission is re-checked from the current policy: `content.edit` on the brand. The post must not be archived or trashed.
- If `base_version` equals the current version, the content is applied as a `recovered` version.
- If the server is newer, the server version is never overwritten. The response is `{status:'kept_as_copy', conflict_copy_id, current_version, …}`.
- Recovery only edits the working draft. It never schedules, submits or publishes. Any draft change invalidates pending approvals and prepared MCP intents, as normal saves do.

### Client contract: "Saved locally" vs "Saved"
- `DraftSaveState` is one of: `idle | saving | saved | saved_locally | offline | save_failed | conflict`.
- Show **Saved** only after an autosave response with `status: 'saved'`. Store its `version`.
- **Saved locally** means the content exists only in this browser. It must never be shown as Saved.
- Offline mode covers drafting and recovery only. Never queue schedule, publish or security actions.
- The suggested debounce is `AUTOSAVE_DEBOUNCE_MS` (800 ms). Cancel an in-flight save when a newer one starts; the server ignores out-of-order saves anyway.

### Local recovery storage
- Use the policy from `GET /api/session` → `draft_recovery`, or from the data-policy route:
  - `persistent`: localStorage/IndexedDB.
  - `session`: tab lifetime only (sessionStorage).
  - `off`: store nothing.
- Keys are `${namespace}:${post_id}`. The namespace already includes the user and workspace.
- Store only `{base_version, draft, title, saved_at}`.
- Drop entries older than `max_age_hours`.
- Clear the namespace on logout when `clear_on_logout` is set. Never read another namespace after a workspace switch.
- On load, if a local copy exists:
  1. Call `recovery-status` with its `base_version`.
  2. If `editable` and not `server_newer`, offer to restore via `recover`.
  3. Otherwise, show the server copy and keep the local copy as "Saved locally" until the user discards it or `recover` stores it as a conflict copy.

## 2. Trash, restore and undo (§10)

| Route | Use |
|---|---|
| `GET /api/trash/consequences?kind=post\|asset&id=` | Explain before deleting: `can_trash`, `blocked_reason`, `consequences[]`, `references`, `retention_days`, `external_posts_affected:false` |
| `POST /api/trash/items` `{kind, id, expected_version?}` | Move to Trash. Returns `{deleted_at, purge_after, undo}` |
| `POST /api/trash/restore` `{kind, id, expected_deleted_at?}` | Restore. Returns `{restored:true, republished:false, undo}` |
| `GET /api/trash?kind=&brand_id=&cursor=&limit=` | List trashed items on brands you can read, each with `can_restore` |

### Retention and permissions
- Retention is 30 days for posts and assets (`TRASH_RETENTION_DAYS`). After that, the worker's `trash-purge` job (hourly) deletes items permanently.
- Posts need `content.archive` to trash or restore. Assets need `assets.manage`.

### Posts
- Trashing is refused while a schedule is live (active or pending approval) or publishing is in flight.
- Posts that reached a network can't be trashed; archive them instead.
- Deleting in Relay never deletes anything on a network. Restoring never schedules or publishes anything.

### Assets
- Trashing is refused while a live schedule or an unfinished delivery uses the asset. Drafts that use it are listed as a consequence.
- Physical deletion happens only in the purge job, after re-checking these references:
  - live schedules
  - unfinished deliveries
  - any non-trashed draft
  - Content Hub snapshots
- A referenced asset is kept, with `purge_blocked_reason` set, and re-checked daily. Until then, trashed assets stay publishable.

### Undo
- To undo, replay the `undo` token:
  - `trash.restore` with `expected_deleted_at`.
  - `trash.delete` with `expected_version`.
- If the item changed in the meantime, the undo fails with `conflict` or `version_conflict` instead of overwriting.

### Audit
Every trash, restore and purge is audited: `post|asset.trashed`, `.restored`, `.purged`, `.purge_deferred`.

## 3. Bulk jobs (§11)

| Route | Use |
|---|---|
| `POST /api/bulk/preview` `{target_kind, action, item_ids≤500, params?}` | Per item: `eligible / ineligible / not_found`, with `reason_code`, `reason` and `consequences`. Also action-level `consequences` and a `preview_hash` |
| `POST /api/bulk/jobs` (`Idempotency-Key`) `{…same, preview_hash}` | Start the job (202). Changed items, permissions or policy return `409 conflict`, `details.reason = 'preview_stale'`, with a fresh preview |
| `GET /api/bulk/jobs` · `GET /api/bulk/jobs/:id` | Status, counts and per-item results. Items on brands you can no longer read are omitted |
| `POST /api/bulk/jobs/:id/retry` `{item_ids?}` | Re-run failed items only |
| `POST /api/bulk/jobs/:id/cancel` | Skip the remaining items |
| `POST /api/bulk/jobs/:id/undo` (`Idempotency-Key`) | Start a job that reverses each succeeded item (once) |

### Actions
- Posts:
  - `assign` (`assignee_user_id` and/or `team_id`)
  - `add_tags` / `remove_tags` (`tags`)
  - `set_campaign` (`campaign_id`)
  - `duplicate` (into drafts, never scheduled)
  - `archive` / `unarchive`
  - `reschedule` (`shift_minutes`, applied on the wall clock in each schedule's timezone)
  - `trash` / `restore`
- Assets: `add_tags`, `remove_tags`, `archive`, `unarchive`, `trash`, `restore`.

### Guarantees
- **Durable.** The job, its items and an outbox event are written in one transaction. The worker's `bulk-ops` queue runs the job; a 30 s sweep resumes lost or crashed runs, using a lease.
- **Authority re-checked at run time.** The job runs with the creator's current grants, loaded from the database. Revoked access makes the remaining items fail with `forbidden`. Every item goes through the same services as the UI.
- **Idempotent.** Only pending items run. Duplicate and reschedule use per-item idempotency keys, and their target is computed once and stored. A crash between the change and the status write therefore never repeats work. Succeeded items are never re-run.
- **No access broadening.** Items stay on their own brand. Assignees and teams must already have access to that brand, and campaigns must belong to it. A start request only sees what the preview showed.
- **Rescheduling** uses the shared `reschedule()`. On approval brands the old approval is invalidated and the post needs approval again; on other brands it needs `content.schedule`.

## 4. Search and recent items (§8)

| Route | Use |
|---|---|
| `GET /api/search?q=&kinds=post,campaign,asset,brand,setting&limit=&include_archived=` | Grouped results (`SearchResponse`) |
| `GET /api/search/recent?limit=` · `POST /api/search/recent {kind, id}` | Your recent items, re-authorized on every read · record an opened item |

### Authorization and snippets
- Each kind is searched only on brands where you hold its read permission now: `content.read` for posts and campaigns, `assets.read` for assets, `brands.read` for brands.
- Settings destinations (`SETTINGS_DESTINATIONS`) are filtered by the permission each one needs.
- Snippets are plain text with `[start, end)` highlight ranges. Render them as text, never as HTML.
- Snippets come only from fields of that item you may read: post title and base text, campaign description, asset alt text. They never use comments, per-network overrides or other brands.

### Bounds and cancellation
- Queries are limited to 6 terms, 20 results per kind and a 2 s statement timeout. When the time runs out, the response has `partial: true`.
- Aborting the HTTP request cancels the running SQL statement (`pg_cancel_backend`). The route then returns 499.
- The suggested debounce is `SEARCH_DEBOUNCE_MS` (150 ms). Cancel the previous request on each keystroke.

### Caching
- Responses are `no-store` and carry `workspace_id` and `policy_version`.
- A client cache must be keyed by both and dropped on workspace switch, or when `/api/session` reports a new `v2.policy_version`.
- Trashed, revoked and other-workspace items never appear.

### Engine and measurements
- The engine is PostgreSQL full-text search (`'simple'` config, prefix terms) over expression GIN indexes. No new infrastructure.
- Measured with `scripts/v31-search-bench.ts`:
  - Setup: throwaway DB, 50,000 synthetic posts, 20 workspaces, 5,000-token vocabulary, local Postgres 16, warm cache, 60 runs over 5 queries.
  - FTS ordered by recency: p50 2.8 ms, p95 15.1 ms.
  - FTS ordered by `ts_rank`: p50 102 ms, p95 163 ms.
  - ILIKE: p50 27 ms, p95 49 ms.
- Result: the service orders matches by recency. These are server-side query times only, from one run on one machine; they are not end-to-end latency.

## 5. MCP (§17)

`search`, `get_draft_recovery_status`, `preview_bulk_action` and `get_bulk_job_status` are all read-only and go through the same services. See `docs/V3_MCP_GUIDE.md`.

Bulk jobs and undo start only in Relay. No tool takes a confirmation flag, and the MCP preview does not return `preview_hash`.

## Migration and rollback

`021_v31_data.sql` is additive. It adds:
- nullable trash columns and their CHECKs on `posts` and `assets`
- the `post_versions.kind` CHECK widened to include `recovered`
- tables `draft_save_clients`, `workspace_data_policies`, `bulk_jobs`, `bulk_job_items`, `recent_items`
- three FTS expression indexes and an immutable `relay_tags_text()` helper

If the app is rolled back to pre-V3.1 code, trashed rows reappear as ordinary rows. Restore or purge them before rolling back. All other new tables are simply ignored.
