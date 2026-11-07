# Operations runbook (admin)

| Symptom (where you see it) | Check | Action | Expected delay |
|---|---|---|---|
| Platform alert "No worker heartbeat in 60 s" (Platform health) | `.data/logs/worker.log` / host process; `worker_heartbeats` | Restart the worker with the **worker** DB role: `DATABASE_URL="$WORKER_DATABASE_URL" node apps/worker/dist/main.mjs` (as `scripts/dev.sh`). Using the app role fails with `permission denied for schema pgboss`. | Due posts resume within the claim poll (≈ 1 s) |
| "Due publications have waited > 2 min" | Operations → Publishing queue, workload delay p95; dispatch flag | If dispatch is off, start it (Platform health). If publishing pressure is on, bulk classes are deferring by design. | ≤ 60 s dispatch target |
| "Dispatch is off" banner | Platform health | *Start dispatch* (operator, reason). Past-deadline posts expire by rule. | Immediate |
| Unknown results (Deliveries → Needs attention) | Drawer → Reconciliation | Wait for automatic reconciliation; otherwise check the channel and *Resolve*. Retry only with duplicate-risk acceptance. | Reconcile cadence |
| Held (authority) after offboarding | People → Held publications | *Adopt* (re-validates approval and approvers) or cancel | Immediate |
| Account can't publish (Connections) | Drawer → Recommended fix | Reconnect / resume / wait for throttle; Relay app "Not configured" ⇒ Instance setup | On next attempt |
| Dead-lettered outbox events (Operations) | Event type and error | *Requeue* for safe types; others need an engineer (they could repeat email or external writes) | Next outbox pass (≈ 1 s) |
| Stale analytics (Analytics ingestion) | Stream state, last failure code | *Resync* (throttled). `permission_missing` ⇒ reconnect with insights scopes. | Next analytics tick |
| Import/export/writeback failures (Content and media) | Safe error | Retry in Content hub / Analytics where the record lives | Worker queue |
| Workspace abuse / payment hold | Platform → Workspace | *Suspend* with reason; *Reactivate* later | Next request / next claim |
| Compromised sign-in | Platform → Accounts | *Suspend account* (ends all sessions); the workspace decides on membership | Immediate |
| Support asked for access | Workspace admin → Support access | Approve for the shortest useful time; end when done | Immediate |

## Correlation
Every API response carries `x-correlation-id`; it is stored on audit rows, delivery attempts and problem reports. Search
the audit log or logs with it. Errors in admin lists are redacted (tokens, keys, signatures) and truncated.

## Data protection notes
Platform views carry no customer content. Platform audit and audit log are append-only for the app and worker database
roles (a database superuser can still change them; no external immutable sink is configured — see gaps).
