#!/usr/bin/env bash
# Relay — Keycloak admin helpers on the VM.
#
#   sudo infra/oracle/admin.sh replace-bootstrap
#   sudo infra/oracle/admin.sh passwordless           # switch the live realm to passwordless sign-in (D34)
#   sudo infra/oracle/admin.sh passwordless --undo    # emergency: back to the previous (password) sign-in flow
#   sudo infra/oracle/admin.sh google-signin          # add your Google OAuth client and switch "Continue with Google" on
#
# passwordless: email link + 6-digit code sign-in, Relay login/email theme, no password anywhere (sign-in, reset, account
# console), Google present but off until configured, two-step kept for staff and sensitive actions. Refuses to switch while
# the realm has no SMTP server (sign-in emails need it). Idempotent; the previous flow is kept for --undo.
# Needs the new sign-in server image first (update.sh builds it). Admin sign-in: the temporary bootstrap-admin when it still
# exists, otherwise you are asked for your Keycloak admin username, password (hidden) and two-step code. Secrets go to the
# helper on stdin only (never argv, files or the screen); the helper runs in the Relay web image next to Keycloak.
#
# Replaces the temporary `bootstrap-admin` (master realm) with your own admin in one go:
#   1. asks for a username, email and password (typed hidden; never printed, never written to a file or argv),
#   2. creates that user in the master realm with the `admin` role,
#   3. proves the new account can log in (before anything is deleted),
#   4. deletes bootstrap-admin using the NEW account's session,
#   5. requires two-step sign-in (Configure OTP) on the new account: you scan the QR code at your first console login.
# Safe to re-run: if bootstrap-admin is already gone it says so and changes nothing.
set -euo pipefail
SELF=$0
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

OLD_ADMIN=${RELAY_KC_OLD_ADMIN:-bootstrap-admin}
# Run a script inside the Keycloak container (stdin passed through). Overridable for testing against another container.
kc_exec() {
  if [ -n "${RELAY_KC_EXEC_CONTAINER:-}" ]; then docker exec -i "$RELAY_KC_EXEC_CONTAINER" bash -c "$1"
  else compose exec -T keycloak bash -c "$1"; fi
}

cmd=${1:-}
case "$cmd" in
  replace-bootstrap|passwordless|google-signin) ;;
  -h|--help|"") awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$SELF"; exit 0 ;;
  *) die "unknown command: $cmd (see --help)" ;;
esac

[ "$(id -u)" -eq 0 ] || [ -n "${RELAY_KC_EXEC_CONTAINER:-}" ] || die "run with sudo"

# ------------------------------------------------------------------ D34: passwordless sign-in / Google
# Run infra/oracle/keycloak/realm-admin.mjs in the Relay web image, sharing the Keycloak container's network namespace
# (so it talks to http://localhost:8080 exactly like kcadm inside the container). Secrets: stdin only.
realm_admin() {
  local kc image auth
  if [ -n "${RELAY_KC_EXEC_CONTAINER:-}" ]; then kc=$RELAY_KC_EXEC_CONTAINER; image=${RELAY_NODE_IMAGE:-node:22-bookworm-slim}
  else
    kc=$(compose ps -q keycloak 2>/dev/null | head -n 1)
    image="relay-web:$(env_get "$INFRA_ENV" RELAY_IMAGE_TAG)"
  fi
  [ -n "$kc" ] || die "the keycloak container is not running (sudo infra/oracle/status.sh)"
  docker image inspect "$image" >/dev/null 2>&1 || die "image $image not found (run update.sh first)"
  auth=${RELAY_KC_PUBLIC_URL:-$(env_get "$INFRA_ENV" RELAY_AUTH_URL 2>/dev/null || true)}
  docker run --rm -i --network "container:$kc" --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$KIT_DIR/keycloak/realm-admin.mjs:/kit/realm-admin.mjs:ro" --entrypoint node "$image" \
    /kit/realm-admin.mjs "$1" --kc-url http://localhost:8080 --realm "${RELAY_KC_REALM:-relay}" --public-url "$auth"
}

