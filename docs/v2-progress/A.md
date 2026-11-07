# Stream A — Identity & security (progress)

## Status
- RESUMED 2026-11-07 05:1x after container restart. Code found already present (committed in ab628ff): factors POST route (= idp-action), security page, Settings → Service accounts UI, integrations-settings SA binding, seed SA binding, proxy.ts nonce CSP + lib/csp.ts + next.config headers, E2E specs for enrol/recovery/removal + SA keys. Remaining = verification/fixes, Dex test/docs, scans.
- 05:2x: tsc root+web 0; pnpm test 418/418; setup.test.ts + unit config test → Keycloak issuer; auth.test.ts resets analyst@ factors in beforeAll (interrupted E2E left OTP+recovery on analyst → 1 failure). Realm display names → "Relay (local)" (JSON + live via admin API). E2E security.spec: 5/6 pass; enrol test fixed locator (reuse WAS refused: 'Invalid recovery authentication code').
- [x] 0. Read contracts/spec
- [x] 1. Keycloak replaces Dex (05:4x: setup.test + unit config test → KC issuer; README sign-in table + TOTP (scripts/demo-totp.ts), dev.sh banner Relay, OPERATIONS identity/owner-lockout runbook, DEPLOYMENT IdP+headers, DECISIONS D20; realm display names Relay) — compose `oidc` = keycloak/keycloak:26.4 on :5556 (DONE, healthy); realm infra/keycloak/social-lite-realm.json; .env/.env.example OIDC_ISSUER=http://localhost:5556/realms/social-lite; infra/dex removed; tests/e2e/helpers.ts signIn completes TOTP. TODO: auth.test.ts (Dex-driven) → Keycloak; README/docs refs.
- [~] 2. OIDC assurance / step-up / sessions / back-channel logout — services DONE: auth/session.ts (30m idle/12h abs, rotate, list/revoke), auth/oidc.ts (assurance from JWKS-verified ID token, step-up purpose, idp_action purpose, RP logout URL, handleBackchannelLogout), auth/jwt.ts, auth/idp-admin.ts (KC view-users credentials). Routes: api/auth/{callback,step-up,backchannel-logout,logout}. Tests PASS: tests/integration/auth.test.ts (real KC step-up), identity.test.ts. Step-up = acr_values=mfa + max_age=0 + prompt=login (without prompt=login KC only asked OTP and did not refresh auth_time). TODO: /api/security routes, idp-action POST route, E2E.
- [~] 3. My Security page — services/security.ts + api/security/{route,sessions/[id],sessions/revoke-others,factors}; UI components/security/security-page.tsx at /security; user menu link. TODO: run against live web + E2E + screenshots.
- [~] 4. Service accounts & API keys; TipSignal → service account — services/service-accounts.ts, integrations/drafts.ts, tipsignal.ts + integrations/index.ts (binding → SA). Routes api/service-accounts/**, machine api/v1/{me,drafts} via lib/machine.ts. Tests PASS: service-accounts.test.ts, tipsignal.test.ts, settings-v11.test.ts. TODO: Settings → Service accounts UI; integrations-settings.tsx UI update; seed binding.
- [x] 5. DB least-privilege roles — infra/postgres/roles.sql, packages/db/src/roles.ts, scripts/db-roles.ts (`pnpm db:roles`), cli.ts uses MIGRATOR_DATABASE_URL (reset: DATABASE_ADMIN_URL); .env/.env.example DATABASE_URL=socialite_app, WORKER_/MIGRATOR_/DATABASE_ADMIN_URL; dev.sh roles→migrate→roles, worker uses WORKER_DATABASE_URL. Dev DB: roles applied + migrations 010-013 applied as migrator (03:5x). Test PASS: db-roles.test.ts.
- [x] 6. CSP & headers — proxy.ts per-request nonce + lib/csp.ts ('strict-dynamic', frame-ancestors 'none', connect/img/media incl. S3 origin, dev-only unsafe-eval/ws), next.config.ts (nosniff, DENY, Referrer-Policy, COOP, Permissions-Policy, HSTS when APP_ENV=production; API CSP default-src 'none'). Fixed connect-src double space. tests/unit/security-headers.test.ts (5 PASS). E2E 'CSP + security headers' PASS: theme boot nonce script runs, compose → presigned upload → preview, sign-out, zero violations (evidence/v2/security-csp-composer-upload.png).
- [x] 7. Scans (2026-11-07 05:5x)
  - `pnpm audit --prod`: **0 vulnerabilities** (320 prod deps).
  - `pnpm audit` (incl. dev): 6 dev-only — vitest 3.2.7 → tinypool ≤2.1.0 (2 critical, GHSA-5gmw-xhrv-c9v3 / GHSA-85c8-ppgw-ccpr: prototype-pollution gadget in worker options), @vitest/mocker (2 moderate, GHSA-82fw-gwwq-j7x9 / GHSA-qxg6-89mg-rqv8: browser-mode/UI mock-server endpoints), minimatch <11.0.1 via eslint-config-next (moderate ReDoS). Triage: NOT reachable — test runner/linter only, never in images or at runtime, we run neither vitest UI/browser mode nor pass untrusted options/globs. Fix = vitest 4.1.12+ major upgrade (D16 pins 3.2) → recommended for V3.1 modernisation; not done here (no dependency changes).
  - Secret scan: new `scripts/secret-scan.sh` (git-tracked files: env files, 13 credential formats, literal secret assignments outside tests/docs with local-only allow-list) → **no findings** in 794 files; also `git log --all -p` for high-confidence formats → none. Test fixtures use synthetic/docs-example values only (Telegram docs sample token allow-listed).
  - Static: `apps/web/eslint.config.mjs` added (ESLint 9 had no config → `pnpm lint` could not run). Next core-web-vitals + TS: 58 findings, 43 errors — all react-hooks compiler rules (set-state-in-effect 32, purity 4, refs 3, immutability 2, …) + 1 `<a>` in error.tsx; none security-relevant; fixed the ones in A's files (security-page Date.now → server `assurance.fresh`; integrations-settings derived state); rest left for the UX redesign stream (touches every page). Grep checks: dangerouslySetInnerHTML only the static nonce'd theme boot; no eval/new Function/innerHTML/document.write; child_process only ffmpeg/ffprobe spawn(shell:false, argv); no TLS-verification disable; no CORS wildcard; SQL template interpolation only constant fragments + $n placeholders (members/teams/posts/campaigns/lifecycle checked). Minor: listPosts ILIKE doesn't escape %/_ (matching semantics only).

- CI (.github/workflows/ci.yml): + Keycloak 26.4 container with realm import + Mailpit before integration tests (auth/setup tests need them), + secret scan, + `pnpm audit --prod`.
- 05:4x verification: tsc root 0 / web 0; pnpm test 423/423 (+5 security-headers); integration 247/249 — the 2 failures are NOT A's: setup.test 'grouped readiness' expects 14 setup groups but in-progress V3 content-hub adds google_content/notion; imports.test expects 'an image is required' but V3 changed the message to 'an image or video'. All A tests (auth 10, identity, service-accounts, tipsignal, db-roles, settings-v11) PASS.
- Dev DB reset NOT done: V3 streams have unapplied in-progress migrations 015/016/017/019 (015 still being edited) — `pnpm db:reset`/`db:migrate` would apply them to dev and break their checksums. Demo users in socialite_dev are already bound to the Keycloak issuer (fixed subjects 8d1f1c2a-…), so no account_conflict now; the lead should reset + re-seed after V3 migrations settle (seed creates users as 'pending'; migration 010 resets Dex-bound users to pending).
- Full E2E running (PLAYWRIGHT_JSON_OUTPUT_NAME=evidence/v2/e2e-results-A.json, list+json; avoids clobbering evidence/e2e/results.json).

## FINAL (07:5x) — stream A DONE
- tsc root 0; web 0 (A files); pnpm test 455/455; integration 321/321 (42 files); security.spec 8/8 PASS (3 needed a rerun after dev-server 'Unexpected end of JSON input' hiccups from concurrent V3 edits).
- Full E2E (05:41 run, before lead items): 33/38; 5 failures outside A — publishing.spec ×4 (V3 message 'an image or video', X mock text_rejected, dev-server socket hang-ups / ERR_ABORTED during recompiles) + v2-product health centre.

## Lead note (06:xx) — follow-ups to do
- [x] L1 (auth/security-events.ts afterSensitiveAuthEvent wired in oidc.ts (login amr rc; upgrade amr rc; idp_action success)) recovery-code sign-in / factor change → revoke other sessions + audit + email
- [x] L2 (stepUp on startOAuth, connectBluesky/Telegram/Mock, disconnect, reconnect (SA create/key/rotate already)) step-up (fresh) for connect/reconnect/disconnect + SA key creation
- [x] L3 (services/security-policy.ts + /api/workspace/security-policy GET/PUT + Settings → Security tab (components/settings/security-policy.tsx)) workspace security policy owner API + Settings → Security section
- [x] L4 reword D20 (pending users bind by verified email on next sign-in; registration off at IdP)
- [x] L5 (disableServiceAccountsOwnedBy in removeMember; API keys + serviceAccountCtx require active owner (suspension pauses)) service accounts on owner removal → disable (audit) / explicit reassign
- tests/integration/v2-identity-followups.test.ts 5/5 PASS (07:2x)
- Don't touch setup.test.ts group list (content-hub owns).

## Keycloak facts verified (26.4.7)
- Features enabled by default: RECOVERY_CODES (DEFAULT, supported), PASSKEYS + WEB_AUTHN, STEP_UP_AUTHENTICATION; oidc-amr-mapper exists.
- Flow "social-lite browser": cookie | forms{ loa1[LoA1 maxAge 43200]: password(amr pwd) ; loa2[LoA2 maxAge 0 + user-configured]: OTP(otp)|WebAuthn(hwk)|recovery(rc) }.
- No acr requested → acr=password, amr=[pwd]. acr_values=mfa (SSO) → OTP only, acr=mfa, amr=[pwd,otp] BUT auth_time unchanged.
  acr_values=mfa&max_age=0 → password+OTP, fresh auth_time. acr_values=mfa for a user WITHOUT 2FA → Keycloak error page ("invalid username or password") → app must check credentials first (admin API view-users).
- TOTP secret = UTF-8 bytes of stored value; code reuse in same 30 s step is rejected (codeReusable false).
- Service account of social-lite-local has realm-management/view-users only (read credentials; cannot delete creds/logout users).

## E2E status 05:3x: ALL 7 security.spec tests PASS individually (enrol/recovery/reuse-refused/removal, SA key once/revoke, CSP composer+upload).
## (old) E2E status (tests/e2e/security.spec.ts, run with --reporter=list to avoid clobbering evidence/e2e/results.json)
- PASS: owner TOTP sign-in + My Security + CSP; step-up; revoke other sessions; back-channel logout (real KC → host.docker.internal:3000).
- TODO: TOTP enrol/recovery codes/removal test; service-account UI/key test.
- Dev server OOM/restarts under shared memory: warm routes first (curl) — KC back-channel times out if the route compiles on first hit.

## Notes / commands
- Re-import realm after editing JSON: `docker compose -f infra/compose.yaml up -d --force-recreate oidc`
- Migration 010 written (packages/db/migrations/010_v2_identity.sql) — do NOT edit after it is applied to dev.
