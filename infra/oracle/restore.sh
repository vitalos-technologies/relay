#!/usr/bin/env bash
# Relay restore and restore drill. Read docs/runbooks/backup-restore-and-reconciliation.md first: a restored database
# does not know about posts published after the backup point. NEVER blindly replay publications.
#
#   sudo infra/oracle/restore.sh --drill   <backup dir> --identity <key file>   # isolated check; live stack untouched
#   sudo infra/oracle/restore.sh --promote <backup dir> --identity <key file> [--keycloak] [--media]
#   sudo infra/oracle/restore.sh --extract-config <backup dir> --identity <key file> --to <new dir>
#   sudo infra/oracle/restore.sh --start-worker                                   # after reconciliation (see runbook)
#
# <key file> holds the backup PRIVATE key you stored offline at install time (AGE-SECRET-KEY-...). Create it only for
# the restore (sudo install -m 600 /dev/null /root/relay-backup.key; sudo nano /root/relay-backup.key) and delete it
# afterwards (sudo shred -u /root/relay-backup.key).
#
# --drill    restores the Relay and Keycloak dumps into a throwaway PostgreSQL container with NO network, forces
#            dispatch off there, prints counts and the reconciliation candidates, checks the media, realm and config
#            archives decrypt, then deletes the container. Nothing live is touched. Run it monthly.
# --promote  live restore (DESTRUCTIVE, second operator advised): pauses dispatch, stops web + worker, keeps the current
#            database as relay_before_restore_<time>, restores, forces dispatch OFF before anything connects, runs the
#            release job, starts web only. The worker stays stopped until you reconcile and run --start-worker.
#            --keycloak also restores the Keycloak database (current one kept as keycloak_before_restore_<time>);
#            --media also restores media (current volume copied to <volume>_before_restore_<time> first).
set -euo pipefail
SELF=$(readlink -f "${BASH_SOURCE[0]}")
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

MODE="" DIR="" IDENTITY="" WITH_KC=0 WITH_MEDIA=0 TO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --drill|--promote|--extract-config) MODE=${1#--}; DIR=${2:-}; shift 2 || die "$1 needs a backup directory" ;;
    --start-worker) MODE=start-worker; shift ;;
    --identity) IDENTITY=$2; shift 2 ;;
    --keycloak) WITH_KC=1; shift ;;
    --media) WITH_MEDIA=1; shift ;;
    --to) TO=$2; shift 2 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$SELF"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done
[ -n "$MODE" ] || die "choose --drill, --promote, --extract-config or --start-worker (see --help)"
require_root; require_installed
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
psqla() { compose exec -T postgres psql -U relay_admin -v ON_ERROR_STOP=1 -At "$@"; }

if [ "$MODE" = start-worker ]; then
  flag=$(psqla -d relay -c "SELECT value FROM system_flags WHERE key='dispatch_enabled'")
  say "dispatch_enabled = $flag"
  if [ "$flag" = true ]; then
    warn "dispatch is ON: the worker will publish due posts as soon as it starts. Only continue if every row of the"
    warn "reconciliation list has an owner and a decision (runbook: backup-restore-and-reconciliation.md)."
    read -r -p "Type 'reconciled' to start the worker: " a; [ "$a" = reconciled ] || die "not started"
  fi
  compose up -d worker && wait_healthy worker 120 && ok "worker started"
  exit 0
fi

[ -d "$DIR" ] && [ -f "$DIR/MANIFEST" ] || die "not a Relay backup directory: $DIR"
[ -n "$IDENTITY" ] && [ -r "$IDENTITY" ] || die "--identity <file with the backup private key> is required"
grep -q 'AGE-SECRET-KEY-' "$IDENTITY" || die "$IDENTITY does not look like an age private key"
ensure_tools_image
step "Verify checksums ($DIR)"
while read -r sum _ f; do
  [ -f "$DIR/$f" ] || die "missing $f"
  [ "$(sha256sum "$DIR/$f" | cut -d' ' -f1)" = "$sum" ] || die "checksum mismatch: $f"
  ok "$f"
done < <(grep -E '^[0-9a-f]{64}  ' "$DIR/MANIFEST")
# dec FILE -> decrypted stream on stdout (inside the network-less tools container; identity mounted read-only)
dec() { docker run --rm -i --network none -v "$(realpath "$IDENTITY"):/k:ro" "$TOOLS_IMAGE" age -d -i /k < "$DIR/$1"; }
magic=$(dec relay.dump.age 2>/dev/null | head -c 5 || true)
[ "$magic" = PGDMP ] || die "cannot decrypt relay.dump.age with this key"
ok "the key decrypts this backup"

