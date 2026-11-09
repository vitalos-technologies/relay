#!/usr/bin/env bash
# Relay encrypted backup (nightly via relay-backup.timer; safe to run by hand any time).
#
#   sudo infra/oracle/backup.sh                 # full: Relay DB, Keycloak DB, roles, Keycloak realm export, media, config
#   sudo infra/oracle/backup.sh --db-only       # databases + config only (used by update.sh before a release)
#   sudo infra/oracle/backup.sh --label <name>  # suffix for the backup folder name
#
# Output: $RELAY_HOME/backups/<UTC timestamp>[-label]/ with *.age files (age-encrypted to the public key in
# $RELAY_HOME/backup/recipient.txt; the private key is NOT on this VM) and a plaintext MANIFEST (sizes, sha256, versions;
# no secrets). Plaintext never touches the disk: every stream is encrypted inside a network-less tools container.
# Rotation: keeps RELAY_BACKUP_KEEP_DAYS days (default 14), never fewer than the 3 newest complete backups.
# Optional off-VM copy: RELAY_BACKUP_RSYNC_TARGET in .env.infra (rsync over SSH). Unset by default (no paid services).
# Media: the storage container is paused (not stopped) while its volume is archived, so files are consistent;
# uploads during those seconds wait and then continue.
set -euo pipefail
SELF=$(readlink -f "${BASH_SOURCE[0]}")
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

DB_ONLY=0 LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --db-only) DB_ONLY=1; shift ;;
    --label) LABEL=$2; shift 2 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$SELF"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
require_root; require_installed
case "$LABEL" in *[!A-Za-z0-9._-]*) die "invalid label" ;; esac

RECIPIENT="$RELAY_HOME/backup/recipient.txt"
[ -s "$RECIPIENT" ] || die "no backup public key ($RECIPIENT): run bootstrap.sh --apply"
ensure_tools_image
KEEP_DAYS=$(env_get "$INFRA_ENV" RELAY_BACKUP_KEEP_DAYS); KEEP_DAYS=${KEEP_DAYS:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAME="$STAMP${LABEL:+-$LABEL}"
ROOT="$RELAY_HOME/backups"
WORK="$ROOT/.partial-$NAME"
install -d -m 0700 "$ROOT" "$WORK"
PAUSED=0
cleanup() {
  [ $PAUSED -eq 1 ] && compose unpause storage >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# enc FILE -> reads stdin, writes FILE.age encrypted to the recipient (inside the network-less tools container)
enc() { docker run --rm -i --network none -v "$RECIPIENT:/r:ro" "$TOOLS_IMAGE" age -R /r > "$WORK/$1.age"; }
pgx() { compose exec -T postgres "$@"; }

free_kb=$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')
min_mb=${RELAY_BACKUP_MIN_FREE_MB:-2048}
[ "$free_kb" -gt $((min_mb * 1024)) ] || die "less than $min_mb MB free under $ROOT; free space before backing up"

step "Relay backup $NAME"
compose ps --status running --services 2>/dev/null | grep -qx postgres || die "postgres is not running"
pgx pg_dump -U relay_admin -d relay -Fc -Z 6 | enc relay.dump; ok "Relay database (pg_dump custom format)"
pgx pg_dump -U relay_admin -d keycloak -Fc -Z 6 | enc keycloak.dump; ok "Keycloak database"
pgx pg_dumpall -U relay_admin --globals-only | enc globals.sql; ok "roles (password hashes) and tablespaces"
# Configuration: the KEKs in .env.production are needed to read stored provider credentials after a restore.
tar -C "$RELAY_HOME" -cf - .env.infra .env.production secrets | enc config.tar; ok "configuration and secrets"

if [ $DB_ONLY -eq 0 ]; then
  # Portable realm export (users, credentials, clients) in addition to the database dump. Separate short-lived JVM
  # against the same database; the running Keycloak keeps serving.
  if compose ps --status running --services | grep -qx keycloak; then
    if compose run --rm --no-deps -T -e JAVA_OPTS_KC_HEAP="-XX:MaxRAMPercentage=50" --entrypoint /bin/bash keycloak -c \
        '/opt/keycloak/bin/kc.sh export --dir /tmp/rx --realm relay --users realm_file >/tmp/rx.log 2>&1 && cat /tmp/rx/relay-realm.json || { tail -n 20 /tmp/rx.log >&2; exit 1; }' \
        | enc keycloak-realm.json; then
      ok "Keycloak realm export"
    else
      rm -f "$WORK/keycloak-realm.json.age"; warn "Keycloak realm export failed (the Keycloak database dump above still covers it)"
    fi
  fi
  vol=$(docker volume ls -q --filter "label=com.docker.compose.project=$RELAY_PROJECT" --filter "label=com.docker.compose.volume=media" | head -n 1)
  [ -n "$vol" ] || die "media volume not found"
  compose pause storage >/dev/null && PAUSED=1
  docker run --rm --network none -v "$vol:/data:ro" "$TOOLS_IMAGE" tar -C /data -cf - . | enc media.tar
  compose unpause storage >/dev/null && PAUSED=0
  ok "media volume ($vol)"
fi

{
  echo "relay-backup $NAME"
  echo "created_utc=$STAMP"
  echo "kind=$([ $DB_ONLY -eq 1 ] && echo db-only || echo full)"
  echo "image_tag=$(env_get "$INFRA_ENV" RELAY_IMAGE_TAG)"
  echo "domain=$(env_get "$INFRA_ENV" RELAY_DOMAIN)"
  echo "migrations_applied=$(pgx psql -U relay_admin -d relay -Atc 'SELECT count(*) FROM schema_migrations' 2>/dev/null || echo '?')"
  echo "last_migration=$(pgx psql -U relay_admin -d relay -Atc 'SELECT max(name) FROM schema_migrations' 2>/dev/null || echo '?')"
  echo "recipient=$(cat "$RECIPIENT")"
  echo "# sha256  size_bytes  file"
  for f in "$WORK"/*.age; do printf '%s  %s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$(stat -c %s "$f")" "$(basename "$f")"; done
} > "$WORK/MANIFEST"
mv "$WORK" "$ROOT/$NAME"
ok "saved $ROOT/$NAME ($(du -sh "$ROOT/$NAME" | cut -f1))"
date -u +%Y-%m-%dT%H:%M:%SZ > "$ROOT/LAST_SUCCESS"

# Rotation: drop complete backups older than KEEP_DAYS, always keeping the 3 newest.
mapfile -t all < <(find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | sort -r)
i=0
for d in "${all[@]}"; do
  i=$((i + 1)); [ $i -le 3 ] && continue
  if [ -n "$(find "$ROOT/$d" -maxdepth 0 -mtime +"$KEEP_DAYS")" ]; then rm -rf "${ROOT:?}/$d"; ok "rotated out $d"; fi
done
find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name '.partial-*' -mmin +720 -exec rm -rf {} + 2>/dev/null || true

TARGET=$(env_get "$INFRA_ENV" RELAY_BACKUP_RSYNC_TARGET)
if [ -n "$TARGET" ]; then
  have rsync || die "RELAY_BACKUP_RSYNC_TARGET is set but rsync is not installed"
  rsync -a "$ROOT/$NAME" "$TARGET/" && ok "copied to the off-VM target" || die "off-VM copy failed (local backup is fine)"
fi
