#!/usr/bin/env bash
# Kit self-test on a dev/sandbox machine (NOT on the VM): runs the real bootstrap/backup/restore/update/status scripts
# against a throwaway project "relay-dptest" on other ports, with the bundled Caddy on :18080/:8443 using its local CA,
# signs in through production-mode Keycloak with Playwright, then tears everything down (volumes too).
#
#   infra/oracle/test/local-test.sh <image tag> [--keep]      # images relay-{web,worker,migrate}:<tag> must exist
#
# Env: RELAY_TEST_MIRROR=mirror.gcr.io (pull Docker Hub images through a mirror), RELAY_TEST_DIR (work dir).
set -euo pipefail
TAG=${1:?image tag}; KEEP=${2:-}
KIT=$(cd "$(dirname "$0")/.." && pwd); REPO=$(cd "$KIT/../.." && pwd)
WORK=${RELAY_TEST_DIR:-$(mktemp -d)}
export RELAY_HOME="$WORK/home" RELAY_PROJECT=relay-dptest RELAY_URL_PORT=:8443 RELAY_NO_SYSTEMD=1
export RELAY_BACKUP_MIN_FREE_MB=${RELAY_BACKUP_MIN_FREE_MB:-500}   # sandbox disks are small
export RELAY_DETECT_HTTP_PORT=18080 RELAY_DETECT_HTTPS_PORT=8443 RELAY_WEB_PORT=13300 RELAY_AUTH_PORT=13380 RELAY_MEDIA_PORT=13333
DOMAIN=relay-dp.test APP="https://$DOMAIN:8443"
M=${RELAY_TEST_MIRROR:-}
[ -n "$M" ] && export RELAY_ALPINE_IMAGE="$M/library/alpine:3.22" RELAY_JDK_IMAGE="$M/library/eclipse-temurin:21-jdk"
# shellcheck source=../lib/common.sh
source "$KIT/lib/common.sh"
PASS=0 FAIL=0
check() { local name=$1; shift; if "$@"; then PASS=$((PASS+1)); echo "PASS $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi; }
cr() { curl -sk --noproxy "*" --resolve "$DOMAIN:8443:127.0.0.1" --resolve "auth.$DOMAIN:8443:127.0.0.1" --resolve "media.$DOMAIN:8443:127.0.0.1" "$@"; }
teardown() {
  [ "$KEEP" = --keep ] && { echo "kept: RELAY_HOME=$RELAY_HOME project=$RELAY_PROJECT"; return; }
  docker rm -f "${RELAY_PROJECT}-mail" >/dev/null 2>&1 || true
  compose --profile caddy --profile jobs down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume ls -q | grep "^${RELAY_PROJECT}_" | xargs -r docker volume rm >/dev/null 2>&1 || true
  docker image rm "relay-web:$TAG-b" "relay-worker:$TAG-b" "relay-migrate:$TAG-b" "relay-web:$TAG-broken" "relay-worker:$TAG-broken" "relay-migrate:$TAG-broken" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  echo "torn down (containers, network, volumes, test dir)"
}
trap teardown EXIT
mkdir -p "$RELAY_HOME" "$WORK/shots"; chmod 700 "$RELAY_HOME"

# Test-only settings the production bootstrap leaves alone: mirrors, Caddy on other ports with a local CA.
{
  [ -n "$M" ] && printf 'RELAY_POSTGRES_IMAGE=%s\nRELAY_SEAWEEDFS_IMAGE=%s\nRELAY_CADDY_IMAGE=%s\n' \
    "$M/library/postgres:16-alpine" "$M/chrislusf/seaweedfs:3.80" "$M/library/caddy:2.10-alpine"
  printf 'RELAY_CADDY_HTTP_PORT=18080\nRELAY_CADDY_HTTPS_PORT=8443\nRELAY_CADDYFILE=%s/Caddyfile.test\n' "$RELAY_HOME"
} > "$RELAY_HOME/.env.infra"; chmod 600 "$RELAY_HOME/.env.infra"
{ printf '{\n\tlocal_certs\n}\n\n'; cat "$KIT/proxy/Caddyfile.bundled"; } > "$RELAY_HOME/Caddyfile.test"
# Trust Caddy's local CA inside web/worker (production uses public certificates instead). The file is filled in once
# Caddy has created its CA (same inode, so the bind mount sees it).
: > "$RELAY_HOME/test-ca.crt"; chmod 644 "$RELAY_HOME/test-ca.crt"
cat > "$RELAY_HOME/compose.override.yaml" <<EOF
services:
  web:
    environment: { NODE_EXTRA_CA_CERTS: /test-ca.crt }
    volumes: ["$RELAY_HOME/test-ca.crt:/test-ca.crt:ro"]
  worker:
    environment: { NODE_EXTRA_CA_CERTS: /test-ca.crt }
    volumes: ["$RELAY_HOME/test-ca.crt:/test-ca.crt:ro"]
EOF

echo "== bootstrap dry run"
"$KIT/bootstrap.sh" --domain "$DOMAIN" > "$WORK/dry.log" 2>&1 || { cat "$WORK/dry.log"; exit 1; }
check "dry run detects free ports -> bundled Caddy" grep -q '80/443 are free' "$WORK/dry.log"
check "dry run changes nothing" test ! -f "$RELAY_HOME/.env.production"

echo "== bootstrap --apply"
"$KIT/bootstrap.sh" --apply --yes --domain "$DOMAIN" --tag "$TAG" --allow-no-smtp \
  --backup-identity-out "$WORK/backup-identity.txt" 2>&1 | tee "$WORK/apply.log" | grep -E '✓|!|ERROR|==' || true
[ -n "$(env_get "$INFRA_ENV" RELAY_IMAGE_TAG)" ] || { echo "bootstrap --apply failed; stopping"; exit 1; }
check "env files are 0600" test "$(stat -c %a "$RELAY_HOME/.env.infra")$(stat -c %a "$RELAY_HOME/.env.production")" = 600600
check "no secret value printed by bootstrap" bash -c "! grep -qF \"\$(grep '^SESSION_SECRET=' '$RELAY_HOME/.env.production' | cut -d= -f2)\" '$WORK/apply.log'"
check "status token generated (64 hex), not printed" bash -c "T=\$(grep '^RELAY_PLATFORM_STATUS_TOKEN=' '$RELAY_HOME/.env.production' | cut -d= -f2); [[ \$T =~ ^[0-9a-f]{64}\$ ]] && ! grep -qF \"\$T\" '$WORK/apply.log'"
# The web/worker trust the Caddy CA only once Caddy has created it.
for _ in $(seq 30); do compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$RELAY_HOME/test-ca.crt" 2>/dev/null && [ -s "$RELAY_HOME/test-ca.crt" ] && break; sleep 2; done
compose restart web worker >/dev/null; wait_ready 180
check "/api/ready 200 on 127.0.0.1" test "$(http_code "http://127.0.0.1:13300/api/ready")" = 200
check "only 127.0.0.1 bindings (except caddy)" bash -c "! docker ps --filter label=com.docker.compose.project=$RELAY_PROJECT --format '{{.Names}} {{.Ports}}' | grep -v caddy | grep -q '0.0.0.0'"
check "postgres not published" bash -c "! docker ps --filter label=com.docker.compose.project=$RELAY_PROJECT --format '{{.Names}} {{.Ports}}' | grep postgres | grep -q -- '->'"
check "via Caddy TLS: /api/ready" test "$(cr -o /dev/null -w '%{http_code}' "$APP/api/ready")" = 200
check "status endpoint: 401 without the token" test "$(cr -o /dev/null -w '%{http_code}' "$APP/api/platform/v1/status")" = 401
check "status endpoint: 200 with the token (header from stdin)" test "$(printf 'Authorization: Bearer %s\n' "$(env_get "$RELAY_HOME/.env.production" RELAY_PLATFORM_STATUS_TOKEN)" | cr -H @- -o /dev/null -w '%{http_code}' "$APP/api/platform/v1/status")" = 200
check "worker holds no status token" test -z "$(compose exec -T worker printenv RELAY_PLATFORM_STATUS_TOKEN 2>/dev/null)"
H=$(cr -D - -o /dev/null "$APP/login" || true)
check "CSP with nonce" grep -qi "content-security-policy:.*nonce-" <<<"$H"
check "HSTS" grep -qi "strict-transport-security" <<<"$H"
check "X-Frame-Options DENY" grep -qi "x-frame-options: DENY" <<<"$H"
check "image has /help" test "$(cr -o /dev/null -w '%{http_code}' "$APP/help")" = 200
check "image has public/ (marketing asset)" test "$(cr -o /dev/null -w '%{http_code}' "$APP/marketing/overview-light.webp")" = 200
check "OIDC discovery issuer" bash -c "curl -sk --noproxy \"*\" --resolve auth.$DOMAIN:8443:127.0.0.1 https://auth.$DOMAIN:8443/realms/relay/.well-known/openid-configuration | grep -q '\"issuer\":\"https://auth.$DOMAIN:8443/realms/relay\"'"
check "admin console not public" test "$(cr -o /dev/null -w '%{http_code}' "https://auth.$DOMAIN:8443/admin/")" = 404
check "master realm not public" test "$(cr -o /dev/null -w '%{http_code}' "https://auth.$DOMAIN:8443/realms/master/.well-known/openid-configuration")" = 404
check "admin console on loopback" test "$(http_code http://127.0.0.1:13380/admin/master/console/)" = 200
check "media host answers (S3, anonymous denied)" test "$(cr -o /dev/null -w '%{http_code}' "https://media.$DOMAIN:8443/relay-media/x")" = 403
q() { compose exec -T postgres psql -U relay_admin -d "$1" -Atc "$2"; }
check "realm has no people (service account only)" test "$(q keycloak "SELECT count(*) FROM user_entity u JOIN realm r ON r.id=u.realm_id WHERE r.name='relay' AND u.service_account_client_link IS NULL")" = 0
check "realm self-registration off" test "$(q keycloak "SELECT registration_allowed FROM realm WHERE name='relay'")" = f
check "realm ssl required = all" test "$(q keycloak "SELECT ssl_required FROM realm WHERE name='relay'")" = ALL
check "realm client secret = generated value" test "$(q keycloak "SELECT secret FROM client WHERE client_id='relay-web'")" = "$(env_get "$INFRA_ENV" RELAY_OIDC_CLIENT_SECRET)"
check "realm redirect URI from the domain" test "$(q keycloak "SELECT value FROM redirect_uris ru JOIN client c ON c.id=ru.client_id WHERE c.client_id='relay-web'")" = "$APP/api/auth/callback"
check "worker connects as socialite_worker" bash -c "grep -qx socialite_worker <<<'$(q relay "SELECT DISTINCT usename FROM pg_stat_activity WHERE datname='relay'")'"
check "web connects as socialite_app" bash -c "grep -qx socialite_app <<<'$(q relay "SELECT DISTINCT usename FROM pg_stat_activity WHERE datname='relay'")'"
check "app roles least-privilege" test "$(q relay "SELECT bool_or(rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls) FROM pg_roles WHERE rolname LIKE 'socialite_%'")" = f

echo "== bootstrap re-run on the running stack (idempotent)"
SUM1=$(grep -E '^(POSTGRES|RELAY_DB|KEYCLOAK|KC_|RELAY_OIDC|RELAY_S3)' "$RELAY_HOME/.env.infra" | sha256sum; sha256sum < "$RELAY_HOME/.env.production")
"$KIT/bootstrap.sh" --apply --yes --domain "$DOMAIN" > "$WORK/rerun.log" 2>&1 || cat "$WORK/rerun.log"
SUM2=$(grep -E '^(POSTGRES|RELAY_DB|KEYCLOAK|KC_|RELAY_OIDC|RELAY_S3)' "$RELAY_HOME/.env.infra" | sha256sum; sha256sum < "$RELAY_HOME/.env.production")
check "re-run keeps every secret" test "$SUM1" = "$SUM2"
check "re-run keeps the bundled proxy mode" grep -q 'run the bundled Caddy container' "$WORK/rerun.log"
check "re-run ends ready" test "$(http_code "http://127.0.0.1:13300/api/ready")" = 200
echo "== sign in through production-mode Keycloak (passwordless, D34: email code read from a throwaway Mailpit)"
docker rm -f "${RELAY_PROJECT}-mail" >/dev/null 2>&1 || true
docker run -d --name "${RELAY_PROJECT}-mail" --network "${RELAY_PROJECT}_default" -p 127.0.0.1:18025:8025 "${M:+$M/}axllent/mailpit:latest" >/dev/null
compose exec -T keycloak bash -c '
  /opt/keycloak/bin/kcadm.sh config credentials --config /tmp/kc.cfg --server http://localhost:8080 --realm master --user bootstrap-admin --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null &&
  /opt/keycloak/bin/kcadm.sh update realms/relay --config /tmp/kc.cfg -s smtpServer.host='"${RELAY_PROJECT}-mail"' -s smtpServer.port=1025 -s smtpServer.from=no-reply@relay-dp.test >/dev/null &&
  /opt/keycloak/bin/kcadm.sh create users --config /tmp/kc.cfg -r relay -s username=dp-test@relay-dp.test -s email=dp-test@relay-dp.test -s emailVerified=true -s enabled=true -s firstName=DP -s lastName=Test >/dev/null' && echo "test user created (no password)"
"$KIT/admin.sh" passwordless </dev/null > "$WORK/passwordless.log" 2>&1 || cat "$WORK/passwordless.log"
check "admin.sh passwordless confirms the realm (idempotent on a fresh install)" grep -q 'sign-in is passwordless' "$WORK/passwordless.log"
(cd "$REPO" && node "$KIT/test/signin.mjs" "$APP" dp-test@relay-dp.test "http://127.0.0.1:18025" "$WORK/shots") | tee "$WORK/signin.log" || true
check "signed in (session 200)" grep -q '"session_status":200' "$WORK/signin.log"
cp "$WORK"/shots/*.png "${RELAY_TEST_SHOTS:-$WORK}/" 2>/dev/null || true
APW="$WORK/kc-admin-password"; ( umask 077; env_get "$INFRA_ENV" KC_BOOTSTRAP_ADMIN_PASSWORD > "$APW" )
(cd "$REPO" && node "$KIT/test/admin-login.mjs" "http://localhost:13380" "$APW") | tee "$WORK/admin.log" || true
check "Keycloak admin console works on the loopback port (SSH-tunnel path)" grep -q '"admin_console":"ok"' "$WORK/admin.log"
"$KIT/status.sh" --operator grant dp-test@relay-dp.test > "$WORK/op.log" 2>&1 || true
check "platform operator granted via status.sh --operator" grep -q 'platform operator granted' "$WORK/op.log"

MEDIA_MB=$(du -sm "$(docker volume inspect -f '{{.Mountpoint}}' "${RELAY_PROJECT}_media")" | cut -f1)
check "media volume small on a fresh install (${MEDIA_MB} MB)" test "$MEDIA_MB" -lt 700
echo "== backup + restore drill"
"$KIT/backup.sh" > "$WORK/backup.log" 2>&1 || cat "$WORK/backup.log"
B=$(find "$RELAY_HOME/backups" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort | tail -n 1)
check "backup made with relay/keycloak/globals/config/media/realm" test "$(find "$B" -name '*.age' | wc -l)" = 6
check "backup files are encrypted (age header)" bash -c "head -c 21 '$B/relay.dump.age' | grep -q 'age-encryption.org/v1'"
"$KIT/restore.sh" --drill "$B" --identity "$WORK/backup-identity.txt" > "$WORK/drill.log" 2>&1 || true
check "restore drill complete" grep -q 'drill complete' "$WORK/drill.log"
check "drill forced dispatch off" grep -q 'dispatch forced OFF' "$WORK/drill.log"
check "drill left no container" bash -c "! docker ps -a --format '{{.Names}}' | grep -q relay-restore-drill"

echo "== update (success) and automatic rollback (broken web image)"
for t in web worker migrate; do docker tag "relay-$t:$TAG" "relay-$t:$TAG-b"; done
"$KIT/update.sh" --tag "$TAG-b" > "$WORK/update.log" 2>&1 || cat "$WORK/update.log"
check "update to $TAG-b live (with pre-release backup)" grep -q "is live" "$WORK/update.log"
# A web image that exits at once: update.sh must roll back to the previous tag by itself.
for t in worker migrate; do docker tag "relay-$t:$TAG" "relay-$t:$TAG-broken"; done
printf 'FROM relay-web:%s\nCMD ["node","-e","process.exit(1)"]\n' "$TAG" \
  | docker build -q --platform "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "relay-web:$TAG")" -t "relay-web:$TAG-broken" - >/dev/null
"$KIT/update.sh" --tag "$TAG-broken" --skip-backup > "$WORK/rollback.log" 2>&1 || true
check "broken release rolled back automatically" grep -q "rolled back to $TAG-b (healthy)" "$WORK/rollback.log"
check "tag back to $TAG-b" test "$(env_get "$INFRA_ENV" RELAY_IMAGE_TAG)" = "$TAG-b"
check "ready after rollback" test "$(http_code "http://127.0.0.1:13300/api/ready")" = 200
"$KIT/status.sh" > "$WORK/status.log" 2>&1 || true
check "status.sh reports ready" grep -q 'web /api/ready 200' "$WORK/status.log"
cp "$WORK"/*.log "${RELAY_TEST_LOGS:-$WORK}/" 2>/dev/null || true

echo "== result: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
