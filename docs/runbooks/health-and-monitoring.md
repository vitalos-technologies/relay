# Health and monitoring

Audience: operators. Repo only. Reviewed 2026-11-09 (product 2026-11).

**Prerequisites:** platform operator access to `/admin/platform`; network access to the health endpoints; log access.

## What to watch

| Signal | Where | Healthy |
|---|---|---|
| Web liveness | `GET /api/health` | `{"status":"ok"}` |
| Web readiness | `GET /api/ready` | `status: ready`, database reachable, migrations applied (count matches the release) |
| Worker liveness / readiness | `:3001/health`, `:3001/ready` | `ok` / `ready`; `/ready` lists in-flight work, last run of every loop and workload class usage |
| Worker heartbeat | `worker_heartbeats` (every 10 s) | At least one row with `last_seen_at` < 30 s ago |
| Dispatch switch | `system_flags.dispatch_enabled` (Platform overview, `/api/diagnostics`) | not `false` (unless deliberately paused) |
| Due work age | `/api/ops/workload`, `/admin/operations` | Oldest due delivery waiting < 10 s (publishing pressure threshold) |
| Overdue deliveries | `/admin/operations`, `/admin/publishing` | None (scheduled/retrying more than 2 min past due) |
| Outbox backlog / dead letters | `/admin/operations` (dead letters listed there) | Pending drains within seconds; no new `dead` rows |
| Unknown deliveries | `/admin/publishing` | Few, and each is being reconciled |
| Success rates | `/operations` | Live and simulated shown separately with denominators |
| Provider circuits | `/api/ops` | Closed |
| Billing pipeline | `/admin/platform/billing` | No `failed` webhook events older than one sweep |
| Inbox, integrations, listening, AI | `/admin/platform/care`, `/admin/platform/ai` | No growing backlog or failed-step spikes |

## Daily check (5 minutes)

1. **READ-ONLY** Platform overview (`/admin/platform`): workspaces, dispatch switch, worker heartbeats.
2. **READ-ONLY** `/admin/publishing` across affected workspaces: Unknown, Blocked, Failed, Expired counts.
3. **READ-ONLY** Connections not Ready (`/admin/connections`): expiring tokens show 7 days ahead.
4. **READ-ONLY** Platform → Care and Platform → AI: failed steps, sync lag.
5. **READ-ONLY** Logs: `level":"error"` rate, `loop_failed` (a worker loop threw), `pgboss_error`, `unhandled_api_error`.

## Useful queries (all READ-ONLY)

```sql
-- Workers and their last loop runs
SELECT worker_id, version, last_seen_at, info->'lastRun' AS last_run FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 10;

-- Due or overdue deliveries by state (last 24 h)
SELECT state, count(*) FROM deliveries
 WHERE next_attempt_at < now() - interval '2 minutes' AND state IN ('scheduled','retry_wait') GROUP BY state;

-- Outbox backlog and dead letters
SELECT dispatch_state, count(*), min(available_at) FROM outbox WHERE dispatch_state <> 'dispatched' GROUP BY dispatch_state;

-- Deliveries needing a person
SELECT state, count(*) FROM deliveries WHERE state IN ('unknown','blocked','handoff') GROUP BY state;
```

## Alerts to configure (recommended)

| Alert | Condition | Runbook |
|---|---|---|
| Worker down | No heartbeat newer than 60 s | [worker-and-queue-failures.md](worker-and-queue-failures.md) |
| Publishing late | Oldest due delivery > 2 min | [worker-and-queue-failures.md](worker-and-queue-failures.md) |
| Dead letters | New `outbox.dispatch_state='dead'` | [worker-and-queue-failures.md](worker-and-queue-failures.md) |
| Unknown growth | Unknown deliveries rising for 30 min | [failed-and-ambiguous-publications.md](failed-and-ambiguous-publications.md) |
| Readiness | `/api/ready` non-200 for 2 min | [deployment-and-configuration.md](deployment-and-configuration.md) |
| Billing webhooks | `billing_webhook_events.status='failed'` with attempts ≥ 5 | [billing-webhooks-and-reconciliation.md](billing-webhooks-and-reconciliation.md) |

Relay has no built-in paging integration; wire these to the deployment's monitoring.

## Verification

Each signal above returns to its healthy value; the alert clears on its own.

## Escalation

Readiness failing on all replicas, no heartbeat after a worker restart, or data inconsistency: escalate to the
engineering owner; consider [emergency-pause.md](emergency-pause.md) first if publications may be affected.
