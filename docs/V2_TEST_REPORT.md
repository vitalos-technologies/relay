# V2 test report

Relay V2 (security & multi-team). **Final run 2026-11-07 on `main` @ 3f43d42** after all V2 streams (A–D) and the V3 backend streams landed. The only uncommitted work in the tree was the V3 UX redesign, which had not yet changed any file these suites exercise.

Environment: Linux container, Node 22.23.4, Vitest 3.2.7, PostgreSQL 16 (`postgres:16-alpine`), SeaweedFS 3.80 (S3), Keycloak 26.4 (OIDC, realm `infra/keycloak/social-lite-realm.json`), Mailpit. Simulated social providers only.

## Results

| Suite | Command | Files | Tests | Result |
|---|---|---|---|---|
| Unit | `pnpm -s test` (project `unit`) | 12 | 104 | **104 passed** |
| Provider contracts | `pnpm -s test` (project `contracts`) | 16 | 351 | **351 passed** |
| Integration (real Postgres + S3 + Keycloak; disposable DB per run) | `set -a; . ./.env; set +a; npx vitest run --project integration` | 42 | 321 | **321 passed** (log: `evidence/v2/integration-run.txt`) |
| Security E2E (real Keycloak TOTP, step-up, recovery codes, factor removal, sessions, back-channel logout, service-account keys, CSP) | `pnpm test:e2e tests/e2e/security.spec.ts` | 1 spec | 8 | **8 passed** (stream A run; `evidence/v2/e2e-results-A.json`) |
| Full browser E2E | `pnpm test:e2e` | 3 specs | 38 | Last full run (stream A, before its final fixes): **33 passed, 5 failed** — 4 in `publishing.spec` (one outdated message expectation, since fixed; a simulated X text rejection; dev-server recompiles), 1 in `v2-product` health centre. **To be re-run after the V3 redesign lands.** |
| Typecheck | `npx tsc -p tsconfig.json --noEmit` and `apps/web` | – | – | **Clean** |
| Migration rehearsal (V1.1 data → all migrations 001–019) | `./scripts/migration-rehearsal.sh` | – | 10 checks | **PASS** 2026-11-07 (re-run after all streams) |
| Fresh database install | `pnpm db:reset` | – | – | **Works** (fixed: extensions + guarded grants in `infra/postgres/roles.sql`) |
| Fairness load test | `scripts/load-test.ts --fairness` | – | – | Not re-run; recorded 2026-11-07T04:01Z (`evidence/v2/fairness.json`) |

## V2 suites and what they prove

