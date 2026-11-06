#!/usr/bin/env bash
# Backup/restore drill (docs/OPERATIONS.md). Restores the dev database into an ISOLATED database,
# immediately disables dispatch there, and reports deliveries that must be reconciled against the
# providers before dispatch may be re-enabled. Restoring an old DB can otherwise republish posts.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
SRC=${SOURCE_DB:-socialite_dev}
DST=${TARGET_DB:-socialite_restore_drill}
OUT=${EVIDENCE_DIR:-evidence/restore-drill}
mkdir -p "$OUT"
PG="docker compose -f infra/compose.yaml exec -T postgres"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

echo "▸ Backup $SRC (pg_dump custom format)"
$PG pg_dump -U socialite -Fc "$SRC" > "$OUT/backup-$STAMP.dump"
ls -l "$OUT/backup-$STAMP.dump" | awk '{print "  size:", $5, "bytes"}'

echo "▸ Restore into isolated database $DST"
$PG dropdb -U socialite --if-exists "$DST"
$PG createdb -U socialite "$DST"
$PG pg_restore -U socialite -d "$DST" --no-owner < "$OUT/backup-$STAMP.dump"

echo "▸ Disable dispatch in the restored database BEFORE any worker could connect"
$PG psql -U socialite -d "$DST" -v ON_ERROR_STOP=1 -c "UPDATE system_flags SET value='false', updated_at=now(), updated_by='restore-drill' WHERE key='dispatch_enabled'" >/dev/null

echo "▸ Verify"
$PG psql -U socialite -d "$DST" -At -c "SELECT 'dispatch_enabled=' || value::text FROM system_flags WHERE key='dispatch_enabled'"
$PG psql -U socialite -d "$DST" -At -F ' | ' -c "SELECT 'rows: ' || (SELECT count(*) FROM posts) || ' posts, ' || (SELECT count(*) FROM deliveries) || ' deliveries, ' || (SELECT count(*) FROM schema_migrations) || ' migrations'"
SRC_COUNT=$($PG psql -U socialite -d "$SRC" -At -c "SELECT count(*) FROM deliveries")
DST_COUNT=$($PG psql -U socialite -d "$DST" -At -c "SELECT count(*) FROM deliveries")
[ "$SRC_COUNT" = "$DST_COUNT" ] && echo "  delivery count matches source ($SRC_COUNT)" || { echo "  MISMATCH source=$SRC_COUNT restored=$DST_COUNT"; exit 1; }

echo "▸ Reconciliation list (must be checked against providers before re-enabling dispatch)"
$PG psql -U socialite -d "$DST" -c "
  SELECT d.id, d.provider, d.is_mock AS simulated, d.state, d.due_at, d.published_at, array_length(d.provider_ids,1) AS provider_ids
    FROM deliveries d
   WHERE d.state IN ('scheduled','retry_wait','preparing','publishing','processing','unknown')
      OR (d.state='published' AND d.published_at > now() - interval '24 hours')
   ORDER BY d.due_at" | tee "$OUT/reconcile-$STAMP.txt"
echo "✔ Drill complete. Evidence in $OUT. Dispatch stays OFF in $DST until an operator reconciles and runs:"
echo "  UPDATE system_flags SET value='true' WHERE key='dispatch_enabled';"
