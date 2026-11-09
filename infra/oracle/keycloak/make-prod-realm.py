#!/usr/bin/env python3
"""Derive the production realm template (relay-realm.json) from the local reference realm.

    python3 infra/oracle/keycloak/make-prod-realm.py   # rewrites infra/oracle/keycloak/relay-realm.json

Keeps the flows, LoA mapping (password=1, mfa=2), required actions, client scopes and the MCP public client.
Removes every demo user, password, OTP seed and the local client secret; drops the local SMTP server.
Values that differ per installation are Keycloak import placeholders (${ENV_VAR} / ${ENV_VAR:default}) resolved from the
keycloak container's environment on the first import only. Run it again whenever the reference realm changes.
"""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[3]
ref = json.loads((root / "infra/keycloak/social-lite-realm.json").read_text())
LOCAL_CLIENT = "social-lite-local"
CLIENT = "relay-web"

r = dict(ref)
r["realm"] = "relay"
r["displayName"] = "Relay"
r["sslRequired"] = "all"
# D26: self-registration requires email verification. Off until realm SMTP works; switch on in the admin console
# (Realm settings -> Login -> User registration) or set RELAY_SELF_REGISTRATION=true before the first start.
r["registrationAllowed"] = "${RELAY_SELF_REGISTRATION:false}"
r["registrationEmailAsUsername"] = True
r["verifyEmail"] = True
r["loginWithEmailAllowed"] = True
r["duplicateEmailsAllowed"] = False
r["editUsernameAllowed"] = False
r["bruteForceProtected"] = True
r["permanentLockout"] = False
r["passwordPolicy"] = "length(12) and maxLength(128) and notUsername and notEmail and passwordHistory(3)"
r["eventsEnabled"] = True
r["eventsListeners"] = ["jboss-logging", "email"]
r["eventsExpiration"] = 7776000  # 90 days
r["adminEventsEnabled"] = True
r["adminEventsDetailsEnabled"] = False
r["smtpServer"] = {}  # activation item: configure in the admin console once SMTP exists
r["webAuthnPolicyRpEntityName"] = "Relay"
r["webAuthnPolicyRpId"] = "${RELAY_DOMAIN}"
r["webAuthnPolicyPasswordlessRpEntityName"] = "Relay"
r["webAuthnPolicyPasswordlessRpId"] = "${RELAY_DOMAIN}"

clients = []
for c in ref["clients"]:
    c = json.loads(json.dumps(c))
    if c["clientId"] == LOCAL_CLIENT:
        c["clientId"] = CLIENT
        c["name"] = "Relay web"
        c["secret"] = "${RELAY_OIDC_CLIENT_SECRET}"
        c["redirectUris"] = ["${RELAY_APP_URL}/api/auth/callback"]
        c["webOrigins"] = []
        a = c.setdefault("attributes", {})
        a["post.logout.redirect.uris"] = "${RELAY_APP_URL}/login"
        # Keycloak calls the web container directly on the private network (no public round trip).
        a["backchannel.logout.url"] = "http://web:3000/api/auth/backchannel-logout"
        a["backchannel.logout.session.required"] = "true"
    clients.append(c)
r["clients"] = clients

users = []
for u in ref.get("users", []):
    if u.get("serviceAccountClientId") == LOCAL_CLIENT:
        users.append({"username": f"service-account-{CLIENT}", "enabled": True, "serviceAccountClientId": CLIENT,
                      "clientRoles": {"realm-management": ["view-users"]}})
r["users"] = users  # service account only: no people, no passwords

csm = json.loads(json.dumps(ref.get("clientScopeMappings", {})).replace(f'"{LOCAL_CLIENT}"', f'"{CLIENT}"'))
r["clientScopeMappings"] = csm

text = json.dumps(r, indent=2, ensure_ascii=False)
# MCP token audience (protocol mappers in the client scopes) follows the public origin.
text = text.replace("http://localhost:3000/mcp", "${RELAY_APP_URL}/mcp")
for banned in ("socialite-demo", "social-lite-local-client-secret", "demo.social-lite.test", "localhost:3000"):
    assert banned not in text, banned
(Path(__file__).parent / "relay-realm.json").write_text(text + "\n")
print("wrote relay-realm.json:", len(r["clients"]), "clients,", len(users), "service-account user(s)")
