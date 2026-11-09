# Backup, restore and publication reconciliation

Audience: operators. Repo only. Reviewed 2026-11-09 (product 2026-11). Drill: `scripts/restore-drill.sh`
(verified locally in earlier releases; see `docs/OPERATIONS.md`).

**Prerequisites:** managed PostgreSQL point-in-time recovery (target RPO ≤ 1 hour) or `pg_dump` custom-format
backups; storage bucket versioning or backups for media; a second operator for the destructive steps.

**Affected resources:** the whole database (including the `pgboss` schema), every workspace's schedules and
deliveries, external networks (posts already published there).

> **Never blindly replay publications after a restore.** A restored database does not know about posts sent after
> the backup point. If dispatch runs before reconciliation, Relay can publish those posts a second time.

## Symptoms that call for a restore

Data loss or corruption that cannot be repaired forward (bad migration with no forward fix, destructive operator
error, storage-level failure of the database). A restore is a last resort: it discards every write after the
restore point.

## Before you restore

1. Pause the installation: dispatch switch off ([emergency-pause.md](emergency-pause.md)).
2. Stop all workers (they would otherwise claim work from the restored database the moment it is reachable).
3. Record the incident timeline: the restore point and the time of the last known good publication.
4. Take a fresh backup of the current (damaged) database for forensics. **DESTRUCTIVE** steps below replace it.

## Restore

1. **DESTRUCTIVE** Restore into a **new, isolated** database (point-in-time restore, or `pg_restore --no-owner` from a
   custom-format dump). Do not restore over the live database in place.
2. **CHANGES DATA** Immediately, before any worker or web process connects to the restored database:
   ```sql
   UPDATE system_flags SET value='false'::jsonb, updated_at=now(), updated_by='<operator>-restore' WHERE key='dispatch_enabled';
   ```
3. Re-apply role grants with an owner connection (roles are cluster-level; grants are per database).
4. Run the migration job (it only applies files newer than the restore point; checksums must match).
5. Point web servers at the restored database and start them. Keep workers stopped, or start them only after step 2 is
   verified (`SELECT value FROM system_flags WHERE key='dispatch_enabled'` → `false`).

## Reconcile publications

1. **READ-ONLY** List everything that may have changed on the networks after the restore point:
   ```sql
   SELECT d.id, d.workspace_id, d.provider, d.is_mock AS simulated, d.state, d.due_at, d.published_at, d.provider_ids, d.provider_url
     FROM deliveries d
    WHERE d.state IN ('scheduled','retry_wait','preparing','publishing','processing','unknown')
       OR (d.state = 'published' AND d.published_at > '<restore point>'::timestamptz - interval '24 hours')
    ORDER BY d.due_at;
   ```
   Also export the same list from the damaged database's forensic copy for the period after the restore point, if it
   is readable: it shows what was actually sent.
2. For every live (non-simulated) delivery due after the restore point, check the destination on the network:
   - **Posted** → resolve as **Published** with the link (the product's resolve action marks it published without
     sending; for deliveries not in `unknown`, ask engineering for the supported correction — never resend).
   - **Not posted and still wanted** → leave it scheduled.
   - **Not posted and no longer relevant** → cancel the schedule.
3. Deliveries in `preparing`, `publishing` or `processing` in the restored data become Unknown by lease expiry once
   workers run; reconcile them like any Unknown ([failed-and-ambiguous-publications.md](failed-and-ambiguous-publications.md)).
4. Media: assets uploaded after the restore point exist in storage but not in the database; they are unreachable and
   harmless. Assets referenced by the database but missing from storage need re-upload.
5. Tell affected workspaces what was restored, what may be missing (posts, comments, settings after the restore point)
   and which posts were reconciled.

## Re-enable dispatch

Only after every row of the reconciliation list has an owner and a decision:

```sql
UPDATE system_flags SET value='true'::jsonb, updated_at=now(), updated_by='<operator>' WHERE key='dispatch_enabled';
```

(or the admin console switch). Then start workers and watch `/admin/operations`. Deliveries past their publish-before
deadline expire instead of being sent late.

## Verification

- Row counts of key tables match expectations; `/api/ready` is green; no unexpected publications in the first hour
  (spot-check networks for duplicates).

## Escalation

Any doubt about what was published after the restore point: keep dispatch off and escalate to the incident lead.
Restores are always incident-level events.
