#!/usr/bin/env bash
# Relay — Keycloak admin helpers on the VM.
#
#   sudo infra/oracle/admin.sh replace-bootstrap
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
  replace-bootstrap) ;;
  -h|--help|"") awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$SELF"; exit 0 ;;
  *) die "unknown command: $cmd (see --help)" ;;
esac

[ "$(id -u)" -eq 0 ] || [ -n "${RELAY_KC_EXEC_CONTAINER:-}" ] || die "run with sudo"

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
