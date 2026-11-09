# Worker and queue failures

Audience: operators. Repo only. Reviewed 2026-11-09 (product 2026-11). Background:
`content/help/developers/background-jobs-and-media.md`, `content/help/developers/publishing-engine-and-delivery-states.md`.

**Affected resources:** worker processes, `outbox`, the `pgboss` schema, `deliveries`, workload classes.

## Symptoms

- Posts stay **Scheduled** past their time; the app shows **Overdue**.
- `/admin/operations` shows a growing outbox backlog, old due work or publishing pressure.
- Imports, exports, video processing or notifications are slow while publishing is fine (bulk classes deferring).
- Dead-lettered events appear in the workspace admin console.
- Worker `/health` returns 503 (`draining`) or nothing.

## Diagnostics

1. **READ-ONLY** Is any worker alive? `SELECT worker_id, version, last_seen_at, info->'stopped' FROM worker_heartbeats ORDER BY last_seen_at DESC;`
   No row newer than 30 s → the worker is down or cannot reach the database.
2. **READ-ONLY** Is dispatch enabled? `SELECT key, value, updated_by, updated_at FROM system_flags WHERE key IN ('dispatch_enabled','dispatch_version');`
   `dispatch_enabled=false` stops all claiming. A `dispatch_version` that matches no running worker's `APP_VERSION`
   also stops claiming (rolling deploy pin left behind).
3. **READ-ONLY** Worker log: `worker_fatal` (start-up failure; often "Database is not migrated" or a KMS error),
   `loop_failed` with `loop` name, `pgboss_error`, `delivery_processed` lines (work is flowing).
4. **READ-ONLY** Workload: `:3001/ready` → `workload` shows per-class running/waiting; `/api/ops/workload?window_minutes=60`
   separates queue age, dispatch delay and provider time.
5. **READ-ONLY** Per-workspace or per-network caps: a workspace with many live leases waits for its cap
   (`DISPATCH_WORKSPACE_CONCURRENCY`, default 4, or a per-workspace override); a network at its cap
   (`DISPATCH_PROVIDER_CONCURRENCY`, default 8) waits too. Open circuits and `connections.throttled_until` skip work.
6. **READ-ONLY** Outbox: `SELECT event_type, attempts, last_error FROM outbox WHERE dispatch_state='dead' ORDER BY id DESC LIMIT 20;`

## Corrective actions

| Cause | Action |
|---|---|
| Worker down | Restart it (`DATABASE_URL=<worker role URL> node dist/main.mjs` or the container). Restart is safe: leases expire after 90 s; preparation resumes from checkpoints; anything mid-send becomes Unknown and is reconciled, never resent. |
| Worker crash-loops at start | Fix the cause in `worker_fatal` (migrations, KMS, configuration), then restart. |
| Dispatch switched off by mistake | **CHANGES DATA** Platform → overview → dispatch switch (operator, fresh sign-in, reason required; audited). Equivalent API: `POST /api/platform/dispatch { "enabled": true, "reason": "…" }`. |
| Stale `dispatch_version` pin | **CHANGES DATA** `UPDATE system_flags SET value='null'::jsonb, updated_by='<operator>' WHERE key='dispatch_version';` |
| Throughput too low | Add workers (safe: claims, leases and fencing tokens prevent double processing) or raise `WORKER_CONCURRENCY`. Raise per-network caps only within the network's published limits. |
| Bulk work starving | Bulk classes defer only while publishing is under pressure; they always run within 60 s. Tune `WORKLOAD_<CLASS>_CONCURRENCY` if needed. |
| Dead-lettered events | Workspace admins requeue safe types in `/admin/operations` (`delivery.due`, `asset.uploaded`, `source.import_requested`, `export.requested`, `bulk.requested`); repeated clicks requeue once. Other types: find the cause in `last_error` first, then escalate — do not requeue notifications or replies blindly. |
| pg-boss schema damaged | Escalate. Do not drop the `pgboss` schema on a live system: publishing would still work through the claim loops, but other queues would lose jobs. |

Never update `deliveries.state` by hand to "unstick" a post; use retry/resolve in the product
([failed-and-ambiguous-publications.md](failed-and-ambiguous-publications.md)).

## Verification

- Heartbeat fresh; `delivery_processed` lines resume; overdue count falls to zero.
- `SELECT count(*) FROM outbox WHERE dispatch_state='pending' AND available_at < now() - interval '1 minute';` → 0.

## Escalation

Workers alive and dispatch enabled but nothing is claimed, repeated `loop_failed` in the claim or sweep loops,
or deliveries flipping between states: pause the affected scope, collect `worker_heartbeats.info`, the relevant log
lines with delivery ids, and escalate to the engineering owner.
