# Source and sync failures

Audience: operators. Repo only. Reviewed 2026-11-09 (product 2026-11). Covers Google Drive / Docs / Notion imports,
refresh, writeback and exports; analytics sync; business-app sync; listening ingest.

**Affected resources:** `content_connections`, `source_items`, `imports`, `writeback_jobs`, `export_jobs`,
`content_source_events`; `sync_cursors`, `sync_runs`, `data_coverage`; `integration_connections`,
`integration_events`, `integration_sync_jobs`; `listening_ingest_failures`.

## Symptoms

- An import stays **Queued/Running**, ends **Failed** or **Partial**, or says "the source changed after the preview".
- A linked source shows "access lost" or "change detected" that never refreshes.
- Notion writeback shows **Conflict**.
- Analytics show "stale", "fetch failed", "permission missing" or "access ended" for a destination.
- A business app shows **Needs attention**, sync lag grows on `/admin/integrations`, or events are **dead**.

## Diagnostics (all READ-ONLY)

### Content sources

```sql
SELECT id, action, status, error_code, error_message, attempts, created_at, started_at, completed_at
  FROM imports WHERE workspace_id='<workspace id>' ORDER BY created_at DESC LIMIT 20;
SELECT id, status FROM content_connections WHERE workspace_id='<workspace id>';           -- active / reconnect_required / disconnected
SELECT id, state, retention_hold FROM source_items WHERE workspace_id='<workspace id>';   -- linked / access_lost / removed / disconnected
SELECT status, conflict_detail, error_message FROM writeback_jobs WHERE workspace_id='<workspace id>' AND status IN ('conflict','failed');
```

- `conflict` on import: the source changed between preview and import — expected; preview again.
- Import jobs re-check the requester's current authority: a person who lost access makes their jobs fail.
- Worker class `interactive_import` (2 per worker, 1 per workspace) — a long import delays the next one in the same workspace.

### Analytics sync

```sql
SELECT connection_id, stream, status, stop_reason, consecutive_failures, next_run_at, last_success_at
  FROM sync_cursors WHERE workspace_id='<workspace id>' ORDER BY next_run_at;
SELECT status, count(*) FROM sync_runs WHERE workspace_id='<workspace id>' AND started_at > now() - interval '1 day' GROUP BY status;
```

`status='stopped'` with a `stop_reason` (disconnected, reconnect required, archived brand, suspended workspace) is
deliberate. Runs also pause while publishing is due (`ANALYTICS_YIELD_DUE_DELIVERIES`) — "stale" during a publishing
peak resolves on its own. X reads are billable and limited by the `x.read` budget.

### Business apps

```sql
SELECT connector, state, attempts, last_error, received_at FROM integration_events
 WHERE workspace_id='<workspace id>' AND state IN ('failed','dead') ORDER BY received_at DESC LIMIT 20;
SELECT id, status FROM integration_connections WHERE workspace_id='<workspace id>';
```

Events become `dead` after 8 attempts. `/admin/integrations` shows sync lag per installation and Slack delivery.

## Corrective actions

| Cause | Action |
|---|---|
| Connection needs reconnecting | The person reconnects the source or app ([expired-provider-auth.md](expired-provider-auth.md)); then request the import, refresh or export again. |
| Source changed after preview | Preview again and import. |
| Writeback conflict | Someone edited the Notion property. A person decides in Relay which value is right; Relay never overwrites silently. |
| Source deleted or unshared | Nothing to fix in Relay; drafts already imported remain. Snapshots of items that lost access expire after the retention period unless a hold is set. |
| Import or export dead-lettered | Requeue from `/admin/operations` (safe types). |
| Analytics cursor stopped after reconnect | Cursors resume when the connection is Ready again; check `next_run_at`. |
| Business-app events dead | Fix the cause (credentials, mapping, permissions) then trigger a sync from the integration page; dead events are not replayed blindly because they may create external tasks. |
| Drive change notifications stopped | Channels are renewed by the content-hub sweep every 2 minutes before expiry; manual refresh always works. |

## Verification

- New imports complete; `source_items.state='linked'`; analytics coverage shows `ok` with a recent fetch; integration
  events process and sync lag returns to normal.

## Escalation

All sources of one provider fail at once (API change, app suspended, scope change), or imports produce wrong content:
stop further imports for that provider (disconnecting is the safe stop), keep the failing source ids, escalate to the
Content Hub or integration owner.
