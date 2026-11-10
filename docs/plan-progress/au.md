# Stream AU — passwordless sign-in (D34)

Status: done (uncommitted). Unit+contracts 703, integration 641/641 (72 files), full E2E 128 passed / 0 failed / 9 skipped (1.0 h, 1 worker). Screenshots evidence/auth/ (scripts/auth-shots.mjs).

## What exists
- **Sign-in server image** `infra/keycloak/Dockerfile`: Keycloak 26.4 (tested 26.4.7) + Phase Two keycloak-magic-link **0.52**
  (Maven Central, sha256 `f2bd0dc3880e434ad1731a40decbc181a1d68a5071dacf5369b40ec14078b4d4`, matches Central's sha1
  `0aecaa26…`; **Elastic License 2.0**, not Apache-2.0) + `providers/relay-auth` (Java, compiled in the image against the
  Keycloak jars) + `themes/relay` (login + email). Dev compose builds it as `relay-keycloak:dev`.
- `relay-auth`: `relay-email-sign-in` (one email: single-use link via the extension's action token + 6-digit code; salted
  hash in the auth session; 15 min; 5 tries; 3 emails; no enumeration; creates accounts only with self-registration) and
  `relay-idp-verified-email-link` (Google first sign-in links only on `email_verified=true`).
- Realm: dev `infra/keycloak/social-lite-realm.json` (no passwords, flows renamed `relay passwordless …`, Google off),
  prod template regenerated; live migration `infra/oracle/admin.sh passwordless [--undo]`, `admin.sh google-signin`
  (helper `infra/oracle/keycloak/realm-admin.mjs`). `update.sh` builds/restarts the sign-in image.
- Relay: `/login` forwards to the sign-in page (errors shown on /login); sign-up mode for `/signup` handoff; customers not
  asked for MFA at sign-in; staff (platform operators) asked at sign-in and Platform API requires MFA; step-up = TOTP only
  (no max_age/prompt=login); no factor → enrol (CONFIGURE_TOTP) and that counts as fresh verification; sign-out → `/`.
- Tests: integration `auth.test.ts` (updated), new `keycloak-passwordless.test.ts`; E2E helper reads Mailpit
  (`tests/support/mailpit.ts`).

## Shared files touched
`infra/compose.yaml`, `infra/keycloak/social-lite-realm.json`, `infra/oracle/{compose.prod.yaml,update.sh,admin.sh,README.md}`,
`docs/DECISIONS.md` (D34 licence correction), `HANDOFF.md`, `README.md`, `docs/{OPERATIONS,USER_LIFECYCLE,FINAL_ACTIVATION_CHECKLIST}.md`,
`docs/runbooks/oracle-vm-deployment.md`, `apps/web/components/marketing/force-light.tsx` (missing CSP nonce — pre-existing bug
that broke the sign-out CSP test once sign-out lands on `/`), `apps/web/lib/client/api.ts`, `apps/web/lib/api.ts`, help articles.
