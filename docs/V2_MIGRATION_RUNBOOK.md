# V2 migration runbook (V1.1 → V2)

Upgrade a running V1.1 deployment (migrations 001–008 applied) to Relay V2. External inputs (IdP, secrets, DNS) are in [V2_FINAL_ACTIVATION_CHECKLIST.md](V2_FINAL_ACTIVATION_CHECKLIST.md). Never paste secret values into tickets or chat.

**Key facts**
- Migrations are **forward-only**, additive, checksum-verified, one transaction per file, serialised by an advisory lock (`packages/db/src/migrate.ts`). A failed file rolls back alone.
- **Only one generation of workers may dispatch.** A V1.1 worker does not run the V2 authority gate. Stop all V1.1 workers before migrating; start V2 workers only with dispatch disabled.
- **Do not roll the application back to V1.1 images after migrating** (see §9).
- The migrator applies every file in `packages/db/migrations`. A build from the current tree also contains V3 migrations (014+). For a V2-only upgrade use the V2 release image.

## 1. Before the window

| Check | How |
|---|---|
| V1.1 schema | `SELECT name FROM schema_migrations ORDER BY name;` ends at `008_rate_limits_and_deletion.sql` |
| V2 images built and pinned by digest | `./scripts/build-images.sh <tag>` |
| IdP (Keycloak) realm, client and SMTP ready | Activation checklist §1 |
| DB role passwords stored in the secret manager | Activation checklist §3 |
| Rehearsal passed on a copy of production (§2) | Rehearsal output shows `RESULT: PASS` |
| Key-encryption keys available for the backup | Same KEKs/KMS key as production (needed to read restored tokens) |

## 2. Rehearse on a disposable copy

Local (compose Postgres):
```bash
./scripts/restore-drill.sh                      # produces evidence/restore-drill/backup-*.dump
./scripts/migration-rehearsal.sh [backup.dump]  # restores into socialite_migration_rehearsal
```
The rehearsal restores the dump, sets `dispatch_enabled=false`, runs the migrator against that database only (all URLs point at it), and checks: posts, deliveries, published deliveries and non-removed memberships unchanged; dispatch still disabled; every active member has a grant; no owner/admin grant broader than the V1 role; brand-restricted members not widened to workspace; no publisher grants created; every workspace keeps an owner. Output: `evidence/v2/migration-rehearsal.txt` (last run 2026-11-07: PASS, V1 dump with 3 migrations → 014).

Limits: runs against the local compose container only, as the bootstrap superuser (it does not exercise the least-privilege roles), and does not rehearse rollback. For production data, restore a production backup into an isolated database and run the same `check` queries from the script by hand.

## 3. Back up and record counts

```bash
pg_dump -Fc "$OWNER_URL" > relay-v11-pre-v2-$(date -u +%Y%m%dT%H%M%SZ).dump   # plus a PITR restore point if available
```
```sql
SELECT (SELECT count(*) FROM posts) posts, (SELECT count(*) FROM deliveries) deliveries,
       (SELECT count(*) FROM deliveries WHERE state='published') published,
       (SELECT count(*) FROM memberships WHERE removed_at IS NULL) members;
```

## 4. Drain V1.1

1. Disable dispatch (workers stop claiming): `UPDATE system_flags SET value='false' WHERE key='dispatch_enabled';`
2. Stop V1.1 workers (SIGTERM; they drain up to 30 s). Anything still mid-send is resolved later by lease expiry → Unknown, never resent.
3. Stop V1.1 web (or serve a maintenance page): V1.1 writes against the V2 schema can fail (TipSignal binding, brand approval switch) or bypass V2 rules.
4. Confirm nothing holds a lease: `SELECT count(*) FROM deliveries WHERE lease_owner IS NOT NULL;` → 0 (or only expired leases).

## 5. Least-privilege database roles

