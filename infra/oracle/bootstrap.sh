#!/usr/bin/env bash
# Relay — first install (and safe re-run) on a SHARED Linux VM (Oracle Ampere arm64 primary).
#
#   sudo infra/oracle/bootstrap.sh                 # DRY RUN (default): detects and explains, changes nothing
#   sudo infra/oracle/bootstrap.sh --apply         # does it, showing every file change (diff + backup) first
#
# What --apply changes on the VM (and nothing else):
#   - /opt/relay/ (RELAY_HOME): root-only env files with generated secrets, S3 identity file, backup public key,
#     encrypted backups, proxy-file backups. Docker project "relay": its own containers, network and volumes.
#   - Reverse proxy, depending on what serves ports 80/443: ONE new Relay-only site file (nginx / Caddy / Apache /
#     Traefik dynamic file) plus, for host Caddy, one `import` line appended to its Caddyfile; or the bundled Caddy
#     container when 80/443 are free. Existing files are backed up and diffed before any change; other sites untouched.
#   - systemd: relay-backup.service + relay-backup.timer (nightly encrypted backup).
# It never installs packages, opens firewall ports, edits other sites, prints secrets, or touches other containers.
#
# Options:
#   --apply                    make the changes (default is a dry run)
#   --domain <name>            public hostname (default: existing value, else relay.vitalos.co.uk). auth.<name> and
#                              media.<name> are derived; override with --auth-host / --media-host
#   --proxy <mode>             skip detection: nginx | caddy-host | apache | traefik-file | traefik-docker | bundled | manual
#   --bind <IPv4>              bundled Caddy listens on this address only (e.g. the VM's private IP) instead of 0.0.0.0.
#                              80/443 then count as free when nothing listens on that address or on all addresses, so
#                              listeners on other addresses (e.g. Tailscale's 100.x) are left alone. Saved for re-runs.
#   --web-port <n> --auth-port <n> --media-port <n>   loopback ports for Relay (defaults 3300 / 3380 / 3333). Saved.
#   --backup-days <n>          days of nightly backups to keep (default 14; never fewer than the 3 newest). Saved.
#   --tag <tag>                use already-present images relay-{web,worker,migrate}:<tag> (no build)
#   --images-tar <file>        `docker load` images built elsewhere (see build.sh --tar), use with --tag
#   --skip-start               prepare everything but do not start the stack
#   --allow-no-smtp            start without email (see below); default is to stop before web/worker until SMTP_URL is set
#   --self-registration        import the realm with self-registration ON (needs working realm SMTP; D26)
#   --run-certbot <email>      nginx/apache: run `certbot certonly --webroot` for the three names (DNS must point here)
#   --backup-identity-out <f>  write the backup private key to <f> instead of showing it on screen (non-interactive)
#   --yes                      do not ask before applying a shown diff
#   --home <dir>               RELAY_HOME (default /opt/relay)
#
# Email: Relay refuses to start in production without SMTP_URL (assertProductionSafe). --allow-no-smtp writes a
# deliberately unresolvable placeholder (smtp://email-not-configured.invalid:587): the app starts, every email fails
# and is logged as email_send_failed, and Diagnostics shows the SMTP check failing. Replace it before real users arrive.
set -euo pipefail
SELF=$(readlink -f "${BASH_SOURCE[0]}")
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

APPLY=0 DOMAIN="" AUTH_HOST="" MEDIA_HOST="" PROXY_MODE="" TAG="" IMAGES_TAR="" SKIP_START=0 ALLOW_NO_SMTP=0
SELF_REG=0 CERTBOT_EMAIL="" IDENTITY_OUT="" YES=0 BIND_IP="" OPT_WEB_PORT="" OPT_AUTH_PORT="" OPT_MEDIA_PORT="" OPT_BACKUP_DAYS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --domain) DOMAIN=$2; shift 2 ;;
    --auth-host) AUTH_HOST=$2; shift 2 ;;
    --media-host) MEDIA_HOST=$2; shift 2 ;;
    --proxy) PROXY_MODE=$2; shift 2 ;;
    --bind) BIND_IP=$2; shift 2 ;;
    --web-port) OPT_WEB_PORT=$2; shift 2 ;;
    --auth-port) OPT_AUTH_PORT=$2; shift 2 ;;
    --media-port) OPT_MEDIA_PORT=$2; shift 2 ;;
    --backup-days) OPT_BACKUP_DAYS=$2; shift 2 ;;
    --tag) TAG=$2; shift 2 ;;
    --images-tar) IMAGES_TAR=$2; shift 2 ;;
    --skip-start) SKIP_START=1; shift ;;
    --allow-no-smtp) ALLOW_NO_SMTP=1; shift ;;
    --self-registration) SELF_REG=1; shift ;;
    --run-certbot) CERTBOT_EMAIL=$2; shift 2 ;;
    --backup-identity-out) IDENTITY_OUT=$2; shift 2 ;;
    --yes) YES=1; shift ;;
    --home) RELAY_HOME=$2; INFRA_ENV="$RELAY_HOME/.env.infra"; APP_ENV_FILE="$RELAY_HOME/.env.production"; shift 2 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$SELF"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done
is_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]; }
for _v in "$OPT_WEB_PORT" "$OPT_AUTH_PORT" "$OPT_MEDIA_PORT"; do [ -z "$_v" ] || is_port "$_v" || die "ports must be 1024-65535 (got $_v)"; done
[ -z "$OPT_BACKUP_DAYS" ] || { [[ "$OPT_BACKUP_DAYS" =~ ^[0-9]+$ ]] && [ "$OPT_BACKUP_DAYS" -ge 1 ]; } || die "--backup-days must be a whole number >= 1"
if [ -n "$BIND_IP" ]; then
  [[ "$BIND_IP" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || die "--bind takes an IPv4 address (got $BIND_IP)"
  for _o in "${BASH_REMATCH[@]:1}"; do [ "$_o" -le 255 ] || die "--bind: invalid IPv4 address $BIND_IP"; done
fi

# Ports the detection looks at (tests use other ports; production is always 80/443).
HTTP_PORT=${RELAY_DETECT_HTTP_PORT:-80}
HTTPS_PORT=${RELAY_DETECT_HTTPS_PORT:-443}
NGINX_DIR=${RELAY_NGINX_DIR:-/etc/nginx}
CADDY_DIR=${RELAY_CADDY_DIR:-/etc/caddy}
APACHE_DIR=${RELAY_APACHE_DIR:-/etc/apache2}
ACME_WEBROOT=${RELAY_ACME_WEBROOT:-/var/www/relay-acme}
LE_LIVE=${RELAY_LE_LIVE:-/etc/letsencrypt/live/relay}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PROXY_BACKUP_DIR="$RELAY_HOME/backups/proxy/$STAMP"
PLAN=()   # human-readable list of changes (dry run) / done (apply)
plan() { PLAN+=("$*"); if [ $APPLY -eq 1 ]; then ok "$*"; else say "  [dry-run] would: $*"; fi; }

if [ $APPLY -eq 1 ]; then require_root; fi
[ "$(id -u)" = 0 ] || warn "not running as root: detection of process names and root-only files is limited (dry run continues)"

# ---------------------------------------------------------------------------------------------------------------------
step "1. Host checks"
ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64) ok "architecture $ARCH (Ampere/arm64: native image builds)" ;;
  x86_64|amd64) ok "architecture $ARCH (amd64 images; fine, arm64 is the primary target)" ;;
  *) die "unsupported architecture $ARCH (arm64 or amd64 only)" ;;
esac
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  OS_NAME=$( . /etc/os-release; printf '%s' "${PRETTY_NAME:-$ID}")
  ok "OS: $OS_NAME"