# Admin credentials -> ADMIN_USER / ADMIN_PW / ADMIN_OTP (never printed). bootstrap-admin first, else ask.
admin_creds() {
  ADMIN_OTP="" USED_BOOTSTRAP=0
  if [ "${1:-}" != ask ] && [ "$(kc_exec "/opt/keycloak/bin/kcadm.sh config credentials --config /tmp/kcadm-p.cfg --server http://localhost:8080 --realm master --user '$OLD_ADMIN' --password \"\$KC_BOOTSTRAP_ADMIN_PASSWORD\" >/dev/null 2>&1 && echo yes || echo no; rm -f /tmp/kcadm-p.cfg" </dev/null)" = yes ]; then
    ADMIN_USER=$OLD_ADMIN
    # shellcheck disable=SC2016 # expanded inside the container, on purpose
    ADMIN_PW=$(kc_exec 'printf %s "$KC_BOOTSTRAP_ADMIN_PASSWORD"' </dev/null)
    USED_BOOTSTRAP=1
    say "  signing in to Keycloak as $OLD_ADMIN (temporary admin still present)"
    return
  fi
  read -r -p "  Keycloak admin username (master realm): " ADMIN_USER || die "no input"
  read -r -s -p "  Password (hidden): " ADMIN_PW || die "no input"; echo
  read -r -p "  Two-step code from your authenticator app (press Enter if none): " ADMIN_OTP || true
}

# Print the helper's OK/WARN lines; turn ERR lines into guidance. $1 = output, $2 = exit code.
report() {
  local line code
  while IFS= read -r line; do
    case "$line" in
      OK\ *) ok "${line#OK }" ;;
      WARN\ *) warn "${line#WARN }" ;;
      ERR\ *) code=${line#ERR }; code=${code%% *}
        case "$code" in
          NO_SMTP) warn "${line#ERR NO_SMTP }"
            say "  Nothing was changed. Set the sign-in email server first:"
            say "    1. SSH tunnel: ssh -L $(auth_port):127.0.0.1:$(auth_port) <you>@<this VM>, then open http://localhost:$(auth_port)/admin/"
            say "    2. relay realm -> Realm settings -> Email: host, port, from address, login -> Save -> Test connection"
            say "    3. run this command again" ;;
          NO_PROVIDER|NO_THEME) warn "${line#ERR "$code" }"
            say "  Nothing was changed. Run sudo infra/oracle/update.sh first (it builds the new sign-in server image)." ;;
          AUTH) warn "Keycloak admin sign-in failed: ${line#ERR AUTH }" ;;
          *) warn "${line#ERR }" ;;
        esac ;;
      *) [ -n "$line" ] && say "  $line" ;;
    esac
  done <<<"$1"
  return "$2"
}

run_realm_admin() { # $1 = helper command, then extra stdin lines (e.g. Google client) on fd 3
  local out rc=0
  out=$( { printf '%s\n%s\n%s\n' "$ADMIN_USER" "$ADMIN_PW" "$ADMIN_OTP"; cat <&3; } | realm_admin "$1" 2>&1) || rc=$?
  if [ $rc -eq 3 ] && [ "$USED_BOOTSTRAP" = 1 ]; then return 3; fi
  report "$out" "$rc"
}

if [ "$cmd" = passwordless ] || [ "$cmd" = google-signin ]; then
  helper=$cmd
  [ "$cmd" = passwordless ] && [ "${2:-}" = --undo ] && helper=passwordless-undo
  case "$helper" in
    passwordless) step "Passwordless sign-in (D34): email link + code, Google ready, no passwords" ;;
    passwordless-undo) step "Undo passwordless sign-in: back to the previous sign-in flow" ;;
    google-signin) step "Continue with Google"
      auth=${RELAY_KC_PUBLIC_URL:-$(env_get "$INFRA_ENV" RELAY_AUTH_URL 2>/dev/null || true)}
      say "  In Google Cloud console (APIs & Services -> Credentials -> Create credentials -> OAuth client ID, type 'Web application'):"
      say "    Authorised redirect URI:  ${auth:-https://<your sign-in address>}/realms/${RELAY_KC_REALM:-relay}/broker/google/endpoint"
      say "  (OAuth consent screen: External, app name Relay, scopes openid/email/profile. Google charges nothing for this.)"
      read -r -p "  Google OAuth client ID: " G_ID || die "no input"
      read -r -s -p "  Google OAuth client secret (hidden): " G_SECRET || die "no input"; echo ;;
  esac
  admin_creds
  extra=""
  [ "$helper" = google-signin ] && extra=$(printf '%s\n%s\n' "$G_ID" "$G_SECRET")
  rc=0; run_realm_admin "$helper" 3<<<"$extra" || rc=$?
  if [ $rc -eq 3 ] && [ "$USED_BOOTSTRAP" = 1 ]; then
    warn "$OLD_ADMIN was not accepted; sign in with your own admin"
    admin_creds ask
    rc=0; run_realm_admin "$helper" 3<<<"$extra" || rc=$?
  fi
  unset ADMIN_PW G_SECRET extra
  [ $rc -eq 0 ] || die "stopped (see above)"
  case "$helper" in
    passwordless)
      say ""
      say "Try it: open your Relay address in a private window -> Log in -> enter your email -> use the link or the 6-digit code."
      say "If sign-in emails do not arrive, switch back with: sudo infra/oracle/admin.sh passwordless --undo" ;;
    google-signin) say ""; say "Try it: Log in -> Continue with Google. Existing accounts link only when Google has verified the same email." ;;
  esac
  exit 0
fi