if [ "$MODE" = extract-config ]; then
  [ -n "$TO" ] || die "--to <new directory> is required"
  [ ! -e "$TO" ] || die "$TO exists; choose a new directory"
  install -d -m 0700 "$TO"
  dec config.tar.age | tar -C "$TO" -xf -
  ok "configuration extracted to $TO (0700). For a new VM: copy .env.infra, .env.production and secrets/ into $RELAY_HOME before bootstrap.sh."
  exit 0
fi

RECON_SQL="SELECT d.provider, d.state, count(*) FROM deliveries d
 WHERE d.is_mock = false AND (d.state IN ('scheduled','retry_wait','preparing','publishing','processing','unknown')
    OR (d.state = 'published' AND d.published_at > now() - interval '48 hours'))
 GROUP BY 1,2 ORDER BY 1,2"
PG_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$(compose ps -q postgres 2>/dev/null | head -n 1)" 2>/dev/null || true)
PG_IMAGE=${PG_IMAGE:-${RELAY_POSTGRES_IMAGE:-postgres:16-alpine}}

if [ "$MODE" = drill ]; then
  step "Restore drill into an isolated container (no network; live stack untouched)"
  C="relay-restore-drill-$STAMP"
  docker run -d --name "$C" --network none -e POSTGRES_USER=relay_admin -e POSTGRES_DB=postgres \
    -e POSTGRES_HOST_AUTH_METHOD=trust "$PG_IMAGE" >/dev/null
  trap 'docker rm -fv "$C" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 60); do docker exec "$C" pg_isready -U relay_admin -d postgres >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  dx() { docker exec -i "$C" "$@"; }
  dec globals.sql.age | dx psql -U relay_admin -d postgres -q >/dev/null 2>&1 || true   # "role exists" lines are expected
  dx createdb -U relay_admin relay
  dec relay.dump.age | dx pg_restore -U relay_admin -d relay --exit-on-error && ok "Relay database restored"
  dx psql -U relay_admin -d relay -qc "UPDATE system_flags SET value='false'::jsonb, updated_at=now(), updated_by='restore-drill' WHERE key='dispatch_enabled'"
  [ "$(dx psql -U relay_admin -d relay -Atc "SELECT value FROM system_flags WHERE key='dispatch_enabled'")" = false ] && ok "dispatch forced OFF in the restored copy"
  say "  migrations: $(dx psql -U relay_admin -d relay -Atc "SELECT count(*) || ' applied, last ' || max(name) FROM schema_migrations")"
  say "  rows: $(dx psql -U relay_admin -d relay -Atc "SELECT 'workspaces=' || (SELECT count(*) FROM workspaces) || ' users=' || (SELECT count(*) FROM users) || ' deliveries=' || (SELECT count(*) FROM deliveries)")"
  say "  reconciliation candidates (live deliveries still open, or published in the last 48 hours):"
  dx psql -U relay_admin -d relay -c "$RECON_SQL" | sed 's/^/    /'
  dx createdb -U relay_admin keycloak
  dec keycloak.dump.age | dx pg_restore -U relay_admin -d keycloak --exit-on-error && ok "Keycloak database restored ($(dx psql -U relay_admin -d keycloak -Atc "SELECT string_agg(name, ',') FROM realm") realms)"
  if [ -f "$DIR/keycloak-realm.json.age" ]; then
    dec keycloak-realm.json.age | grep -c '"realm" : "relay"' >/dev/null && ok "realm export decrypts (realm relay)"
  fi
  if [ -f "$DIR/media.tar.age" ]; then
    n=$(dec media.tar.age | docker run --rm -i --network none "$TOOLS_IMAGE" tar -tf - | wc -l)
    ok "media archive readable ($n entries)"
  fi
  dec config.tar.age | docker run --rm -i --network none "$TOOLS_IMAGE" tar -tf - | grep -qx '.env.production' && ok "configuration archive readable (contains the KEKs)"
  ok "drill complete; the isolated container is removed"
  exit 0
fi

