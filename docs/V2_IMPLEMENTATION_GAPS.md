# V2 implementation gaps

Unfinished engineering only, as of 2026-11-07. External setup is in [V2_FINAL_ACTIVATION_CHECKLIST.md](V2_FINAL_ACTIVATION_CHECKLIST.md). Row IDs refer to [V2_REQUIREMENTS_MATRIX.md](V2_REQUIREMENTS_MATRIX.md). Stream A (identity & security) was still running when this was written; its items may change.

## 1. Partial — security-relevant

| # | Gap | Where | What is missing | Matrix |
|---|---|---|---|---|
| G1 | Application rollback to V1.1 is unsafe after migrating | `packages/services/src/tenancy.ts` (V1.1 tag) vs V2 schema | V1.1 ignores `memberships.status` (suspended users regain access), reads guests as non-expiring brand viewers, has no authority gate. No rollback rehearsal; `scripts/migration-rehearsal.sh` prints "application images roll back freely", which is wrong for V1.1 | 12.21 |
| G2 | No tool for changing the production OIDC issuer | `svc/auth/users.ts`, `mig/010` | Only local Dex users are reset to `pending`. Users bound to any other issuer get `account_conflict` after an issuer change; re-binding needs a manual SQL reset (runbook §8) | 2.1 |
| G3 | No action after a sensitive recovery | `svc/auth/oidc.ts` | Signing in with a recovery code (`amr` `rc`) does not revoke other sessions, notify the user or raise an alert | 5.17 |
| G4 | Factor/recovery-code change notifications | Keycloak realm `eventsListeners: email` | Relay sends nothing. It relies on Keycloak's email event listener, which has not been verified to send for these events | 5.15 |
| G5 | Step-up missing for social credential changes | `svc/connections/{oauth,manage}.ts`, `svc/setup.ts` | Connect/reconnect/disconnect and provider app secrets need MFA (sensitive permission) but not a fresh authentication | 5.7 |
| G6 | Workspace security policy has no editor | `workspaces.security_policy` | `mfa_required_all`, `mfa_required_for`, `step_up_seconds`, `invite_ttl_hours`, `guest_default_days`, `guest_max_days` change only by SQL. Spec's "require MFA for all members" toggle and "step-up to weaken security policy" have no surface | 5.4, 5.7 |
| G7 | Expired grants and invitations are not cleaned up | `apps/worker/src/main.ts` | Expiry is enforced at access time (tested); no job revokes expired guest grants. The legacy summary (`memberships.role`) is not refreshed when grants expire | 4.7 |
| G8 | Service accounts survive their owner's removal | `svc/lifecycle.ts` `removeMember` | Owned service accounts keep working unless reassigned in the handover or disabled; removal does not warn beyond the preview list | – |
| G9 | Audit has no result field | `audit_events` (`mig/001`), `svc/audit.ts` | Only successful changes are recorded (plus step-up subject mismatch and cancellations). Denied attempts are not audited. No external immutable sink | 9.9, 9.11 |
| G10 | Passkeys never verified | `svc/security.ts` (`webauthn-register`), realm | Enrolment and sign-in with a passkey are untested (no virtual-authenticator E2E); WebAuthn RP ID is the local realm's | 5.2 |
| G11 | Migration review items have no UI | `migration_review_items` (`mig/009`) | Operators must read and resolve them with SQL | 10.4 |
| G12 | Expected-version checks on admin mutations | `svc/{teams,members,grants}.ts` | Drafts and scheduling use expected versions; team/grant/member edits use row locks + idempotency only, so a stale admin screen can overwrite silently | 11.10 |
| G13 | Legacy authorization fallback | `svc/tenancy.ts` `authorizeCtx`, `web/lib/api.ts` | A `Ctx` without `access.authz` falls back to the V1 role matrix. Test contexts (`ctxFor()`) and workspace-less routes (`route(…, { workspace: false })`: session, workspaces, security, invitation accept, logout — built as `viewer` with no brands) carry no V2 state. Safer: fail closed when `authz` is absent outside tests | 3.1 |
| G14 | No guard against running as a privileged DB role | `svc/config.ts` | Production boot does not check that `DATABASE_URL` is a non-superuser role; worker role is chosen only by the container's `DATABASE_URL` | 9.3 |

## 2. Partial — product / UX

| # | Gap | What is missing | Matrix |
|---|---|---|---|
| G15 | Client cache clearing on workspace switch | `web/lib/client/workspace-sync.ts` exists; no browser test | 2.9, 12.16 |
| G16 | Ownership-transfer and lifecycle notifications | In-app only; no email | 4.15 |
| G17 | Workspace-admin visibility statement | Documented, not shown in the UI | 2.7 |
| G18 | Accessibility of V2 screens | No audit; ESLint (react-hooks) reports 43 errors across pages outside stream A's files (none security-relevant per stream A triage) | 11.13 |
| G19 | Health centre overdue labelling | Lead checklist item: overdue "scheduled" items when the worker is down should be labelled overdue; not verified | 7.1 |
| G20 | CSP violation reporting | No `report-uri`/`report-to` endpoint; violations are invisible in production | 9.7 |

## 3. Verification gaps

| # | Gap | Detail |
|---|---|---|
| V1 | E2E not re-run | `tests/e2e/*` not run in the 2026-11-07 report; stream A recorded 7/7 security specs individually, full run pending |
| V2 | No E2E for team admin, invitations, offboarding/adoption, staged approvals, guest portal | Service layer is integration-tested; UI evidence is screenshots only |
| V3 | Two failing integration tests (V3 work) | `imports.test.ts` (message wording), `setup.test.ts` (new setup groups). The setup test no longer reaches its "never returns secret values" assertions |
| V4 | Typecheck and production build | Not run in the latest report |
| V5 | Rehearsal coverage | `scripts/migration-rehearsal.sh` runs as superuser on local compose only; DB roles and rollback not rehearsed |
| V6 | Dev-only dependency advisories | vitest 3.2 → tinypool (2 critical), @vitest/mocker, minimatch via eslint-config-next. Not in images; fix = vitest 4 upgrade (deferred) |
| V7 | Build status doc | `docs/BUILD_STATUS.md` still says V2 is queued |

## 4. Not started (optional in the spec)

Presence / edit lease (6.6) · outgoing custom webhooks (8.5) · PostgreSQL row-level security (9.4) · external immutable audit sink (9.11).

## 5. Simulated or blocked by external setup

| Item | Why | Unblocked by |
|---|---|---|
| Live publishing on all four providers, provider metrics, canaries | No credentials or test destinations; all evidence uses simulated destinations | V1 activation checklist §2–5 |
| Production IdP behaviour (MFA, passkeys, back-channel logout, email events) | Verified only against the local Keycloak realm | Activation §1 |
| KMS key custody in production | Implemented (V1); only local keys used | Activation §4 |
| Fairness and load numbers | One machine, simulated provider latency (`evidence/v2/fairness.json`) | Staging run |
| Deployment | No authorised hosting target | Activation §8 |