| Suite | Tests | Proves |
|---|---|---|
| `tests/integration/authz-core.test.ts` | 4 | `authorize()` on the real policy path: brand-scoped grant cannot act on another brand even when the action was declared without a brand; team grants combine; suspension and restrictions override allows; expired guest grant gives nothing; step-up freshness; admin lacks `workspace.transfer_owner` / `security.manage` |
| `tests/integration/v2-teams-grants.test.ts` | 7 | Union of direct + team grants with sources (Effective access); every change bumps policy version and is audited; expiry at access time; delegation ceilings, no self-grant, nobody grants owner, only owners grant admin; no mass assignment; cross-workspace brand/team/user IDs rejected; workspace switch returns only the new workspace and refuses stale tabs; fail-closed with no owner fallback |
| `tests/integration/v2-lifecycle.test.ts` | 10 | Invitations v2: scoped grants + teams, 72 h default, single acceptance by the verified identity, resend rotates the token, revoked/expired unusable, preview does not enumerate users, guest expiry (default 30 d, policy max), inviter ceiling at create and accept, bulk per-row results + replay resistance, cross-workspace join by session identity; removal blocks next request but keeps other workspaces/sessions/history and flags connections; suspension vs scope reduction; handover only to authorised members; concurrent last-owner removal; ownership transfer needs fresh assurance + acceptance |
| `tests/integration/v2-authority.test.ts` | 6 | Publication authority recorded at schedule time; revoking the scheduler's grant holds queued work; re-granting does not release; adoption re-queues; dispatch gate holds changes made outside the services; suspension/removal/team removal/approver revocation hold, draft author alone does not; in-flight sends complete; missing record or evaluation failure fails closed |
| `tests/integration/v2-collab.test.ts` | 13 | Concurrent draft saves keep both versions (conflict copy); separation of duties; person in two teams counts once toward quorum; two sequential stages incl. guest stage; publisher cannot bypass review; content/time/media/destination changes invalidate; revoked approver holds job; policy weakening needs `brands.manage` + step-up, audited, never releases holds; guests cannot read internal notes/unrelated posts/notifications via API, export or deep link; mentions/notifications re-checked at send, quiet hours, digest, critical bypass; campaigns brand-scoped |
| `tests/integration/v2-product.test.ts` | 17 | Atomic budget reservations under concurrency (workspace + team), idempotent settle/release, expiry sweep; storage reserve-before-presign; budgets settings access; fair dispatch (per-workspace cap, interleaving under concurrent workers); readiness preflight reasons incl. MFA-less publisher; duplicate warning never blocks; health centre scoped to visible brands; activity centre filters, `audit.read`, CSV-injection-safe export; client handover export scoped to one brand |
| `tests/integration/v2-adversarial.test.ts` | 6 | §12.1 ID substitution across brands/workspaces for posts, media, history/planner/search/export and job retry; §12.22 malformed policy state denies, inactive workspace gives no access |
| `tests/integration/auth.test.ts` | 10 | Real Keycloak: PKCE + nonce login, user keyed by (issuer, subject), expired states refused, pending user bound once and never re-bound, invitation accepted only with matching verified email; acr/amr/auth_time/sid from the verified ID token; fresh step-up (`acr_values=mfa`, `max_age=0`) refreshes auth_time and binds to the same subject + session; step-up by a different identity refused; login rotates the existing session cookie; `returnTo` validation |
| `tests/integration/auth-security.test.ts` | 10 | SSRF guard (private/metadata ranges, redirect re-validation, size/time limits, production has no allow-list exemptions); per-process and shared Postgres rate limiter exact under concurrency; client IP derivation |
| `tests/integration/identity.test.ts` | 7 | MFA required for owner/admin/publisher on sensitive actions only; step-up window (300 s) server-side; MFA = acr `mfa` AND second-factor amr; 30 min idle / 12 h absolute; list/revoke own sessions effective next request; rotation replaces cookie + CSRF; back-channel logout revokes exactly the IdP session's app sessions and rejects forged/wrong-audience/replayed/malformed tokens |
| `tests/integration/service-accounts.test.ts` | 4 | Creation only by owner/admin with MFA + fresh auth; key shown once, sha256-only storage, brand-scoped draft-only principal; revoked/expired/rotated keys and disabled/expired accounts fail immediately; keys never logged |
| `tests/integration/db-roles.test.ts` | 4 | `socialite_app`/`worker`/`migrator` not superuser, cannot create roles/DBs; app/worker DML only, audit log INSERT/SELECT only; only migrator runs DDL; default privileges cover later tables |
| `tests/integration/members.test.ts` | 5 | Invitation token hash only, accept URL once, emailed, idempotent; email-bound single-use acceptance; expired/revoked refused; only owners/admins invite, owners cannot be invited, cross-tenant revoke 404; member list/grants/removal impact |
| `tests/integration/tenancy.test.ts` | 11 | Cross-tenant isolation (brands, assets, templates, credentials, audit, session switch); brand restrictions; viewer limits; owner protected, last owner, ownership only by transfer; approver emergency pause |
| `tests/integration/tipsignal.test.ts` | 5 | TipSignal acts as a service account: revoked grant/disabled account rejected, never publishes; tenant from the registered integration; signature/timestamp/override checks |
| `tests/unit/security-headers.test.ts` | 5 | Page CSP is nonce-based with `strict-dynamic`, no framing, storage origin allowed; dev-only relaxations; production HSTS/nosniff/referrer/permissions policy; API responses `default-src 'none'`; no HSTS on local http |
| `tests/unit/v2-product.test.ts` | 19 | Health classification, duplicate similarity, activity categories, budget scope explanations, zip writer safety |

V1/V1.1 regression suites (`engine`, `media*`, `slots`, `crops`, `ai`, `analytics`, `connections`, `webhook-processing`, `schema`, `crypto`, `settings-v11`, `meta-callbacks`) all passed in this run.

## E2E specs (not run in this report)

| Spec | Covers | Last recorded result (source) |
|---|---|---|
| `tests/e2e/security.spec.ts` (7) | Keycloak password + TOTP sign-in, My Security, CSP with zero violations incl. presigned upload, step-up, TOTP enrol + recovery codes + reuse refused + factor removal, revoke other session, back-channel logout, service-account key shown once / revoked key fails | 7/7 passed individually (`docs/v2-progress/A.md`, stream A); full-suite run pending |
| `tests/e2e/v2-product.spec.ts` (4) | Health centre, readiness + duplicate acknowledgement, activity filters/CSV export/budgets/handover, viewer mobile | Passed on a private build (`docs/v2-progress/D.md`) |
| `tests/e2e/publishing.spec.ts` | V1 publishing journey, CSRF, cross-workspace read, viewer limits, screens @mobile, keyboard | V1.1 run (`docs/TEST_REPORT.md`); not re-run against V2 |

No E2E exists for team/member administration, invitations, offboarding/adoption, approvals with stages or the guest review portal (UI evidence is screenshots in `evidence/v2/team-*`, `collab-*`).

## Not run / limits

- No live provider calls; all publishing evidence uses simulated destinations.
- Passkeys (WebAuthn) are not exercised by any test.
- Automated tests and scans are not a penetration test or security certification.
