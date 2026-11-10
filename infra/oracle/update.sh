#!/usr/bin/env bash
# Relay release / rollback on the VM. Forward-only migrations; automatic rollback to the previous image tag when the
# new version does not become healthy.
#
#   sudo infra/oracle/update.sh                          # git pull --ff-only, build natively, release
#   sudo infra/oracle/update.sh --no-pull                # build the current checkout, release
#   sudo infra/oracle/update.sh --images-tar f --tag T   # load images built elsewhere (build.sh --tar), release T
#   sudo infra/oracle/update.sh --tag T                  # release (or roll back to) images already on this VM
#   sudo infra/oracle/update.sh --restart                # same version; restart web + worker (after editing .env.production)
#   sudo infra/oracle/update.sh --rollback               # go back to the previous tag in the deploy history
#
# Steps: pre-release backup (database + config) -> release job with the NEW images (roles, migrations, grants,
# bucket; nothing restarts if it fails) -> worker (SIGTERM drain up to 30 s; mid-send work becomes Unknown, never resent)
# -> web -> /api/ready + worker health. On failure: previous tag restored and restarted. Migrations already applied
# stay (they are additive and backward compatible with the previous image by policy).
# Each restart of web is a few seconds of 502s at the proxy (single replica).
set -euo pipefail
SELF=$(readlink -f "${BASH_SOURCE[0]}")
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

PULL=1 TAG="" TAR="" RESTART=0 ROLLBACK=0 SKIP_BACKUP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull) PULL=0; shift ;;
    --tag) TAG=$2; PULL=0; shift 2 ;;
    --images-tar) TAR=$2; PULL=0; shift 2 ;;
    --restart) RESTART=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$SELF"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
require_root; require_installed
HIST="$RELAY_HOME/state/deploy-history.log"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PREV=$(env_get "$INFRA_ENV" RELAY_IMAGE_TAG)
[ -n "$PREV" ] || die "no current RELAY_IMAGE_TAG in $INFRA_ENV"
exec 9>"$RELAY_HOME/state/update.lock"; flock -n 9 || die "another update is running"

healthy_now() { wait_healthy worker "${1:-150}" && wait_ready "${1:-150}"; }
switch_to() { # TAG -> restart worker then web on that tag
  env_set "$INFRA_ENV" RELAY_IMAGE_TAG "$1"
  compose up -d --no-deps worker
  wait_healthy worker 150 || return 1
  compose up -d --no-deps web
}

if [ $RESTART -eq 1 ]; then
  step "Restart web + worker on $PREV"
  [ -n "$(env_get "$APP_ENV_FILE" SMTP_URL)" ] || die "SMTP_URL is not set in $APP_ENV_FILE: Relay refuses to start in production without it"
  # Bundled proxy: apply proxy config changes (e.g. network aliases) too; Caddy keeps its certificates in its volume.
  [ "$(env_get "$INFRA_ENV" RELAY_PROXY_MODE)" = bundled ] && compose up -d --no-deps caddy
  compose up -d --force-recreate --no-deps worker web
  healthy_now 240 && ok "healthy" || { compose logs --tail 40 web worker >&2; die "not healthy after restart (logs above)"; }
  exit 0
fi

if [ $ROLLBACK -eq 1 ]; then
  TAG=$(awk -v cur="$PREV" '$2 != cur {t=$2} END {print t}' "$HIST" 2>/dev/null)
  [ -n "$TAG" ] || die "no earlier tag in $HIST"
  say "Rolling back $PREV -> $TAG (no migration is reverted)"
fi

step "1. Images"
if [ -n "$TAR" ]; then
  [ -n "$TAG" ] || die "--images-tar needs --tag"
  docker load -i "$TAR"
elif [ -z "$TAG" ]; then
  if [ $PULL -eq 1 ]; then
    git -C "$REPO_DIR" pull --ff-only || die "git pull failed (local changes?); nothing changed"
  fi
  TAG=$(nice -n 10 "$KIT_DIR/build.sh" | tail -n 1)
fi
for t in web worker migrate; do docker image inspect "relay-$t:$TAG" >/dev/null 2>&1 || die "image relay-$t:$TAG not found"; done
[ "$TAG" != "$PREV" ] || { ok "already on $TAG"; exit 0; }
ok "new $TAG (current $PREV)"

if [ $SKIP_BACKUP -eq 0 ]; then
  step "2. Pre-release backup"
  "$KIT_DIR/backup.sh" --db-only --label "pre-$TAG" || die "backup failed; nothing changed"
fi

step "3. Release job with $TAG"
RELAY_IMAGE_TAG=$TAG compose run --rm migrate || die "release job failed with $TAG; the running version $PREV was not touched"

step "4. Switch to $TAG"
if switch_to "$TAG" && healthy_now 240; then
  printf '%s %s %s\n' "$STAMP" "$TAG" "$([ $ROLLBACK -eq 1 ] && echo rollback || echo release)" >> "$HIST"
  ok "Relay $TAG is live: /api/ready 200, worker healthy"
else
  warn "$TAG did not become healthy; rolling back to $PREV"
  compose logs --tail 30 web worker >&2 || true
  switch_to "$PREV" || true
  if healthy_now 240; then
    printf '%s %s auto-rollback-from-%s\n' "$STAMP" "$PREV" "$TAG" >> "$HIST"
    die "release of $TAG failed; rolled back to $PREV (healthy). Migrations from $TAG stay applied."
  fi
  die "release of $TAG failed AND $PREV is not healthy: see sudo infra/oracle/status.sh and docs/runbooks/migration-and-rollback.md"
fi

step "5. Prune old Relay images (keeps the 3 most recently deployed tags; never-deployed images are left alone)"
mapfile -t keep < <(awk '{print $2}' "$HIST" | tac | awk '!s[$0]++' | head -n 3)
mapfile -t deployed < <(awk '{print $2}' "$HIST" | sort -u)
for t in "${deployed[@]}"; do
  printf '%s\n' "${keep[@]}" "$TAG" | grep -qxF "$t" && continue
  for repo in relay-web relay-worker relay-migrate; do
    docker image rm "$repo:$t" >/dev/null 2>&1 && say "  removed $repo:$t"
  done
done
true