step "Replace $OLD_ADMIN with your own Keycloak admin"
# Is the temporary admin still there? (authenticates with the bootstrap password from the container's environment)
# </dev/null: docker exec -i must not swallow the answers typed for the prompts below.
exists=$(kc_exec "/opt/keycloak/bin/kcadm.sh config credentials --config /tmp/kcadm-old.cfg --server http://localhost:8080 --realm master --user '$OLD_ADMIN' --password \"\$KC_BOOTSTRAP_ADMIN_PASSWORD\" >/dev/null 2>&1 && echo yes || echo no; rm -f /tmp/kcadm-old.cfg" </dev/null)
if [ "$exists" != yes ]; then
  ok "$OLD_ADMIN can't sign in any more (already removed or its password changed) — nothing to do"
  exit 0
fi

read -r -p "  New admin username (not your Relay login, e.g. yourname-admin): " NEW_USER || die "no input"
[[ "$NEW_USER" =~ ^[a-z0-9][a-z0-9._-]{2,40}$ ]] || die "username: 3-41 characters, lowercase letters, digits, . _ -"
[ "$NEW_USER" != "$OLD_ADMIN" ] || die "choose a different username"
read -r -p "  Email for this admin: " NEW_EMAIL || die "no input"
[[ "$NEW_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "that doesn't look like an email address"
read -r -s -p "  Password (min 12 characters, hidden): " PW1 || die "no input"; echo
read -r -s -p "  Same password again: " PW2 || die "no input"; echo
[ "$PW1" = "$PW2" ] || die "passwords don't match"
[ "${#PW1}" -ge 12 ] || die "password too short (min 12)"

# Everything below runs inside the container; the new password arrives on stdin (first line) only.
script=$(cat <<'EOS'
set -euo pipefail
IFS= read -r NEWPW
K=/opt/keycloak/bin/kcadm.sh
OLD=/tmp/kcadm-old.cfg NEW=/tmp/kcadm-new.cfg
trap 'rm -f "$OLD" "$NEW"' EXIT
$K config credentials --config "$OLD" --server http://localhost:8080 --realm master --user "$OLD_ADMIN" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null
if [ -n "$($K get users -r master --config "$OLD" -q username="$NEW_USER" -q exact=true --fields id --format csv --noquotes)" ]; then
  echo "ERR user $NEW_USER already exists in the master realm — pick another username"; exit 3
fi
$K create users -r master --config "$OLD" -s username="$NEW_USER" -s email="$NEW_EMAIL" -s emailVerified=true -s enabled=true >/dev/null
$K set-password -r master --config "$OLD" --username "$NEW_USER" --new-password "$NEWPW" >/dev/null
$K add-roles -r master --config "$OLD" --uusername "$NEW_USER" --rolename admin >/dev/null
echo "OK created"
# Prove the new account works before deleting anything.
$K config credentials --config "$NEW" --server http://localhost:8080 --realm master --user "$NEW_USER" --password "$NEWPW" >/dev/null
$K get realms/master --config "$NEW" --fields realm >/dev/null
echo "OK verified"
OLD_ID=$($K get users -r master --config "$NEW" -q username="$OLD_ADMIN" -q exact=true --fields id --format csv --noquotes)
[ -n "$OLD_ID" ] && $K delete "users/$OLD_ID" -r master --config "$NEW"
echo "OK deleted"
NEW_ID=$($K get users -r master --config "$NEW" -q username="$NEW_USER" -q exact=true --fields id --format csv --noquotes)
$K update "users/$NEW_ID" -r master --config "$NEW" -s 'requiredActions=["CONFIGURE_TOTP"]'
echo "OK otp"
EOS
)
out=$(printf '%s\n' "$PW1" | kc_exec "export OLD_ADMIN='$OLD_ADMIN' NEW_USER='$NEW_USER' NEW_EMAIL='$NEW_EMAIL'; $script" 2>&1) || {
  unset PW1 PW2
  printf '%s\n' "$out" | grep -v -i 'password' | sed 's/^/  /' >&2
  die "stopped — see above. $OLD_ADMIN is only deleted after the new account has signed in successfully."
}
unset PW1 PW2
grep -q '^OK created' <<<"$out" && ok "created $NEW_USER (master realm, role admin)"
grep -q '^OK verified' <<<"$out" && ok "$NEW_USER signed in successfully"
grep -q '^OK deleted' <<<"$out" && ok "deleted $OLD_ADMIN"
if grep -q '^OK otp' <<<"$out"; then ok "two-step sign-in required for $NEW_USER"
else warn "could not require two-step sign-in; set it in the console: Users -> $NEW_USER -> Required user actions -> Configure OTP"; fi
say ""
say "Next: through your SSH tunnel open http://localhost:$(auth_port)/admin/ and sign in as $NEW_USER."
say "You'll scan a QR code with your authenticator app on that first sign-in."
