# shellcheck shell=bash disable=SC2034  # variables are used by the scripts that source this file
# Shared helpers for the Relay VM kit (sourced by bootstrap.sh, update.sh, status.sh, backup.sh, restore.sh).
# Never prints secret values: env files are read key by key and only names are ever shown.

KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO_DIR=$(cd "$KIT_DIR/../.." && pwd)
RELAY_HOME=${RELAY_HOME:-/opt/relay}
RELAY_PROJECT=${RELAY_PROJECT:-relay}
INFRA_ENV="$RELAY_HOME/.env.infra"
APP_ENV_FILE="$RELAY_HOME/.env.production"
TOOLS_IMAGE=${RELAY_TOOLS_IMAGE:-relay-tools:1}
DEFAULT_DOMAIN=relay.vitalos.co.uk

if [ -t 1 ]; then C_B=$'\e[1m' C_G=$'\e[32m' C_Y=$'\e[33m' C_R=$'\e[31m' C_0=$'\e[0m'; else C_B='' C_G='' C_Y='' C_R='' C_0=''; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s== %s%s\n' "$C_B" "$*" "$C_0"; }
ok()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# env_get FILE KEY -> value of the last KEY=... line (no sourcing, no expansion). Empty if missing.
env_get() {
  [ -r "$1" ] || return 0
  local line
  line=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n 1) || true
  printf '%s' "${line#*=}"
}

# env_set FILE KEY VALUE -> replace or append KEY=VALUE, keeping mode 600. Value must not contain newlines.
env_set() {
  local f=$1 k=$2 v=$3 tmp
  tmp=$(mktemp "$f.XXXXXX")
  chmod 600 "$tmp"
  if grep -qE "^$k=" "$f" 2>/dev/null; then
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$f" > "$tmp"
  else
    { cat "$f" 2>/dev/null; printf '%s=%s\n' "$k" "$v"; } > "$tmp"
  fi
  mv "$tmp" "$f"
}

# Compose wrapper: project "relay", infra env file for interpolation, optional override and bundled-proxy profile.
compose() {
  local args=(-p "$RELAY_PROJECT" --env-file "$INFRA_ENV" -f "$KIT_DIR/compose.prod.yaml")
  [ -f "$RELAY_HOME/compose.override.yaml" ] && args+=(-f "$RELAY_HOME/compose.override.yaml")
  [ "$(env_get "$INFRA_ENV" RELAY_PROXY_MODE)" = bundled ] && args+=(--profile caddy)
  docker compose "${args[@]}" "$@"
}

web_port()  { local p; p=$(env_get "$INFRA_ENV" RELAY_WEB_PORT); printf '%s' "${p:-3300}"; }
auth_port() { local p; p=$(env_get "$INFRA_ENV" RELAY_AUTH_PORT); printf '%s' "${p:-3380}"; }

# http_code URL -> HTTP status (000 when unreachable). Uses curl, else wget.
http_code() {
  if have curl; then curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || true
  else wget -q -S -O /dev/null -T 5 "$1" 2>&1 | awk '/HTTP\//{c=$2} END{print c+0}'; fi
}

# wait_ready SECONDS -> waits for web /api/ready = 200 on the loopback port.
wait_ready() {
  local deadline=$((SECONDS + ${1:-180})) code
  while [ $SECONDS -lt $deadline ]; do
    code=$(http_code "http://127.0.0.1:$(web_port)/api/ready")
    [ "$code" = 200 ] && return 0
    sleep 3
  done
  return 1
}

# wait_healthy SERVICE SECONDS -> waits for the container health status "healthy".
wait_healthy() {
  local svc=$1 deadline=$((SECONDS + ${2:-180})) id st
  while [ $SECONDS -lt $deadline ]; do
    id=$(compose ps -q "$svc" 2>/dev/null | head -n 1)
    if [ -n "$id" ]; then
      st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)
      [ "$st" = healthy ] && return 0
    fi
    sleep 3
  done
  return 1
}

ensure_tools_image() {
  docker image inspect "$TOOLS_IMAGE" >/dev/null 2>&1 && return 0
  say "  building $TOOLS_IMAGE (alpine + age + tar; used for encrypted backups)"
  local a=(-t "$TOOLS_IMAGE" -f "$KIT_DIR/tools.Dockerfile")
  [ -n "${RELAY_ALPINE_IMAGE:-}" ] && a+=(--build-arg "ALPINE_IMAGE=$RELAY_ALPINE_IMAGE")
  [ -n "${HTTPS_PROXY:-}" ] && a+=(--network host --build-arg "HTTPS_PROXY=$HTTPS_PROXY")
  # shellcheck disable=SC2054 # the comma belongs to the secret spec
  [ -f /root/.ccr/ca-bundle.crt ] && a+=(--secret id=extra_ca,src=/root/.ccr/ca-bundle.crt)
  docker buildx build -q --load "${a[@]}" "$KIT_DIR" >/dev/null
}

# tools CMD... -> run inside the tools container (stdin/stdout passed through, no network).
tools() { docker run --rm -i --network none "$TOOLS_IMAGE" "$@"; }

require_root() { [ "$(id -u)" = 0 ] || die "run this with sudo (it reads root-only files under $RELAY_HOME)"; }
require_installed() { [ -r "$INFRA_ENV" ] || die "$INFRA_ENV not found: run bootstrap.sh --apply first"; }