| Role | Used by | Rights |
|---|---|---|
| `socialite_migrator` | migration job (`MIGRATOR_DATABASE_URL`) | Owns schema objects; only role with DDL |
| `socialite_app` | web (`DATABASE_URL`) | DML on app tables; `audit_events` INSERT/SELECT only; no DDL |
| `socialite_worker` | worker (its `DATABASE_URL`) | Same DML as app; owns the `pgboss` schema (needs database `CREATE`) |

None is superuser, CREATEDB, CREATEROLE or BYPASSRLS. Apply with an owner connection **before and after** the migration:
```bash
DATABASE_ADMIN_URL=<owner url> DATABASE_URL=<app url> WORKER_DATABASE_URL=<worker url> MIGRATOR_DATABASE_URL=<migrator url> pnpm db:roles
```
`scripts/db-roles.ts` (runs from a repo checkout with `tsx`; it is not in the images) creates/updates the three login roles (passwords taken from those URLs) and applies `infra/postgres/roles.sql` (moves existing objects to the migrator, grants DML, default privileges, revokes audit-log UPDATE/DELETE). If your platform provisions roles itself, create them with the attributes above and apply `roles.sql` with an owner connection (`psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f infra/postgres/roles.sql`).

The worker reads `DATABASE_URL`; set the **worker container's** `DATABASE_URL` to the `socialite_worker` URL (`WORKER_DATABASE_URL` is only a `scripts/dev.sh` convention).

## 6. Run migrations 009–013

```bash
docker run --rm --env-file prod.env <worker-image> node dist/migrate.mjs migrate   # uses MIGRATOR_DATABASE_URL
```

| File | Purpose |
|---|---|
| `009_v2_authz.sql` | Membership status + history, policy version + security policy, teams, delegation limits, service accounts + API key hashes, scoped role grants, restrictions, session assurance columns; backfills V1 roles into grants without broadening and writes `migration_review_items` |
| `010_v2_identity.sql` | Session IdP fields, step-up/IdP-action OIDC states, back-channel logout replay table, service-account/API-key columns; converts the TipSignal acting-member binding into a service account with an `integration` grant; resets users bound to the local Dex issuer to `pending` |
| `011_v2_tenancy.sql` | Invitations v2 (grants, teams, guest expiry, resend, accepted identity), ownership transfers, connection verification flags, publication authorizations (immutable scope) + adoption events; backfills an authority record for every active schedule |
| `012_v2_collaboration.sql` | Campaigns, post planning fields, immutable draft version history (backfilled), approval policy generations/stages (backfilled from `approval_required`) + guard trigger, approval binding columns, immutable approval decisions (backfilled), review shares, comments + mentions, notification preferences/settings |
| `013_v2_product.sql` | Team dimension + reservations on usage counters (primary key → partial unique indexes), team budgets, storage gauge backfill, per-workspace dispatch state, duplicate window per brand, activity index |

Then re-run `pnpm db:roles` (§5).

## 7. Verify the schema and data

Run the rehearsal checks against production (counts from §3 must match), plus:
```sql
SELECT name FROM schema_migrations WHERE name >= '009' ORDER BY name;               -- 009…013
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname LIKE 'socialite_%';  -- all false
SELECT value FROM system_flags WHERE key='dispatch_enabled';                         -- false
SELECT kind, count(*) FROM migration_review_items WHERE resolved_at IS NULL GROUP BY kind;
SELECT count(*) FROM publication_authorizations a JOIN schedules s ON s.id=a.schedule_id WHERE s.status='active';  -- = active schedules
```
`migration_review_items` has **no UI**: read `detail` for each row.
- `v1_editors_can_publish` — brands where V1 editors could schedule. V2 needs explicit `publisher` grants.
- `v1_approver_scheduling` — approvers who could schedule approved content in V1. Grant `publisher` if intended.

Mark rows handled with `UPDATE migration_review_items SET resolved_at=now() WHERE id=…`.

## 8. Identity cut-over (Dex/other issuer → Keycloak)

