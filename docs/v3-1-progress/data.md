# V3.1 DATA stream: progress (resume point)

Brief §8–§11 and §17. Contract: `docs/V3_1_DATA_API.md`. Types: `packages/core/src/contracts/v31-data.ts`.

## Status: done (backend), awaiting UI stream
- **§9 drafts:** done.
  - Autosave with per-tab client revisions; conflict 409 carries the server copy and keeps a conflict copy.
  - Recover: applied, or kept as a copy; never overwrites; never publishes.
  - Recovery status endpoint.
  - Workspace local-recovery policy, also returned in `/api/session` as `draft_recovery`.
- **§10 trash:** done.
  - Soft delete with 30-day retention; consequences endpoint; restore with permission checks.
  - Undo tokens with concurrency checks.
  - Asset reference checks at trash time and again at purge.
  - Hourly purge job; everything audited.
- **§11 bulk:** done.
  - Preview with `preview_hash`.
  - Durable jobs (outbox → `bulk-ops` queue, plus a sweep).
  - Per-item results, retry of failed items only, cancel, undo.
  - Authority re-checked when the job runs; actions run through the shared services.
- **§8 search:** done.
  - FTS on expression GIN indexes; per-kind authorization; plain-text snippets.
  - Cancellation via `pg_cancel_backend`; 2 s budget.
  - Recent items; measured with `scripts/v31-search-bench.ts`.
- **§17 MCP:** done. Four read-only tools: `search`, `get_draft_recovery_status`, `preview_bulk_action`, `get_bulk_job_status`.

## Migration
- `021_v31_data.sql` is **frozen**: the lead applied it to the dev DB.
- Further schema changes go in a new file, `023_v31_data_more.sql` (none so far).

## Files
- New:
  - `packages/services/src/data/{drafts,policy,trash,bulk,search}.ts`
  - `packages/services/src/mcp/tools-data.ts`
  - `packages/core/src/contracts/v31-data.ts`
  - `apps/web/app/api/{posts/[id]/{autosave,recover,recovery-status},workspace/data-policy,trash/**,bulk/**,search/**}`
  - `tests/integration/v31-data{,-mcp}.test.ts`
  - `tests/unit/v31-data.test.ts`
  - `scripts/v31-search-bench.ts`
  - `docs/V3_1_DATA_API.md`
- Shared, small diffs:
  - `posts/service.ts`: `loadPost`/`listPosts` exclude trashed posts; `invalidatePendingApprovalIfChanged` exported.
  - `posts/versions.ts`: `recovered` version kind.
  - `media/assets.ts`: trashed assets excluded.
  - `collab/campaigns.ts`: post count excludes trashed posts.
  - `workspaces.ts`: `draft_recovery` added to the session payload.
  - `outbox.ts`, `engine/outbox-dispatcher.ts`: `bulk.requested` → `bulk-ops` queue.
  - `apps/worker/src/main.ts`: `bulk-ops` worker, `bulk-jobs` sweep, `trash-purge` job.
  - `mcp/tools.ts`: `register` exported; `registerDataTools` hook.
  - `core/contracts/mcp.ts`: four tools added.
  - `tests/unit/mcp.test.ts`: tool count.
  - `docs/V3_MCP_GUIDE.md`.

## Next / gaps
- UI (later stream): autosave states, recovery prompt, Trash page (`/trash` is referenced by the settings search destination), bulk selection, Cmd+K.
- Help-article search is not implemented (no help content yet; that belongs to the Docs/Help stream).
- Analytics workflow counts and the handover export still include trashed drafts (read-only, low impact).
- Storage objects of a purged asset are deleted after the row commits. A failed delete is logged and leaves an orphaned object; there is no retry table.
- Bulk duplicate: if the source post is edited between a crash and the re-run, the idempotency key fails that item (`idempotency_conflict`), and retrying the item fails the same way: start a new duplicate job for it.