# ---- promote (live restore) -----------------------------------------------------------------------------------------
step "LIVE restore from $(basename "$DIR")"
warn "This replaces the live Relay database$( [ $WITH_KC -eq 1 ] && echo ', the Keycloak database')$( [ $WITH_MEDIA -eq 1 ] && echo ' and media'). Current data is kept aside, not deleted."
warn "Everything after the backup point is lost from Relay; posts already sent to networks must be reconciled by hand."
read -r -p "Type the backup folder name ($(basename "$DIR")) to continue: " a
[ "$a" = "$(basename "$DIR")" ] || die "cancelled"

psqla -d relay -c "UPDATE system_flags SET value='false'::jsonb, updated_at=now(), updated_by='restore-pause' WHERE key='dispatch_enabled'" >/dev/null 2>&1 \
  && ok "dispatch paused on the current database" || warn "could not pause dispatch on the current database (continuing)"
compose stop worker web
ok "worker and web stopped"

OLD="relay_before_restore_$STAMP"
psqla -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='relay' AND pid <> pg_backend_pid()" >/dev/null
psqla -d postgres -c "ALTER DATABASE relay RENAME TO $OLD"
ok "current database kept as $OLD"
psqla -d postgres -c "CREATE DATABASE relay OWNER relay_admin"
psqla -d postgres -c "REVOKE ALL ON DATABASE relay FROM PUBLIC"
dec globals.sql.age | compose exec -T postgres psql -U relay_admin -d postgres -q >/dev/null 2>&1 || true
dec relay.dump.age | compose exec -T postgres pg_restore -U relay_admin -d relay --exit-on-error || {
  warn "pg_restore failed. To go back: ALTER DATABASE relay RENAME TO relay_failed_$STAMP; ALTER DATABASE $OLD RENAME TO relay;"
  die "restore failed; web and worker remain stopped"; }
psqla -d relay -c "UPDATE system_flags SET value='false'::jsonb, updated_at=now(), updated_by='restore' WHERE key='dispatch_enabled'" >/dev/null
[ "$(psqla -d relay -c "SELECT value FROM system_flags WHERE key='dispatch_enabled'")" = false ] || die "could not force dispatch off; stopping here"
ok "restored; dispatch forced OFF before anything connected"
compose run --rm migrate >/dev/null && ok "release job re-applied roles, grants and any newer migrations"

if [ $WITH_KC -eq 1 ]; then
  compose stop keycloak
  psqla -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='keycloak' AND pid <> pg_backend_pid()" >/dev/null
  psqla -d postgres -c "ALTER DATABASE keycloak RENAME TO keycloak_before_restore_$STAMP"
  psqla -d postgres -c "CREATE DATABASE keycloak OWNER keycloak"
  psqla -d postgres -c "REVOKE ALL ON DATABASE keycloak FROM PUBLIC"
  dec keycloak.dump.age | compose exec -T postgres pg_restore -U relay_admin -d keycloak --exit-on-error
  compose up -d keycloak
  ok "Keycloak database restored (previous kept as keycloak_before_restore_$STAMP)"
fi

if [ $WITH_MEDIA -eq 1 ]; then
  [ -f "$DIR/media.tar.age" ] || die "this backup has no media archive (db-only)"
  vol=$(docker volume ls -q --filter "label=com.docker.compose.project=$RELAY_PROJECT" --filter "label=com.docker.compose.volume=media" | head -n 1)
  compose stop storage
  docker volume create "${vol}_before_restore_$STAMP" >/dev/null
  docker run --rm --network none -v "$vol:/from:ro" -v "${vol}_before_restore_$STAMP:/to" "$TOOLS_IMAGE" cp -a /from/. /to/
  docker run --rm --network none -v "$vol:/data" "$TOOLS_IMAGE" sh -c 'find /data -mindepth 1 -delete'
  dec media.tar.age | docker run --rm -i --network none -v "$vol:/data" "$TOOLS_IMAGE" tar -C /data -xf -
  compose up -d storage && wait_healthy storage 120
  ok "media restored (previous copy in volume ${vol}_before_restore_$STAMP)"
fi

compose up -d web
wait_ready 240 && ok "web ready; the worker is NOT running"
cat <<EOF

  Next (docs/runbooks/backup-restore-and-reconciliation.md, "Reconcile publications"):
   1. Reconcile every live delivery due after the backup point against the networks (resolve as Published with the
      link, leave scheduled, or cancel). Never resend.
   2. Re-enable dispatch in the admin console (Platform -> dispatch switch) only when every row has a decision.
   3. sudo infra/oracle/restore.sh --start-worker
   4. Later, after a few days, drop the kept copies: sudo infra/oracle/status.sh --psql -c 'DROP DATABASE $OLD'
EOF
