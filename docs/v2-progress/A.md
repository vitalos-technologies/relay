# Stream A — Identity & security (progress)

## Status
- RESUMED 2026-11-07 05:1x after container restart. Code found already present (committed in ab628ff): factors POST route (= idp-action), security page, Settings → Service accounts UI, integrations-settings SA binding, seed SA binding, proxy.ts nonce CSP + lib/csp.ts + next.config headers, E2E specs for enrol/recovery/removal + SA keys. Remaining = verification/fixes, Dex test/docs, scans.
- [x] 0. Read contracts/spec
- [~] 1. Keycloak replaces Dex — compose `oidc` = keycloak/keycloak:26.4 on :5556 (DONE, healthy); realm infra/keycloak/social-lite-realm.json; .env/.env.example OIDC_ISSUER=http://localhost:5556/realms/social-lite; infra/dex removed; tests/e2e/helpers.ts signIn completes TOTP. TODO: auth.test.ts (Dex-driven) → Keycloak; README/docs refs.
- [~] 2. OIDC assurance / step-up / sessions / back-channel logout — services DONE: auth/session.ts (30m idle/12h abs, rotate, list/revoke), auth/oidc.ts (assurance from JWKS-verified ID token, step-up purpose, idp_action purpose, RP logout URL, handleBackchannelLogout), auth/jwt.ts, auth/idp-admin.ts (KC view-users credentials). Routes: api/auth/{callback,step-up,backchannel-logout,logout}. Tests PASS: tests/integration/auth.test.ts (real KC step-up), identity.test.ts. Step-up = acr_values=mfa + max_age=0 + prompt=login (without prompt=login KC only asked OTP and did not refresh auth_time). TODO: /api/security routes, idp-action POST route, E2E.
- [~] 3. My Security page — services/security.ts + api/security/{route,sessions/[id],sessions/revoke-others,factors}; UI components/security/security-page.tsx at /security; user menu link. TODO: run against live web + E2E + screenshots.
- [~] 4. Service accounts & API keys; TipSignal → service account — services/service-accounts.ts, integrations/drafts.ts, tipsignal.ts + integrations/index.ts (binding → SA). Routes api/service-accounts/**, machine api/v1/{me,drafts} via lib/machine.ts. Tests PASS: service-accounts.test.ts, tipsignal.test.ts, settings-v11.test.ts. TODO: Settings → Service accounts UI; integrations-settings.tsx UI update; seed binding.
- [x] 5. DB least-privilege roles — infra/postgres/roles.sql, packages/db/src/roles.ts, scripts/db-roles.ts (`pnpm db:roles`), cli.ts uses MIGRATOR_DATABASE_URL (reset: DATABASE_ADMIN_URL); .env/.env.example DATABASE_URL=socialite_app, WORKER_/MIGRATOR_/DATABASE_ADMIN_URL; dev.sh roles→migrate→roles, worker uses WORKER_DATABASE_URL. Dev DB: roles applied + migrations 010-013 applied as migrator (03:5x). Test PASS: db-roles.test.ts.
- [ ] 6. CSP & headers
- [ ] 7. Scans

## Keycloak facts verified (26.4.7)
- Features enabled by default: RECOVERY_CODES (DEFAULT, supported), PASSKEYS + WEB_AUTHN, STEP_UP_AUTHENTICATION; oidc-amr-mapper exists.
- Flow "social-lite browser": cookie | forms{ loa1[LoA1 maxAge 43200]: password(amr pwd) ; loa2[LoA2 maxAge 0 + user-configured]: OTP(otp)|WebAuthn(hwk)|recovery(rc) }.
- No acr requested → acr=password, amr=[pwd]. acr_values=mfa (SSO) → OTP only, acr=mfa, amr=[pwd,otp] BUT auth_time unchanged.
  acr_values=mfa&max_age=0 → password+OTP, fresh auth_time. acr_values=mfa for a user WITHOUT 2FA → Keycloak error page ("invalid username or password") → app must check credentials first (admin API view-users).
- TOTP secret = UTF-8 bytes of stored value; code reuse in same 30 s step is rejected (codeReusable false).
- Service account of social-lite-local has realm-management/view-users only (read credentials; cannot delete creds/logout users).

## E2E status (tests/e2e/security.spec.ts, run with --reporter=list to avoid clobbering evidence/e2e/results.json)
- PASS: owner TOTP sign-in + My Security + CSP; step-up; revoke other sessions; back-channel logout (real KC → host.docker.internal:3000).
- TODO: TOTP enrol/recovery codes/removal test; service-account UI/key test.
- Dev server OOM/restarts under shared memory: warm routes first (curl) — KC back-channel times out if the route compiles on first hit.

## Notes / commands
- Re-import realm after editing JSON: `docker compose -f infra/compose.yaml up -d --force-recreate oidc`
- Migration 010 written (packages/db/migrations/010_v2_identity.sql) — do NOT edit after it is applied to dev.
