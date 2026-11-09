# Migrations and rollback

Audience: operators. Repo only. Reviewed 2026-11-09 (product 2026-11). Background:
`content/help/developers/data-model-and-migrations.md`, `docs/V3_1_MIGRATION_AND_ROLLBACK.md`.

**Prerequisites:** a verified backup or point-in-time recovery window; the migrator connection; the release's image
digests and the previous release's digests.

**Affected resources:** the PostgreSQL schema (`schema_migrations`), all processes.

## How migrations behave

- Files `packages/db/migrations/NNN_name.sql`, applied in order by the migration job (`node dist/migrate.mjs migrate`
  in the worker image, or `pnpm db:migrate`).
- One job at a time (advisory lock). Each file runs in its own transaction; a failure rolls that file back and stops.
- Applied files are recorded with a SHA-256 checksum; a changed applied file aborts with `checksum mismatch`.
- Forward-only: there are no down migrations. Releases keep schema changes additive so the previous images still run.
- After migrating, apply role grants (`pnpm db:roles` locally; in production the release job applies
  `infra/postgres/roles.sql` with an owner connection) so the app and worker roles can use new tables.

## Symptoms

- Migration job fails: `migration NNN_x.sql failed: <error>`.
- `checksum mismatch` for an already applied file.
- `/api/ready` reports fewer applied migrations than the release expects.
- After a release: errors such as `permission denied for table …` (grants not applied) or `relation … does not exist`.

## Diagnostics (READ-ONLY)

```sql
SELECT name, applied_at FROM schema_migrations ORDER BY name DESC LIMIT 10;
SELECT pid, state, query_start, left(query, 80) FROM pg_stat_activity WHERE query ILIKE '%pg_advisory_lock%';
```

## Corrective actions

| Situation | Action |
|---|---|
| A migration failed | The failed file was rolled back; earlier files in the run stay applied. Fix the cause (locks held by long transactions, data that violates a new constraint), then re-run the job. Do not mark the file applied by hand. |
| Checksum mismatch | Someone changed an applied file. Restore the file exactly as applied (from the release that applied it). Put the change in a new migration. |
| Grants missing | Re-apply the role grants with an owner connection. |
| Job waits forever | Another migration job holds the advisory lock; let it finish or stop it, never run two in parallel. |
| Release must be rolled back | See below. |

### Roll back a release

1. If publishing is affected, pause first ([emergency-pause.md](emergency-pause.md)).
2. Redeploy the **previous** web and worker image digests. Additive migrations stay; the previous code ignores new
   tables and columns.
3. If the previous release cannot run on the new schema (a non-additive change slipped in), do **not** hand-edit the
   schema. Options, in order: hot-fix forward with a new migration; or restore to a point in time before the
   migration ([backup-restore-and-reconciliation.md](backup-restore-and-reconciliation.md)) — **DESTRUCTIVE**: loses
   everything written since, and requires publication reconciliation.
4. Clear any rolling-deploy pin (`system_flags.dispatch_version`) that names the rolled-back version.

### Rehearse risky migrations

`./scripts/migration-rehearsal.sh <backup.dump>` restores a backup into a disposable database with dispatch disabled,
applies every newer migration and checks data preservation. Use it before migrations that rewrite large tables.

## Verification

- `/api/ready` → migrations count matches the release; no permission errors in logs; the worker claims work.

## Escalation

Any failed migration in production, or any data loss: stop and escalate to the engineering owner before retrying.