fi
if ! have docker; then
  say "  Docker Engine is not installed. This script does not install software on a shared server."
  say "  Install it from Docker's official repository (includes the compose and buildx plugins):"
  say "    Ubuntu:        https://docs.docker.com/engine/install/ubuntu/"
  say "    Oracle Linux:  https://docs.docker.com/engine/install/rhel/  (or the oraclelinux-developer docker-ce repo)"
  die "Docker is required"
fi
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running? are you root?)"
DOCKER_VER=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')
COMPOSE_VER=$(docker compose version --short 2>/dev/null || true)
[ -n "$COMPOSE_VER" ] || die "the docker compose v2 plugin is missing (install docker-compose-plugin from Docker's repository)"
ok "Docker $DOCKER_VER, compose $COMPOSE_VER"
cv=${COMPOSE_VER#v}; cmaj=${cv%%.*}; cmin=${cv#*.}; cmin=${cmin%%.*}
if [ "$cmaj" -lt 2 ] || { [ "$cmaj" -eq 2 ] && [ "$cmin" -lt 24 ]; }; then die "compose $COMPOSE_VER is too old (need 2.24+ for env_file options)"; fi
docker buildx version >/dev/null 2>&1 && ok "buildx available" || warn "buildx missing: needed to build images on this VM (or load a tar built elsewhere)"
MEM_AVAIL_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
MEM_TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
DOCKER_ROOT=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
DISK_FREE_GB=$(df -P "$DOCKER_ROOT" 2>/dev/null | awk 'NR==2 {print int($4/1048576)}')
say "  memory: ${MEM_AVAIL_MB} MB available of ${MEM_TOTAL_MB} MB; disk free under $DOCKER_ROOT: ${DISK_FREE_GB} GB"
[ "${MEM_AVAIL_MB:-0}" -ge 4500 ] || warn "Relay's default limits add up to about 5.5 GB (about 1 GB used when idle). Lower the RELAY_*_MEM values in $INFRA_ENV if the VM is tight."
[ "${DISK_FREE_GB:-0}" -ge 15 ] || warn "less than 15 GB free: images (~2.5 GB) plus build cache, the database, media and nightly backups need room (fewer backups: --backup-days N)"

INSTALLED=0
if [ -r "$INFRA_ENV" ]; then INSTALLED=1; ok "existing installation found in $RELAY_HOME (re-run: secrets are kept, nothing is regenerated)"; fi
if docker ps -a --format '{{.Label "com.docker.compose.project"}}' | grep -qx "$RELAY_PROJECT"; then
  say "  Docker project '$RELAY_PROJECT' already has containers:"
  docker ps -a --filter "label=com.docker.compose.project=$RELAY_PROJECT" --format '    {{.Names}}  {{.Status}}'
  [ $INSTALLED -eq 1 ] || die "containers of project '$RELAY_PROJECT' exist but $INFRA_ENV does not. Refusing to guess; investigate first."
fi

# ---------------------------------------------------------------------------------------------------------------------
step "2. Domain"
[ -n "$DOMAIN" ] || DOMAIN=$(env_get "$INFRA_ENV" RELAY_DOMAIN)
[ -n "$DOMAIN" ] || DOMAIN=$DEFAULT_DOMAIN
[ -n "$AUTH_HOST" ] || { AUTH_HOST=$(env_get "$INFRA_ENV" RELAY_AUTH_HOST); [ -n "$AUTH_HOST" ] && [ "$DOMAIN" = "$(env_get "$INFRA_ENV" RELAY_DOMAIN)" ] || AUTH_HOST="auth.$DOMAIN"; }
[ -n "$MEDIA_HOST" ] || { MEDIA_HOST=$(env_get "$INFRA_ENV" RELAY_MEDIA_HOST); [ -n "$MEDIA_HOST" ] && [ "$DOMAIN" = "$(env_get "$INFRA_ENV" RELAY_DOMAIN)" ] || MEDIA_HOST="media.$DOMAIN"; }
for h in "$DOMAIN" "$AUTH_HOST" "$MEDIA_HOST"; do
  [[ "$h" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || die "invalid hostname: $h"
done
URL_PORT=${RELAY_URL_PORT:-}   # test only (e.g. :8443); empty in production
say "  app:   https://$DOMAIN$URL_PORT"
say "  auth:  https://$AUTH_HOST$URL_PORT   (Keycloak sign-in; admin console private)"
say "  media: https://$MEDIA_HOST$URL_PORT  (signed media URLs for browsers and networks)"
OLD_DOMAIN=$(env_get "$INFRA_ENV" RELAY_DOMAIN)
if [ -n "$OLD_DOMAIN" ] && [ "$OLD_DOMAIN" != "$DOMAIN" ]; then
  warn "domain changes from $OLD_DOMAIN to $DOMAIN. The Keycloak realm was imported with the old URLs: update the relay-web client's redirect/logout URIs and WebAuthn RP ID in the admin console afterwards."
fi
for h in "$DOMAIN" "$AUTH_HOST" "$MEDIA_HOST"; do
  ips=$(getent ahostsv4 "$h" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
  if [ -n "$ips" ]; then say "  DNS $h -> $ips"; else say "  DNS $h -> (no A record yet)"; fi
done
say "  Each name needs a DNS A record pointing at this VM's public IP (or one A record for $DOMAIN plus a wildcard *.${DOMAIN})."

# ---------------------------------------------------------------------------------------------------------------------
step "3. Who serves ports $HTTP_PORT/$HTTPS_PORT?"
# listener PORT -> "<process name> <pid>" of the TCP listener, "" if free. Uses ss, else /proc (needs root for names).
listener() {
  local port=$1 out="" hex inode pid
  if have ss; then
    out=$(ss -H -ltnp "sport = :$port" 2>/dev/null | head -n 1)
    if [ -n "$out" ]; then
      if [[ "$out" =~ users:\(\(\"([^\"]+)\",pid=([0-9]+) ]]; then printf '%s %s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"; else printf 'unknown -'; fi
      return
    fi
    return
  fi
  hex=$(printf '%04X' "$port")
  local tables=() t
  for t in /proc/net/tcp /proc/net/tcp6; do [ -r "$t" ] && tables+=("$t"); done
  inode=$(awk -v p=":$hex" '$4=="0A" && substr($2, length($2)-4)==p {print $10; exit}' "${tables[@]}" 2>/dev/null || true)
  [ -n "$inode" ] || return 0
  for fd in /proc/[0-9]*/fd/*; do
    if [ "$(readlink "$fd" 2>/dev/null)" = "socket:[$inode]" ]; then
      pid=${fd#/proc/}; pid=${pid%%/*}
      printf '%s %s' "$(cat "/proc/$pid/comm" 2>/dev/null || echo unknown)" "$pid"; return
    fi
  done
  printf 'unknown -'
}
# container_on PORT -> "<name> <image>" of a container publishing the host port, if any.
container_on() {
  docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>/dev/null \
    | awk -F'|' -v p=":$1->" 'index($3, p) {print $1 " " $2; exit}'
}
classify() { # NAME [IMAGE] -> nginx | caddy | traefik | apache | other
  local s="$1 ${2:-}"
  case "$s" in
    *traefik*) echo traefik ;; *caddy*) echo caddy ;; *apache*|*httpd*) echo apache ;; *nginx*|*openresty*) echo nginx ;; *) echo other ;;
  esac
}
# Listener on PORT that conflicts with binding ADDR:PORT (same address, or a wildcard 0.0.0.0 / * / [::]). Prints "name pid".
listener_conflicting() {
  local port=$1 addr=$2 line local_addr
  have ss || { listener "$port"; return; }
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    local_addr=$(awk '{print $4}' <<<"$line")
    case "$local_addr" in
      "$addr:$port"|"0.0.0.0:$port"|"*:$port"|"[::]:$port"|":::$port")
        if [[ "$line" =~ users:\(\(\"([^\"]+)\",pid=([0-9]+) ]]; then printf '%s %s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"; else printf 'unknown -'; fi
        return ;;
    esac
  done < <(ss -H -ltnp "sport = :$port" 2>/dev/null)
}
describe_port() { # PORT -> sets D_KIND (free|host|container) D_SERVER D_DETAIL D_PID
  local port=$1 l c
  D_KIND=free D_SERVER="" D_DETAIL="" D_PID=""
  if [ -n "$BIND_IP" ]; then l=$(listener_conflicting "$port" "$BIND_IP"); else l=$(listener "$port"); fi
  c=$(container_on "$port")
  if [ -n "$c" ]; then
    D_KIND=container; D_DETAIL="container ${c%% *} (image ${c#* })"; D_SERVER=$(classify "${c%% *}" "${c#* }"); D_PID=""
  elif [ -n "$l" ]; then
    D_KIND=host; D_PID=${l#* }; D_SERVER=$(classify "${l%% *}")
    D_DETAIL="process ${l%% *} (pid $D_PID)"
    if [ "${l%% *}" = unknown ]; then D_DETAIL="a process this user cannot identify (re-run with sudo)"; fi
  fi
}
[ -n "$BIND_IP" ] || BIND_IP=$(env_get "$INFRA_ENV" RELAY_BIND_IP)
[ -z "$BIND_IP" ] || say "  checking ports on $BIND_IP only (plus wildcard listeners); other addresses are left alone"
describe_port "$HTTP_PORT";  K80=$D_KIND S80=$D_SERVER; say "  port $HTTP_PORT:  ${D_DETAIL:-free}"
describe_port "$HTTPS_PORT"; K443=$D_KIND S443=$D_SERVER P443=$D_PID; say "  port $HTTPS_PORT: ${D_DETAIL:-free}"
TRAEFIK_CONTAINER=""
if [ "$K443" = container ]; then TRAEFIK_CONTAINER=$(container_on "$HTTPS_PORT"); TRAEFIK_CONTAINER=${TRAEFIK_CONTAINER%% *}; fi

DETECTED=manual
if [ "$K80" = free ] && [ "$K443" = free ]; then DETECTED=bundled
elif [ "$K443" != free ] && { [ "$K80" = free ] || [ "$S80" = "$S443" ]; }; then
  case "$K443:$S443" in
    host:nginx) DETECTED=nginx ;; host:caddy) DETECTED=caddy-host ;; host:apache) DETECTED=apache ;;
    host:traefik) DETECTED=traefik-file ;; container:traefik) DETECTED=traefik-docker ;;
    container:*) DETECTED=container-proxy ;; *) DETECTED=manual ;;
  esac
elif [ "$K443" = free ] && [ "$K80" != free ]; then DETECTED=manual   # something on 80 only: do not fight it
fi
PREV_MODE=$(env_get "$INFRA_ENV" RELAY_PROXY_MODE)
if [ -z "$PROXY_MODE" ]; then
  PROXY_MODE=$DETECTED
  # Our own bundled Caddy holds 80/443 on a re-run: keep it.
  if [ "$PREV_MODE" = bundled ] && [ "$K443" = container ] && docker ps --filter "label=com.docker.compose.project=$RELAY_PROJECT" --format '{{.Names}}' | grep -q caddy; then PROXY_MODE=bundled; fi
fi
case "$PROXY_MODE" in
  bundled)         say "  -> 80/443 are free${BIND_IP:+ on $BIND_IP}: Relay runs its own Caddy container (automatic HTTPS) for its three names only." ;;
  nginx)           say "  -> nginx on the host: a separate Relay server-block file is added; other sites are untouched." ;;
  caddy-host)      say "  -> Caddy on the host: a separate Relay site file is added and imported." ;;
  apache)          say "  -> Apache on the host: a separate Relay vhost file is written; you enable it (commands shown)." ;;
  traefik-file)    say "  -> Traefik on the host: a Relay dynamic-configuration file is written for its file provider." ;;
  traefik-docker)  say "  -> Traefik in Docker: Relay's public containers join its network with Traefik labels." ;;
  container-proxy) say "  -> another proxy runs in a container: Relay joins its network; you add the snippet shown to its config." ;;
  manual)          say "  -> unrecognised setup: nothing is changed; the snippet and upstream ports are shown for your proxy." ;;
  *) die "unknown --proxy mode: $PROXY_MODE" ;;
esac

# ---------------------------------------------------------------------------------------------------------------------
step "4. Loopback ports for Relay (127.0.0.1 only)"
WEB_PORT=${OPT_WEB_PORT:-$(env_get "$INFRA_ENV" RELAY_WEB_PORT)}; WEB_PORT=${WEB_PORT:-${RELAY_WEB_PORT:-3300}}
AUTH_PORT=${OPT_AUTH_PORT:-$(env_get "$INFRA_ENV" RELAY_AUTH_PORT)}; AUTH_PORT=${AUTH_PORT:-${RELAY_AUTH_PORT:-3380}}
MEDIA_PORT=${OPT_MEDIA_PORT:-$(env_get "$INFRA_ENV" RELAY_MEDIA_PORT)}; MEDIA_PORT=${MEDIA_PORT:-${RELAY_MEDIA_PORT:-3333}}
for p in "$WEB_PORT" "$AUTH_PORT" "$MEDIA_PORT"; do
  c=$(container_on "$p"); l=$(listener "$p")
  if [ -z "$c$l" ]; then ok "127.0.0.1:$p free"
  elif docker ps --filter "label=com.docker.compose.project=$RELAY_PROJECT" --format '{{.Ports}}' | grep -q ":$p->"; then ok "127.0.0.1:$p is Relay's own"
  else die "port $p is used by ${c:-$l}. Pick free ports: sudo $0 --web-port N --auth-port N --media-port N"
  fi
done

# ---------------------------------------------------------------------------------------------------------------------
step "5. Secrets and settings ($RELAY_HOME)"
rand_hex() { od -An -N"${1:-32}" -tx1 /dev/urandom | tr -d ' \n'; }
rand_b64() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }
INFRA_SECRETS=(POSTGRES_ADMIN_PASSWORD RELAY_DB_MIGRATOR_PASSWORD RELAY_DB_APP_PASSWORD RELAY_DB_WORKER_PASSWORD
  KEYCLOAK_DB_PASSWORD KC_BOOTSTRAP_ADMIN_PASSWORD RELAY_OIDC_CLIENT_SECRET RELAY_S3_ACCESS_KEY_ID RELAY_S3_SECRET_ACCESS_KEY)
write_app_env_template() { # $1 file (new); secrets generated here, never echoed
  umask 077
  cat > "$1" <<EOF
# Relay application settings for the web and worker containers (docs/runbooks/oracle-vm-deployment.md).
# Generated on this VM by infra/oracle/bootstrap.sh on $STAMP. Root-only (0600). Never paste values into chat,
# tickets or the repository. compose.prod.yaml sets URLs, database, identity and storage settings itself; values there
# win over this file. After editing: sudo infra/oracle/update.sh --restart
APP_ENV=production
SESSION_SECRET=$(rand_hex 32)
# Key-encryption keys for stored provider credentials. Keep old entries when rotating (there is no re-wrap tool).
# Losing this value makes stored credentials unreadable: it is included (encrypted) in every backup.
KEY_ENCRYPTION_KEYS=relay-$(date -u +%Y%m):$(rand_b64)
LOG_LEVEL=info

# ---- Activation items (docs/FINAL_ACTIVATION_CHECKLIST.md). Uncomment and fill in on the VM; leave unset until then.
# Email (§3). REQUIRED: Relay refuses to start in production without it. Oracle blocks outbound port 25: use 587/465.
# SMTP_URL=smtps://<user>:<password>@<smtp host>:465
# EMAIL_FROM=Relay <no-reply@<your domain>>

# Sign-up (§2.8, D26): only after realm SMTP works and self-registration is on in Keycloak.
# ALLOW_SELF_SERVE_WORKSPACES=true

# Billing (§7, D22). Relay-namespaced on purpose; test keys until BILLING_LIVE_MODE=enabled.
# RELAY_STRIPE_SECRET_KEY=
# RELAY_STRIPE_WEBHOOK_SECRET=
# RELAY_STRIPE_WEBHOOK_SECRET_PREVIOUS=
# BILLING_LIVE_MODE=enabled

# AI (§9, D32). Both are needed; AI stays "not set up" otherwise. The model id comes from the provider's docs.
# ANTHROPIC_API_KEY=
# AI_MODEL=
# AI_FALLBACK_MODELS=
# AI_MODEL_PRICES=

# Meta webhooks (§4.6). Environment only.
# META_WEBHOOK_VERIFY_TOKEN=

# Provider apps (§4-6). Either here or on the protected Setup page (stored encrypted); a value here wins.
# META_APP_ID=
# META_APP_SECRET=
# META_REQUEST_INSIGHTS=
# META_REQUEST_INBOX=
# X_CLIENT_ID=
# X_CLIENT_SECRET=
# TIKTOK_CLIENT_KEY=
# TIKTOK_CLIENT_SECRET=
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# LINKEDIN_CLIENT_ID=
# LINKEDIN_CLIENT_SECRET=
# THREADS_APP_ID=
# THREADS_APP_SECRET=
# PINTEREST_APP_ID=
# PINTEREST_APP_SECRET=
# TELEGRAM_WEBHOOK_SECRET=
# GOOGLE_CONTENT_CLIENT_ID=
# GOOGLE_CONTENT_CLIENT_SECRET=
# GOOGLE_PICKER_API_KEY=
# GOOGLE_PICKER_APP_ID=
# NOTION_CLIENT_ID=
# NOTION_CLIENT_SECRET=
# (never set NOTION_INTERNAL_TOKEN in production)

# MCP (§10), optional overrides; defaults derive from the URLs above.
# MCP_DCR_ENABLED=

# Tuning (small shared VM defaults).
# WORKER_CONCURRENCY=4
# DATABASE_POOL_MAX=10
EOF
}
write_infra_env() { # $1 file; keeps existing secrets, fills missing ones, rewrites derived non-secret values
  local f=$1 k
  umask 077
  [ -f "$f" ] || printf '# Relay infrastructure settings and secrets for infra/oracle/compose.prod.yaml.\n# Generated on this VM by bootstrap.sh. Root-only (0600). Never paste values into chat, tickets or the repository.\n' > "$f"
  chmod 600 "$f"
  env_set "$f" RELAY_HOME "$RELAY_HOME"
  env_set "$f" RELAY_DOMAIN "$DOMAIN"
  env_set "$f" RELAY_AUTH_HOST "$AUTH_HOST"
  env_set "$f" RELAY_MEDIA_HOST "$MEDIA_HOST"
  env_set "$f" RELAY_APP_URL "https://$DOMAIN$URL_PORT"
  env_set "$f" RELAY_AUTH_URL "https://$AUTH_HOST$URL_PORT"
  env_set "$f" RELAY_MEDIA_URL "https://$MEDIA_HOST$URL_PORT"
  env_set "$f" RELAY_PROXY_MODE "$PROXY_MODE"
  env_set "$f" RELAY_WEB_PORT "$WEB_PORT"
  env_set "$f" RELAY_AUTH_PORT "$AUTH_PORT"
  env_set "$f" RELAY_MEDIA_PORT "$MEDIA_PORT"
  if [ -n "$BIND_IP" ]; then
    env_set "$f" RELAY_BIND_IP "$BIND_IP"
    env_set "$f" RELAY_CADDY_HTTP_PORT "$BIND_IP:80"
    env_set "$f" RELAY_CADDY_HTTPS_PORT "$BIND_IP:443"
    # Containers reach the three public names through the proxy; with --bind it only listens on BIND_IP (the Docker
    # host gateway would get no answer, and the VM can't hairpin to its own public IP).
    env_set "$f" RELAY_PROXY_TARGET "$BIND_IP"
  fi
  [ -z "$OPT_BACKUP_DAYS" ] || env_set "$f" RELAY_BACKUP_KEEP_DAYS "$OPT_BACKUP_DAYS"
  [ -n "$(env_get "$f" RELAY_SELF_REGISTRATION)" ] || env_set "$f" RELAY_SELF_REGISTRATION "$([ $SELF_REG -eq 1 ] && echo true || echo false)"
  [ -n "$(env_get "$f" RELAY_BACKUP_KEEP_DAYS)" ] || env_set "$f" RELAY_BACKUP_KEEP_DAYS 14
  for k in "${INFRA_SECRETS[@]}"; do
    [ -n "$(env_get "$f" "$k")" ] && continue
    case "$k" in
      RELAY_S3_ACCESS_KEY_ID) env_set "$f" "$k" "relay$(rand_hex 8)" ;;
      KC_BOOTSTRAP_ADMIN_PASSWORD|RELAY_OIDC_CLIENT_SECRET|RELAY_S3_SECRET_ACCESS_KEY) env_set "$f" "$k" "$(rand_hex 24)" ;;
      *) env_set "$f" "$k" "$(rand_hex 24)" ;;
    esac
  done
  grep -q '^# RELAY_BACKUP_RSYNC_TARGET' "$f" || printf '%s\n' '# Optional off-VM copy of each encrypted backup (rsync over SSH, e.g. user@host:/path). Unset = local only.' '# RELAY_BACKUP_RSYNC_TARGET=' >> "$f"
}
write_s3_identity() { # identity file for SeaweedFS from the generated keys (0600)
  local f="$RELAY_HOME/secrets/s3.json" ak sk tmp
  ak=$(env_get "$INFRA_ENV" RELAY_S3_ACCESS_KEY_ID); sk=$(env_get "$INFRA_ENV" RELAY_S3_SECRET_ACCESS_KEY)
  tmp=$(mktemp "$f.XXXXXX"); chmod 600 "$tmp"
  printf '{"identities":[{"name":"relay","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}\n' "$ak" "$sk" > "$tmp"
  mv "$tmp" "$f"
}

if [ $APPLY -eq 1 ]; then
  install -d -m 0750 "$RELAY_HOME"
  install -d -m 0700 "$RELAY_HOME/secrets" "$RELAY_HOME/backups" "$RELAY_HOME/backup" "$RELAY_HOME/state" "$RELAY_HOME/proxy"
fi
if [ -f "$INFRA_ENV" ]; then plan "keep $INFRA_ENV (existing secrets kept; derived URLs/ports refreshed; missing secrets added)"
else plan "create $INFRA_ENV (0600): generated ${INFRA_SECRETS[*]}"; fi
[ $APPLY -eq 1 ] && write_infra_env "$INFRA_ENV"
if [ -f "$APP_ENV_FILE" ]; then plan "keep $APP_ENV_FILE unchanged"
else plan "create $APP_ENV_FILE (0600): generated SESSION_SECRET, KEY_ENCRYPTION_KEYS; activation variables listed, unset"
  [ $APPLY -eq 1 ] && write_app_env_template "$APP_ENV_FILE"
fi
plan "write $RELAY_HOME/secrets/s3.json (0600) from the generated storage keys"
[ $APPLY -eq 1 ] && write_s3_identity
say "  Secret values are never printed. To read one on the VM yourself: sudo grep '^NAME=' $INFRA_ENV"

# ---------------------------------------------------------------------------------------------------------------------
step "6. Backup encryption key"
RECIPIENT="$RELAY_HOME/backup/recipient.txt"
if [ -s "$RECIPIENT" ]; then ok "public key exists ($RECIPIENT); the private key was shown once at first install"
else
  plan "generate an age key pair: keep only the PUBLIC key on the VM; show the PRIVATE key once for offline storage"
  if [ $APPLY -eq 1 ]; then
    ensure_tools_image
    if [ -z "$IDENTITY_OUT" ] && [ ! -t 0 ]; then die "no terminal to show the backup key: re-run interactively or pass --backup-identity-out <file>"; fi
    ident=$(tools age-keygen 2>/dev/null)
    pub=$(printf '%s\n' "$ident" | tools age-keygen -y)
    if [ -n "$IDENTITY_OUT" ]; then
      ( umask 077; printf '%s\n' "$ident" > "$IDENTITY_OUT" )
      say "  Private backup key written to $IDENTITY_OUT (0600). Move it OFF this VM now (password manager / offline media)."
    else
      say ""
      say "  ${C_B}BACKUP PRIVATE KEY — shown once, never stored on this VM.${C_0}"
      say "  Copy everything between the lines into your password manager (or print it and keep it offline)."
      say "  Without it, the encrypted backups cannot be restored."
      say "  ------------------------------------------------------------------------------"
      printf '%s\n' "$ident"
      say "  ------------------------------------------------------------------------------"
      ans=""
      while [ "$ans" != stored ]; do read -r -p "  Type 'stored' once it is saved somewhere safe: " ans; done
      clear 2>/dev/null || true
    fi
    unset ident
    ( umask 022; printf '%s\n' "$pub" > "$RECIPIENT" )
    ok "public key saved to $RECIPIENT"
  fi
fi

# ---------------------------------------------------------------------------------------------------------------------
step "7. Reverse proxy integration ($PROXY_MODE)"
PROXY_HDRS='proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port 443;'
V6=""; [ -e /proc/net/if_inet6 ] && V6=1   # only emit IPv6 listen lines where the kernel has IPv6
have_certs() { [ -s "$LE_LIVE/fullchain.pem" ] && [ -s "$LE_LIVE/privkey.pem" ]; }
render_nginx() {
  cat <<EOF
# Relay — generated by infra/oracle/bootstrap.sh. Serves ONLY $DOMAIN, $AUTH_HOST and $MEDIA_HOST.
# Other sites on this server are untouched. Re-running bootstrap.sh regenerates this file (previous copy backed up
# under $RELAY_HOME/backups/proxy/). Relay sets its own security headers (CSP, HSTS, X-Frame-Options): do not add or
# strip them here.
upstream relay_web   { server 127.0.0.1:$WEB_PORT;   keepalive 16; }
upstream relay_auth  { server 127.0.0.1:$AUTH_PORT;  keepalive 8; }
upstream relay_media { server 127.0.0.1:$MEDIA_PORT; keepalive 8; }

server {
    listen 80;
${V6:+    listen [::]:80;}
    server_name $DOMAIN $AUTH_HOST $MEDIA_HOST;
    location ^~ /.well-known/acme-challenge/ { root $ACME_WEBROOT; default_type text/plain; }
EOF
  if have_certs; then
    printf '    location / { return 301 https://$host$request_uri; }\n}\n'
    local h up extra name
    for h in web auth media; do
      case $h in
        web)   up=relay_web;   name=$DOMAIN;     extra='client_max_body_size 25m;' ;;
        auth)  up=relay_auth;  name=$AUTH_HOST;  extra='client_max_body_size 1m;
    proxy_buffer_size 128k;
    proxy_buffers 4 256k;
    proxy_busy_buffers_size 256k;
    # Admin console and master realm stay private (SSH tunnel to 127.0.0.1:'"$AUTH_PORT"').
    location ~ ^/(admin|realms/master)(/|$) { return 404; }' ;;
        media) up=relay_media; name=$MEDIA_HOST; extra='client_max_body_size 0;   # the signed upload policy enforces sizes
    proxy_request_buffering off;
    proxy_buffering off;' ;;
      esac
      cat <<EOF

server {
    listen 443 ssl;
${V6:+    listen [::]:443 ssl;}
    server_name $name;
    ssl_certificate     $LE_LIVE/fullchain.pem;
    ssl_certificate_key $LE_LIVE/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    $extra
EOF
      if [ $h = web ]; then
        cat <<EOF
    location /mcp {
        proxy_pass http://$up;
        $PROXY_HDRS
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
EOF
      fi
      cat <<EOF
    location / {
        proxy_pass http://$up;
        $PROXY_HDRS
        proxy_read_timeout 300s;
    }
}
EOF
    done
  else
    cat <<EOF
    # No certificate yet: only the ACME challenge is served. After certbot succeeds, re-run bootstrap.sh --apply.
    location / { default_type text/plain; return 503 "Relay: HTTPS is being set up\n"; }
}
EOF
  fi
}
render_caddy_site() {
  cat <<EOF
# Relay — generated by infra/oracle/bootstrap.sh. Only the three Relay hostnames; imported from the main
# Caddyfile by one line. Relay sets its own security headers; Caddy forwards X-Forwarded-* by default.
$DOMAIN {
	encode zstd gzip
	reverse_proxy /mcp* 127.0.0.1:$WEB_PORT {
		flush_interval -1
	}
	reverse_proxy 127.0.0.1:$WEB_PORT
}

$AUTH_HOST {
	@private path /admin /admin/* /realms/master /realms/master/*
	respond @private 404
	reverse_proxy 127.0.0.1:$AUTH_PORT
}

$MEDIA_HOST {
	reverse_proxy 127.0.0.1:$MEDIA_PORT
}
EOF
}
render_apache() {
  local h port name
  printf '# Relay — generated by infra/oracle/bootstrap.sh. Only the three Relay hostnames.\n'
  printf '# Needs: a2enmod proxy proxy_http headers ssl\n'
  for h in web auth media; do
    case $h in web) port=$WEB_PORT name=$DOMAIN ;; auth) port=$AUTH_PORT name=$AUTH_HOST ;; media) port=$MEDIA_PORT name=$MEDIA_HOST ;; esac
    cat <<EOF

<VirtualHost *:80>
    ServerName $name
    Alias /.well-known/acme-challenge/ $ACME_WEBROOT/.well-known/acme-challenge/
    <Directory $ACME_WEBROOT>
        Require all granted
    </Directory>
    RedirectMatch 301 ^/(?!\.well-known/acme-challenge/)(.*)\$ https://$name/\$1
</VirtualHost>
EOF
    if have_certs; then
      cat <<EOF
<VirtualHost *:443>
    ServerName $name
    SSLEngine on
    SSLCertificateFile $LE_LIVE/fullchain.pem
    SSLCertificateKeyFile $LE_LIVE/privkey.pem
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Port "443"
    ProxyPass / http://127.0.0.1:$port/ timeout=300
    ProxyPassReverse / http://127.0.0.1:$port/
EOF
      [ $h = auth ] && printf '    <LocationMatch "^/(admin|realms/master)(/|$)">\n        Require all denied\n    </LocationMatch>\n'
      [ $h = web ] && printf '    LimitRequestBody 26214400\n'
      printf '</VirtualHost>\n'
    fi
  done
}
traefik_rules() { # sets T_EP (entrypoint) T_CR (cert resolver) from a traefik command line / static file
  local src=$1
  T_EP=$(printf '%s\n' "$src" | grep -oE 'entrypoints\.[A-Za-z0-9_-]+\.address=:?443' | head -n 1 | cut -d. -f2)
  T_CR=$(printf '%s\n' "$src" | grep -oE 'certificatesresolvers\.[A-Za-z0-9_-]+\.' | head -n 1 | cut -d. -f2)
  T_EP=${T_EP:-websecure}; T_CR=${T_CR:-letsencrypt}
}
render_traefik_file() {
  cat <<EOF
# Relay — generated by infra/oracle/bootstrap.sh. Traefik file-provider config for the three Relay names.
# Check entryPoint "$T_EP" and certResolver "$T_CR" match your static configuration.
http:
  routers:
    relay-web:
      rule: "Host(\`$DOMAIN\`)"
      entryPoints: ["$T_EP"]
      service: relay-web
      tls: { certResolver: "$T_CR" }
    relay-auth:
      rule: "Host(\`$AUTH_HOST\`) && !PathPrefix(\`/admin\`) && !PathPrefix(\`/realms/master\`)"
      entryPoints: ["$T_EP"]
      service: relay-auth
      tls: { certResolver: "$T_CR" }
    relay-media:
      rule: "Host(\`$MEDIA_HOST\`)"
      entryPoints: ["$T_EP"]
      service: relay-media
      tls: { certResolver: "$T_CR" }
  services:
    relay-web:   { loadBalancer: { passHostHeader: true, servers: [ { url: "http://127.0.0.1:$WEB_PORT" } ] } }
    relay-auth:  { loadBalancer: { passHostHeader: true, servers: [ { url: "http://127.0.0.1:$AUTH_PORT" } ] } }
    relay-media: { loadBalancer: { passHostHeader: true, servers: [ { url: "http://127.0.0.1:$MEDIA_PORT" } ] } }
EOF
}
render_network_override() { # $1 external network, $2 "labels" for traefik labels
  local net=$1 svc port name rule
  printf '# Generated by infra/oracle/bootstrap.sh: Relay public containers join the proxy network "%s".\n' "$net"
  printf 'services:\n'
  for svc in web keycloak storage; do
    case $svc in web) port=3000 name=$DOMAIN ;; keycloak) port=8080 name=$AUTH_HOST ;; storage) port=8333 name=$MEDIA_HOST ;; esac
    printf '  %s:\n    networks:\n      default: {}\n      edge:\n        aliases: ["relay-%s"]\n' "$svc" "$svc"
    if [ "${2:-}" = labels ]; then
      rule="Host(\`$name\`)"
      [ $svc = keycloak ] && rule="$rule && !PathPrefix(\`/admin\`) && !PathPrefix(\`/realms/master\`)"
      cat <<EOF
    labels:
      traefik.enable: "true"
      traefik.docker.network: "$net"
      traefik.http.routers.relay-$svc.rule: "$rule"
      traefik.http.routers.relay-$svc.entrypoints: "$T_EP"
      traefik.http.routers.relay-$svc.tls.certresolver: "$T_CR"
      traefik.http.services.relay-$svc.loadbalancer.server.port: "$port"
EOF
    fi
  done
  printf 'networks:\n  edge:\n    external: true\n    name: "%s"\n' "$net"
}

# install_file TARGET CONTENT_FILE -> show diff, back up the old file, install (mode 0644). Returns 1 if unchanged.
install_file() {
  local target=$1 new=$2
  if [ -f "$target" ] && cmp -s "$target" "$new"; then ok "$target unchanged"; return 1; fi
  say "  diff for $target:"
  if [ -f "$target" ]; then diff -u "$target" "$new" | sed 's/^/    /' || true; else diff -u /dev/null "$new" | sed 's/^/    /' || true; fi
  if [ $APPLY -eq 0 ]; then plan "write $target (shown above)"; return 0; fi
  if [ $YES -eq 0 ] && [ -t 0 ]; then
    local a; read -r -p "  Apply this change to $target? [y/N] " a; [ "$a" = y ] || [ "$a" = Y ] || die "stopped at your request; nothing else changed"
  fi
  if [ -f "$target" ]; then install -d -m 0700 "$PROXY_BACKUP_DIR"; cp -p "$target" "$PROXY_BACKUP_DIR/$(echo "$target" | tr '/' '_')"; ok "backed up the previous $target to $PROXY_BACKUP_DIR"; fi
  install -m 0644 "$new" "$target"
  ok "wrote $target"
}
restore_file() { # TARGET -> put the backup back (or remove the new file) after a failed validation
  local b; b="$PROXY_BACKUP_DIR/$(echo "$1" | tr '/' '_')"
  if [ -f "$b" ]; then cp -p "$b" "$1"; else rm -f "$1"; fi
}
TMPD=$(mktemp -d); trap 'rm -rf "$TMPD"' EXIT
NEED_PROXY_RELOAD=""
CERTBOT_CMD="certbot certonly --webroot -w $ACME_WEBROOT --cert-name relay -d $DOMAIN -d $AUTH_HOST -d $MEDIA_HOST"

case "$PROXY_MODE" in
  bundled)
    plan "run the bundled Caddy container (compose profile caddy) on ${BIND_IP:-0.0.0.0}:80/443 for the Relay names only"
    say "  Firewall: allow inbound TCP 80 and 443 in the OCI security list / network security group of this VM."
    if have iptables && iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
      say "  This host also has iptables REJECT rules (Oracle images ship them). Docker-published ports bypass INPUT,"
      say "  but if other services need them: sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443 -m state --state NEW -j ACCEPT"
    fi
    ;;
  nginx)
    have nginx || [ -n "${RELAY_NGINX_DIR:-}" ] || die "nginx is listening but the nginx command is not on PATH; use --proxy manual"
    NGX_DUMP=$(nginx -T 2>/dev/null || true)
    if [ -d "$NGINX_DIR/sites-available" ] && printf '%s' "$NGX_DUMP" | grep -qE "include[[:space:]]+$NGINX_DIR/sites-enabled/"; then
      NGX_FILE="$NGINX_DIR/sites-available/relay.conf"; NGX_LINK="$NGINX_DIR/sites-enabled/relay.conf"
    elif [ -d "$NGINX_DIR/conf.d" ]; then NGX_FILE="$NGINX_DIR/conf.d/relay.conf"; NGX_LINK=""
    else die "cannot find sites-available/sites-enabled or conf.d under $NGINX_DIR; use --proxy manual"; fi
    # Never take over a hostname another site already serves.
    if printf '%s' "$NGX_DUMP" | awk -v f="# configuration file $NGX_FILE:" -v l="# configuration file ${NGX_LINK:-/nonexistent}:" '/^# configuration file /{skip=($0==f || $0==l)} !skip' \
       | grep -E "server_name[^;]*" | grep -qwE "$(printf '%s|%s|%s' "$DOMAIN" "$AUTH_HOST" "$MEDIA_HOST" | sed 's/\./\\./g')"; then
      die "another nginx site already uses one of the Relay hostnames; resolve that first (nothing changed)"
    fi
    have_certs && ok "certificate found in $LE_LIVE: full HTTPS config" || say "  No certificate in $LE_LIVE yet: HTTP-only block for the ACME challenge first."
    render_nginx > "$TMPD/relay.conf"
    if install_file "$NGX_FILE" "$TMPD/relay.conf"; then NEED_PROXY_RELOAD=nginx; fi
    if [ -n "$NGX_LINK" ] && [ ! -L "$NGX_LINK" ]; then plan "symlink $NGX_LINK -> $NGX_FILE"; [ $APPLY -eq 1 ] && ln -s "$NGX_FILE" "$NGX_LINK" && NEED_PROXY_RELOAD=nginx; fi
    [ $APPLY -eq 1 ] && install -d -m 0755 "$ACME_WEBROOT"
    if [ -n "$NEED_PROXY_RELOAD" ] && [ $APPLY -eq 1 ]; then
      if nginx -t >/dev/null 2>&1; then
        if systemctl reload nginx 2>/dev/null || nginx -s reload; then ok "nginx configuration valid; reloaded (graceful, other sites keep serving)"; else warn "reload nginx yourself: sudo systemctl reload nginx"; fi
      else
        nginx -t || true; restore_file "$NGX_FILE"; [ -n "$NGX_LINK" ] && [ -L "$NGX_LINK" ] && [ ! -f "$PROXY_BACKUP_DIR/$(echo "$NGX_FILE" | tr '/' '_')" ] && rm -f "$NGX_LINK"
        die "nginx -t failed with the Relay file; it was rolled back and nginx was NOT reloaded"
      fi
    fi
    if ! have_certs; then
      say "  HTTPS certificate (after the DNS records resolve to this VM):"
      say "    sudo $CERTBOT_CMD --deploy-hook 'systemctl reload nginx'"
      say "  then re-run: sudo infra/oracle/bootstrap.sh --apply   (switches the file to the full HTTPS config)"
      if [ -n "$CERTBOT_EMAIL" ] && [ $APPLY -eq 1 ]; then
        have certbot || die "certbot is not installed (sudo apt install certbot)"
        # shellcheck disable=SC2086
        $CERTBOT_CMD --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --deploy-hook 'systemctl reload nginx' \
          && { ok "certificate issued; switching to the HTTPS config"; render_nginx > "$TMPD/relay.conf"; YES=1; install_file "$NGX_FILE" "$TMPD/relay.conf" && nginx -t && systemctl reload nginx; }
      fi
    fi
    ;;
  caddy-host)
    CADDYFILE="$CADDY_DIR/Caddyfile"
    if [ -n "$P443" ] && [ -r "/proc/$P443/cmdline" ]; then
      cf=$(tr '\0' ' ' < "/proc/$P443/cmdline" | grep -oE -- '--config[= ][^ ]+' | head -n 1 | sed -E 's/--config[= ]//')
      [ -n "$cf" ] && CADDYFILE=$cf
    fi
    case "$CADDYFILE" in *.json) die "Caddy uses a JSON config ($CADDYFILE): add the Relay routes yourself (--proxy manual shows them)";; esac
    [ -f "$CADDYFILE" ] || die "Caddyfile not found at $CADDYFILE; use --proxy manual"
    if grep -qE "^[^#]*\b($(printf '%s|%s|%s' "$DOMAIN" "$AUTH_HOST" "$MEDIA_HOST" | sed 's/\./\\./g'))\b" "$CADDYFILE"; then
      die "the Caddyfile already mentions a Relay hostname; resolve that first (nothing changed)"
    fi
    SITE="$(dirname "$CADDYFILE")/relay.caddy"
    render_caddy_site > "$TMPD/relay.caddy"
    install_file "$SITE" "$TMPD/relay.caddy" && NEED_PROXY_RELOAD=caddy
    if ! grep -qxF "import $SITE" "$CADDYFILE"; then
      { cat "$CADDYFILE"; printf '\n# Relay (added by infra/oracle/bootstrap.sh)\nimport %s\n' "$SITE"; } > "$TMPD/Caddyfile"
      install_file "$CADDYFILE" "$TMPD/Caddyfile" && NEED_PROXY_RELOAD=caddy
    fi
    if [ -n "$NEED_PROXY_RELOAD" ] && [ $APPLY -eq 1 ]; then
      if caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
        systemctl reload caddy 2>/dev/null || caddy reload --config "$CADDYFILE" --adapter caddyfile
        ok "Caddy configuration valid; reloaded (certificates for the Relay names are issued automatically)"
      else
        caddy validate --config "$CADDYFILE" --adapter caddyfile || true
        restore_file "$CADDYFILE"; restore_file "$SITE"
        die "caddy validate failed; both files were rolled back and Caddy was NOT reloaded"
      fi
    fi
    ;;
  apache)
    [ -d "$APACHE_DIR/sites-available" ] || die "no $APACHE_DIR/sites-available (non-Debian Apache layout); use --proxy manual"
    render_apache > "$TMPD/relay.conf"
    install_file "$APACHE_DIR/sites-available/relay.conf" "$TMPD/relay.conf" || true
    [ $APPLY -eq 1 ] && install -d -m 0755 "$ACME_WEBROOT"
    say "  Enable it yourself (changes Apache's global module list, so it is not automatic):"
    say "    sudo a2enmod proxy proxy_http headers ssl && sudo a2ensite relay && sudo apachectl configtest && sudo systemctl reload apache2"
    have_certs || say "  Then the certificate: sudo $CERTBOT_CMD --deploy-hook 'systemctl reload apache2'   and re-run bootstrap.sh --apply"
    ;;
  traefik-file)
    src=""; [ -n "$P443" ] && [ -r "/proc/$P443/cmdline" ] && src=$(tr '\0' '\n' < "/proc/$P443/cmdline")
    for f in /etc/traefik/traefik.yml /etc/traefik/traefik.yaml /etc/traefik/traefik.toml; do [ -r "$f" ] && src="$src"$'\n'"$(tr -d ' ' < "$f")"; done
    traefik_rules "$src"
    dir=$(printf '%s\n' "$src" | grep -oE 'providers\.file\.directory=[^ ]+' | head -n 1 | cut -d= -f2)
    render_traefik_file > "$TMPD/relay.yml"
    if [ -n "$dir" ] && [ -d "$dir" ]; then install_file "$dir/relay.yml" "$TMPD/relay.yml" || true
    else
      [ $APPLY -eq 1 ] && install -m 0644 "$TMPD/relay.yml" "$RELAY_HOME/proxy/traefik-relay.yml"
      plan "save the Traefik dynamic file to $RELAY_HOME/proxy/traefik-relay.yml (no file-provider directory detected: copy it there yourself)"
      sed 's/^/    /' "$TMPD/relay.yml"
    fi
    ;;
  traefik-docker|container-proxy)
    cname=$TRAEFIK_CONTAINER; [ -n "$cname" ] || { c=$(container_on "$HTTPS_PORT"); cname=${c%% *}; }
    net=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$cname" 2>/dev/null | tr ' ' '\n' | grep -vxE 'bridge|host|' | head -n 1)
    [ -n "$net" ] || die "proxy container $cname is on the default bridge only; join it to a user network or use --proxy manual"
    say "  proxy container: $cname, network: $net"
    if [ "$PROXY_MODE" = traefik-docker ]; then
      targs=$(docker inspect -f '{{join .Args "\n"}}{{"\n"}}{{join .Config.Cmd "\n"}}' "$cname" 2>/dev/null || true)
      traefik_rules "$targs"
      if ! printf '%s\n' "$targs" | grep -qE -- '--providers\.docker(=true)?$'; then
        warn "Traefik's command line does not show --providers.docker: if its Docker provider is off (or set in a static file), labels are ignored. Check before relying on them."
      fi
      render_network_override "$net" labels > "$TMPD/override.yaml"
    else
      render_network_override "$net" > "$TMPD/override.yaml"
      say "  Add to that proxy's configuration (upstreams on network $net): https://$DOMAIN -> relay-web:3000,"
      say "  https://$AUTH_HOST -> relay-keycloak:8080 (block /admin and /realms/master), https://$MEDIA_HOST -> relay-storage:8333"
      say "  Preserve the Host header and send X-Forwarded-For/-Proto/-Host. Example for host nginx/Caddy: --proxy manual"
    fi
    install_file "$RELAY_HOME/compose.override.yaml" "$TMPD/override.yaml" || true
    ;;
  manual)
    say "  Nothing is changed. Point your proxy at (Host header preserved, X-Forwarded-For/-Proto/-Host set, TLS at the proxy):"
    say "    https://$DOMAIN     -> http://127.0.0.1:$WEB_PORT   (/mcp: no buffering, long read timeout)"
    say "    https://$AUTH_HOST  -> http://127.0.0.1:$AUTH_PORT   (return 404 for /admin and /realms/master)"
    say "    https://$MEDIA_HOST -> http://127.0.0.1:$MEDIA_PORT   (no body-size limit, no request buffering)"
    say "  Ready-made examples (nginx server blocks):"
    render_nginx | sed 's/^/    /'
    ;;
esac

# ---------------------------------------------------------------------------------------------------------------------
step "8. Images"
CUR_TAG=$(env_get "$INFRA_ENV" RELAY_IMAGE_TAG)
if [ -n "$IMAGES_TAR" ]; then
  [ -n "$TAG" ] || die "--images-tar needs --tag <tag> (printed by build.sh)"
  plan "docker load -i $IMAGES_TAR"
  [ $APPLY -eq 1 ] && docker load -i "$IMAGES_TAR"
elif [ -z "$TAG" ] && [ -n "$CUR_TAG" ]; then TAG=$CUR_TAG; ok "keeping current images $CUR_TAG (use update.sh to change version)"
elif [ -z "$TAG" ]; then
  plan "build relay-{web,worker,migrate} for $(uname -m) with infra/oracle/build.sh (5-20 min, uses CPU on this shared VM)"
  if [ $APPLY -eq 1 ]; then TAG=$(nice -n 10 "$KIT_DIR/build.sh" | tail -n 1); fi
fi
if [ $APPLY -eq 1 ]; then
  for t in web worker migrate; do docker image inspect "relay-$t:$TAG" >/dev/null 2>&1 || die "image relay-$t:$TAG not found"; done
  env_set "$INFRA_ENV" RELAY_IMAGE_TAG "$TAG"; ok "image tag $TAG"
  printf '%s %s bootstrap\n' "$STAMP" "$TAG" >> "$RELAY_HOME/state/deploy-history.log"
fi

# ---------------------------------------------------------------------------------------------------------------------
step "9. Start"
SMTP_SET=$(env_get "$APP_ENV_FILE" SMTP_URL)
if [ -z "$SMTP_SET" ] && [ $ALLOW_NO_SMTP -eq 1 ]; then
  plan "set SMTP_URL to the unresolvable placeholder smtp://email-not-configured.invalid:587 (email fails visibly until replaced)"
  if [ $APPLY -eq 1 ]; then
    printf '%s\n' '# Placeholder written by bootstrap.sh --allow-no-smtp: Relay starts, every email FAILS (email_send_failed). Replace it.' >> "$APP_ENV_FILE"
    env_set "$APP_ENV_FILE" SMTP_URL "smtp://email-not-configured.invalid:587"; SMTP_SET=placeholder
  fi
fi
if [ $SKIP_START -eq 1 ]; then say "  --skip-start: not starting anything"
elif [ $APPLY -eq 0 ]; then
  plan "start postgres, storage, keycloak; run the release job (roles, migrations, grants, media bucket)"
  plan "start web + worker$( [ "$PROXY_MODE" = bundled ] && echo ' + caddy') once SMTP_URL is set (or with --allow-no-smtp); wait for /api/ready"
  plan "install relay-backup.service + relay-backup.timer (nightly 03:17, encrypted)"
else
  compose up -d postgres storage keycloak
  wait_healthy postgres 120 || die "postgres did not become healthy (sudo infra/oracle/status.sh --logs postgres)"
  wait_healthy storage 120 || die "storage did not become healthy"
  ok "postgres and storage healthy"
  compose run --rm migrate || die "release job failed: nothing else was started (see output above)"
  ok "release job done (roles, migrations, grants, bucket)"
  # The admin console stays private: the master realm's URLs point at the loopback port (reached through an SSH
  # tunnel) instead of the public auth hostname, where the proxy answers 404 for /admin and /realms/master.
  ADMIN_URL="http://localhost:$AUTH_PORT"
  if [ "$(cat "$RELAY_HOME/state/kc-master-frontend" 2>/dev/null)" != "$ADMIN_URL" ]; then
    if wait_healthy keycloak 300 && compose exec -T -e ADMIN_URL="$ADMIN_URL" keycloak bash -c \
        '/opt/keycloak/bin/kcadm.sh config credentials --config /tmp/kcadm.cfg --server http://localhost:8080 --realm master --user bootstrap-admin --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" && /opt/keycloak/bin/kcadm.sh update realms/master --config /tmp/kcadm.cfg -s "attributes.frontendUrl=$ADMIN_URL"; rm -f /tmp/kcadm.cfg' >/dev/null 2>&1; then
      printf '%s\n' "$ADMIN_URL" > "$RELAY_HOME/state/kc-master-frontend"; ok "Keycloak admin console bound to $ADMIN_URL (SSH tunnel only)"
    else
      warn "could not set the master realm Frontend URL; in the admin console: master realm -> Realm settings -> Frontend URL = $ADMIN_URL"
    fi
  fi
  if [ -z "$SMTP_SET" ]; then
    warn "SMTP_URL is not set in $APP_ENV_FILE: Relay refuses to start in production without it."
    say "  Set it (sudo nano $APP_ENV_FILE), then: sudo infra/oracle/update.sh --restart"
    say "  Or start without email for now: sudo infra/oracle/bootstrap.sh --apply --allow-no-smtp"
  else
    compose up -d
    if wait_ready 240; then ok "web /api/ready = 200 on 127.0.0.1:$WEB_PORT"; else compose logs --tail 40 web >&2; die "web did not become ready (logs above)"; fi
    wait_healthy worker 120 && ok "worker healthy" || warn "worker not healthy yet: sudo infra/oracle/status.sh --logs worker"
  fi
  if have systemctl && [ -d /etc/systemd/system ] && [ -z "${RELAY_NO_SYSTEMD:-}" ]; then
    sed -e "s#@KIT_DIR@#$KIT_DIR#g" -e "s#@RELAY_HOME@#$RELAY_HOME#g" "$KIT_DIR/systemd/relay-backup.service" > "$TMPD/relay-backup.service"
    install -m 0644 "$TMPD/relay-backup.service" /etc/systemd/system/relay-backup.service
    install -m 0644 "$KIT_DIR/systemd/relay-backup.timer" /etc/systemd/system/relay-backup.timer
    systemctl daemon-reload && systemctl enable --now relay-backup.timer >/dev/null && ok "nightly backup timer enabled (systemctl list-timers relay-backup.timer)"
  else warn "systemd not available: schedule sudo $KIT_DIR/backup.sh nightly yourself (cron)"; fi
fi

# ---------------------------------------------------------------------------------------------------------------------
step "Next steps"
cat <<EOF
  1. DNS: A records for $DOMAIN, $AUTH_HOST and $MEDIA_HOST -> this VM's public IP (OCI security list: allow 80, 443).
  2. HTTPS: $( case $PROXY_MODE in bundled|caddy-host|traefik-*) echo "automatic once DNS resolves";; *) echo "certbot command shown in step 7, then re-run bootstrap.sh --apply";; esac ).
  3. Keycloak admin (never public): from your computer
       ssh -L $AUTH_PORT:127.0.0.1:$AUTH_PORT <you>@<vm>
     open http://localhost:$AUTH_PORT/admin/ and sign in as bootstrap-admin with the password from
       sudo grep '^KC_BOOTSTRAP_ADMIN_PASSWORD=' $INFRA_ENV
     Create your own admin user with MFA in the master realm, then delete bootstrap-admin. Realm "relay": add realm SMTP
     (Realm settings -> Email), then decide self-registration (Realm settings -> Login) per D26.
  4. Email: set SMTP_URL in $APP_ENV_FILE, then sudo infra/oracle/update.sh --restart
  5. First platform operator: create your account in the realm (Users -> Add user, or sign up when enabled), sign in to
     https://$DOMAIN once, then:
       sudo infra/oracle/status.sh --operator grant you@example.com
  6. Check: sudo infra/oracle/status.sh     Backups: sudo infra/oracle/backup.sh   (nightly via systemd timer)
  Runbook: docs/runbooks/oracle-vm-deployment.md
EOF
[ $APPLY -eq 1 ] || say $'\n'"${C_B}Dry run only: nothing was changed.${C_0} Re-run with --apply to do the steps above."
