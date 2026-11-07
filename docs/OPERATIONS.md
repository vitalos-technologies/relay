# Operations runbook

## Daily

- **Operations** page (`/operations`): alerts, oldest due job, outbox backlog, worker heartbeat, Unknown count, live vs simulated success with denominators.
- **Home → Needs attention**: Blocked, Unknown, Failed, Expired.
- **Accounts**: anything not Ready (expiring tokens show 7 days ahead).

## Emergency pause

UI: sidebar **Pause** (owner/admin/approver) for the workspace, brand settings for a brand, Accounts for one account.
Effect: checked at dispatch — nothing new is sent after the pause commits. A request already sending may complete. On resume, timely jobs return to Scheduled; jobs past their deadline become Expired (never flooded out).

## Expired or revoked credentials

The account shows *Reconnect required* / *Missing permission*, its queued jobs become Blocked, owners/admins are notified (deduplicated). Fix: Accounts → Reconnect. Reconnecting the **same** identity restores Blocked jobs that are still timely; a **different** identity creates a new connection (old jobs are not redirected).

## Unknown results (ambiguous publication)

Cause: the provider may have created the post but the response was lost (timeout, crash mid-send).
1. The worker checks automatically (read-only) with backoff for up to 10 checks.
2. Telegram cannot be checked automatically. Open the channel, then on the post: **Resolve → Published** (paste the link) or **Not published**.
3. Retry of an Unknown requires ticking the duplicate-risk acknowledgement; it is audited and gets exactly one attempt.

## X budget

Caps per workspace in `workspaces.limits` (`x_monthly_writes`, `x_monthly_reads`). Notifications at 50/80/100 %. At 100 % X jobs are Blocked with the reason; other channels continue. Raise the cap (SQL, owner decision) and retry the blocked deliveries.

## Incident

1. Pause the affected scope. 2. Preserve evidence: `audit_events`, `delivery_attempts`, worker logs (correlation IDs). 3. Diagnose (`/operations`, `/api/diagnostics`). 4. Reconcile Unknowns. 5. Resume; only timely jobs proceed.

## Backup and restore

Backups: managed PostgreSQL PITR (target RPO ≤ 1 h). Drill (verified locally):

```bash
./scripts/restore-drill.sh   # dump → restore into isolated DB → dispatch OFF → reconciliation list
```
After a real restore **keep dispatch disabled** (`system_flags.dispatch_enabled=false`, workers stop claiming). Reconcile every delivery in the list (scheduled/in-flight/unknown and anything published in the last 24 h) against the providers — a restored database does not know about posts sent after the backup. Then:
```sql
UPDATE system_flags SET value='true' WHERE key='dispatch_enabled';
```

## Worker

Stateless; run one or more. Restart is safe: leases expire (90 s), preparation resumes from checkpoints, mid-send work becomes Unknown. SIGTERM drains for 30 s.

## Retention (worker, hourly)

Webhook bodies 7 days · idempotency keys 24 h · OAuth states / connection flows 1 day after expiry · sessions 7 days after expiry · dispatched outbox 30 days. Disconnected credentials are deleted immediately.
