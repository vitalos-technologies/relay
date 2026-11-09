#!/usr/bin/env bash
# Relay status on the VM (read-only unless an operator command is given).
#
#   sudo infra/oracle/status.sh                         # containers, health, readiness, versions, disk, backups, TLS
#   sudo infra/oracle/status.sh --logs <service> [n]    # last n log lines (web, worker, keycloak, postgres, storage, caddy)
#   sudo infra/oracle/status.sh --operator list|grant <email> [operator|support|billing]|revoke <email>
#                                                       # platform operators (same as `pnpm platform:operator`; audited)
#   sudo infra/oracle/status.sh --psql [psql args]      # psql as the database owner (for runbook SQL; careful)
set -euo pipefail
SELF=$(readlink -f "${BASH_SOURCE[0]}")
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
case "${1:-}" in -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$SELF"; exit 0 ;; esac
require_root; require_installed

case "${1:-}" in
  --logs) compose logs --tail "${3:-100}" "${2:?service name}"; exit 0 ;;
  --operator) shift; compose run --rm --no-deps -T migrate node ops/platform-operator.mjs "$@"; exit $? ;;
  --psql) shift; if [ -t 0 ]; then compose exec postgres psql -U relay_admin -d relay "$@"; else compose exec -T postgres psql -U relay_admin -d relay "$@"; fi; exit $? ;;
  ""|--status) ;;
  -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$SELF"; exit 0 ;;
  *) die "unknown option: $1" ;;
esac

DOMAIN=$(env_get "$INFRA_ENV" RELAY_DOMAIN)
step "Relay on $DOMAIN — images $(env_get "$INFRA_ENV" RELAY_IMAGE_TAG), proxy mode $(env_get "$INFRA_ENV" RELAY_PROXY_MODE)"
compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'

step "Readiness"
code=$(http_code "http://127.0.0.1:$(web_port)/api/ready"); [ "$code" = 200 ] && ok "web /api/ready 200" || warn "web /api/ready $code"
if compose ps --status running --services | grep -qx worker; then
  w=$(compose exec -T worker node -e "fetch('http://127.0.0.1:3001/ready').then(async r=>{console.log(r.status)}).catch(()=>console.log(0))" 2>/dev/null || echo 0)
  [ "$w" = 200 ] && ok "worker /ready 200" || warn "worker /ready $w"
else warn "worker not running"; fi
kc=$(http_code "http://127.0.0.1:$(auth_port)/realms/relay/.well-known/openid-configuration"); [ "$kc" = 200 ] && ok "keycloak realm relay 200" || warn "keycloak realm relay $kc"
if compose ps --status running --services | grep -qx postgres; then
  say "  dispatch_enabled: $(compose exec -T postgres psql -U relay_admin -d relay -Atc "SELECT value FROM system_flags WHERE key='dispatch_enabled'" 2>/dev/null || echo '?')"
  say "  last worker heartbeat: $(compose exec -T postgres psql -U relay_admin -d relay -Atc "SELECT coalesce(max(last_seen_at)::text,'none') || ' (' || coalesce(max(version),'') || ')' FROM worker_heartbeats" 2>/dev/null || echo '?')"
  say "  migrations: $(compose exec -T postgres psql -U relay_admin -d relay -Atc "SELECT count(*) || ', last ' || max(name) FROM schema_migrations" 2>/dev/null || echo '?')"
fi

step "Public endpoints (through DNS and the reverse proxy)"
for u in "$(env_get "$INFRA_ENV" RELAY_APP_URL)/api/ready" "$(env_get "$INFRA_ENV" RELAY_AUTH_URL)/realms/relay/.well-known/openid-configuration"; do
  c=$(http_code "$u"); [ "$c" = 200 ] && ok "$u 200" || warn "$u $c (DNS, firewall or certificate not ready?)"
done
if have openssl; then
  end=$(echo | timeout 5 openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)
  [ -n "$end" ] && say "  TLS certificate for $DOMAIN valid until $end"
fi

step "Resources"
mapfile -t ids < <(compose ps -q)
[ ${#ids[@]} -gt 0 ] && docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' "${ids[@]}" 2>/dev/null || true
for v in $(docker volume ls -q --filter "label=com.docker.compose.project=$RELAY_PROJECT"); do
  say "  volume $v: $(du -sh "$(docker volume inspect -f '{{.Mountpoint}}' "$v")" 2>/dev/null | cut -f1)"
done

step "Backups"
last=$(cat "$RELAY_HOME/backups/LAST_SUCCESS" 2>/dev/null || echo never)
say "  last successful backup: $last"
say "  stored: $(find "$RELAY_HOME/backups" -mindepth 1 -maxdepth 1 -type d -name '20*' | wc -l) backups, $(du -sh "$RELAY_HOME/backups" 2>/dev/null | cut -f1)"
have systemctl && systemctl list-timers relay-backup.timer --no-pager 2>/dev/null | sed -n '1,2p' | sed 's/^/  /' || true