How the code handles it:
- Users are matched by `(oidc_issuer, oidc_subject)`. A user whose issuer is `pending` is bound on the first login whose **IdP-verified** email matches (`packages/services/src/auth/users.ts`). A bound user is never re-bound: a login from a different issuer/subject with the same email fails with `account_conflict`.
- Migration 010 resets only users bound to the **local development** Dex issuer (`http://localhost:5556/dex`) to `pending`. Users bound to any other issuer are untouched.
- Step-up and factor actions require the session user's stored issuer to equal the configured issuer.

Therefore:

| Situation | What happens | Action |
|---|---|---|
| `OIDC_ISSUER` unchanged (already Keycloak, same realm URL) | Nothing changes | None |
| Issuer changes (e.g. managed IdP → Keycloak) | Every existing user gets `account_conflict` | No built-in tool. The only re-binding path is `pending`. If, and only if, the new IdP has registration disabled, accounts are admin-provisioned and emails are verified, an operator may run `UPDATE users SET oidc_issuer='pending', oidc_subject='pending:'||email WHERE oidc_issuer='<old issuer>';` and record it in the change ticket. Anyone controlling that verified email at the new IdP will receive the account. |
| New people | Created on first verified login; join workspaces only via invitation | – |

Existing V1.1 sessions survive the migration with `mfa_verified=false`, so privileged users must verify before sensitive actions. To force everyone through the new IdP, revoke them: `UPDATE sessions SET revoked_at=now(), revoked_reason='v2_cutover' WHERE revoked_at IS NULL;`

## 9. Start V2

1. Configure web (`DATABASE_URL` = app role) and worker (`DATABASE_URL` = worker role), `OIDC_*`, SMTP, KMS. Production refuses to boot with local/dev settings.
2. Start the V2 worker (dispatch still disabled), then web; `/api/ready` → 200, worker `:3001/ready` → 200.
3. Owner signs in, enrols a second factor on **Security**, completes step-up.
4. Handle review items (§7): grant `publisher` where scheduling is still intended.
5. Check **Team → Held**. Backfilled schedules without an approval are checked against their creator; if the creator lacks the V2 permission (e.g. a V1 editor on an "editors can publish" brand) they are **held** at dispatch and a publisher adopts them. Approval-based schedules are checked against their approvers instead.
6. Enable dispatch: `UPDATE system_flags SET value='true' WHERE key='dispatch_enabled';`

## 10. Verify after go-live

- Owner: sign-in with TOTP; **Security** lists the session; step-up works.
- Back-channel logout: sign the user out in Keycloak → their Relay session is gone on the next request.
- Editor: cannot schedule (needs publisher). Publisher without MFA: told to verify.
- Invite a test address → email arrives → acceptance only with that verified email.
- Publish one post to a simulated or canary destination; no duplicate sends; activity centre shows the events.
- `SELECT count(*) FROM deliveries WHERE state='published'` ≥ the pre-migration count.

## 11. Rollback

| When | Option |
|---|---|
| A migration file fails | That file is rolled back. Fix the cause and re-run; earlier files stay applied. Do not edit an applied file (checksum stops the migrator). |
| V2 serving, defect found | **Forward fix** or redeploy an earlier **V2** image digest. Pause publishing first if anything published wrongly. |
| Must return to V1.1 | **Restore the pre-migration backup** into a new database, keep dispatch disabled, reconcile per `docs/OPERATIONS.md` (restore procedure), then point V1.1 at it. Everything written after the backup is lost. |

Why not run V1.1 images on the V2 schema (verified in the V1.1 code):
- V1.1 checks only `memberships.removed_at`: **suspended members regain access**.
- V1.1 reads the legacy role summary: guests appear as brand viewers with no expiry; restrictions, team grants and connection scopes are ignored.
- The V1.1 worker has no publication-authority gate; schedules created by V1.1 have no authority record and are held (`authority_missing`) once V2 runs again.
- V1.1 writes that now fail: TipSignal binding (`service_account_id` NOT NULL), brand approval switch (`brands_guard_approval_required` trigger).

Roll back by restoring the pre-upgrade backup, not by redeploying V1.1 images (the rehearsal script's closing line says so).
