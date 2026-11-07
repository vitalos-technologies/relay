#!/usr/bin/env bash
# V2 migration rehearsal (V2 spec §10, §21): restore a V1 backup into a DISPOSABLE database, keep
# dispatch disabled, apply every newer migration, then verify data preservation and V2 invariants.
# Usage: ./scripts/migration-rehearsal.sh [path/to/v1-backup.dump]
set -euo pipefail
cd "$(dirname "$0")/.."
DUMP=${1:-$(ls -1 evidence/restore-drill/backup-*.dump 2>/dev/null | head -1)}
[ -f "$DUMP" ] || { echo "No V1 backup found. Run scripts/restore-drill.sh on a V1 database first." >&2; exit 1; }
DB=socialite_migration_rehearsal
OUT=evidence/v2/migration-rehearsal.txt
mkdir -p evidence/v2
PG="docker compose -f infra/compose.yaml exec -T postgres"
q() { $PG psql -U socialite -d "$DB" -v ON_ERROR_STOP=1 -At -c "$1"; }

{
echo "# Migration rehearsal $(date -u +%FT%TZ) from $(basename "$DUMP")"
$PG dropdb -U socialite --if-exists "$DB"
$PG createdb -U socialite "$DB"
$PG pg_restore -U socialite -d "$DB" --no-owner < "$DUMP"
q "UPDATE system_flags SET value='false' WHERE key='dispatch_enabled'"
echo "before: migrations=$(q 'SELECT count(*) FROM schema_migrations') members=$(q 'SELECT count(*) FROM memberships WHERE removed_at IS NULL') posts=$(q 'SELECT count(*) FROM posts') deliveries=$(q 'SELECT count(*) FROM deliveries') published=$(q "SELECT count(*) FROM deliveries WHERE state='published'")"
BEFORE_POSTS=$(q 'SELECT count(*) FROM posts'); BEFORE_DEL=$(q 'SELECT count(*) FROM deliveries'); BEFORE_PUB=$(q "SELECT count(*) FROM deliveries WHERE state='published'")
BEFORE_MEM=$(q 'SELECT count(*) FROM memberships WHERE removed_at IS NULL')

set -a; . ./.env; set +a
R_URL="postgres://socialite:socialite-local-only@localhost:54329/$DB"
# Point EVERY URL the CLI may read at the disposable database (never the dev DB).
DATABASE_URL="$R_URL" MIGRATOR_DATABASE_URL="$R_URL" DATABASE_ADMIN_URL="$R_URL" npx tsx packages/db/src/cli.ts migrate

echo "after:  migrations=$(q 'SELECT count(*) FROM schema_migrations') members=$(q 'SELECT count(*) FROM memberships WHERE status<>'"'removed'"'') posts=$(q 'SELECT count(*) FROM posts') deliveries=$(q 'SELECT count(*) FROM deliveries') published=$(q "SELECT count(*) FROM deliveries WHERE state='published'")"
fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1 ($2)"; else echo "FAIL $1 (expected $3, got $2)"; fail=1; fi; }
check "posts preserved" "$(q 'SELECT count(*) FROM posts')" "$BEFORE_POSTS"
check "deliveries preserved" "$(q 'SELECT count(*) FROM deliveries')" "$BEFORE_DEL"
check "published history preserved" "$(q "SELECT count(*) FROM deliveries WHERE state='published'")" "$BEFORE_PUB"
check "memberships preserved" "$(q "SELECT count(*) FROM memberships WHERE status<>'removed'")" "$BEFORE_MEM"
check "dispatch still disabled" "$(q "SELECT value::text FROM system_flags WHERE key='dispatch_enabled'")" "false"
check "every active member has a grant" "$(q "SELECT count(*) FROM memberships m WHERE m.status='active' AND NOT EXISTS (SELECT 1 FROM scoped_role_grants g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id)")" "0"
check "no broadened owner/admin grants" "$(q "SELECT count(*) FROM scoped_role_grants g JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id WHERE g.source='v1_backfill' AND g.role IN ('owner','admin') AND m.role::text <> g.role")" "0"
check "brand-restricted members not widened to workspace" "$(q "SELECT count(*) FROM scoped_role_grants g JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id WHERE g.source='v1_backfill' AND m.brand_restricted AND m.role NOT IN ('owner','admin') AND g.scope_type='workspace'")" "0"
check "no publisher grants created by backfill" "$(q "SELECT count(*) FROM scoped_role_grants WHERE source='v1_backfill' AND role='publisher'")" "0"
check "every workspace keeps an owner" "$(q "SELECT count(*) FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM scoped_role_grants g WHERE g.workspace_id=w.id AND g.role='owner' AND g.revoked_at IS NULL)")" "0"
echo "review items: $(q 'SELECT kind || '"'='"' || count(*) FROM migration_review_items GROUP BY kind' | tr '\n' ' ')"
echo "Rollback: application images roll back freely; schema is additive (no destructive down-migrations). Rehearsal DB kept: $DB"
[ $fail = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
} 2>&1 | tee "$OUT"
grep -q "RESULT: PASS" "$OUT"
