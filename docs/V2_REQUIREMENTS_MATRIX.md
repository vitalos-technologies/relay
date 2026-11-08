# V2 requirements matrix

One row per requirement in the V2 spec (§ numbers match the spec). Status: **Done (tested)** · **Done (untested)** · **Partial** · **Not started** · **Blocked (external)**. "Tested" means an automated test in this repo covers it. Results of the 2026-11-07 run are in [V2_TEST_REPORT.md](V2_TEST_REPORT.md); unfinished work is in [V2_IMPLEMENTATION_GAPS.md](V2_IMPLEMENTATION_GAPS.md).

Test keys (all `tests/integration/` unless noted): **AZ** `authz-core` · **TG** `v2-teams-grants` · **LC** `v2-lifecycle` · **AU** `v2-authority` · **CO** `v2-collab` · **PR** `v2-product` · **AD** `v2-adversarial` · **AT** `auth` (real Keycloak) · **AS** `auth-security` · **ID** `identity` · **SA** `service-accounts` · **DB** `db-roles` · **MB** `members` · **TN** `tenancy` · **TS** `tipsignal` · **EN** `engine` · **UH** `tests/unit/security-headers` · **ES** `tests/e2e/security.spec.ts` · **EP** `tests/e2e/v2-product.spec.ts` (E2E not run in the latest report).

Code roots: `core/` = `packages/core/src`, `svc/` = `packages/services/src`, `web/` = `apps/web`, `mig/` = `packages/db/migrations`.

## §1 Inspection and threat model

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 1.1 | Baseline + requirement-to-code-and-test matrix | Done (untested) | this file; `docs/V2_TEST_REPORT.md` | Document |
| 1.2 | Compact threat model (actors, boundaries, gaps) | Done (untested) | `docs/V2_THREAT_MODEL.md` | Document |

## §2 Hierarchy and tenant boundaries

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 2.1 | User = IdP issuer + subject, not editable email | Done (tested) | `svc/auth/users.ts`; AT "binds a pre-provisioned (pending) user … never re-binds" | Same email + different identity → `account_conflict` |
| 2.2 | Workspace = tenant; user in several workspaces with different permissions | Done (tested) | `mig/009` grants per workspace; LC "a signed-in user of another workspace joins by session identity"; TN | |
| 2.3 | Team never spans workspaces | Done (tested) | `mig/009` composite FKs `(workspace_id, team_id)`; TG "cross-workspace brand/team/user ids are rejected" | |
| 2.4 | Brand boundary; several teams on one brand via assignments | Done (tested) | team grants on brand scope; TG "combines direct + team grants" | |
| 2.5 | Connection owned by brand; no workspace-wide inference | Done (tested) | `core/authz.ts` `covers()` connection scope; `schema.test` composite FKs | |
| 2.6 | Campaign/post/asset brand-scoped | Done (tested) | `mig/012` `posts_campaign_fk`; CO "campaigns are brand-scoped"; AD | |
| 2.7 | State that workspace owners/admins see every brand | Done (untested) | `docs/V2_THREAT_MODEL.md` residual risks; `docs/PERMISSIONS_MATRIX.md` | Not stated in the UI |
| 2.8 | Example seed: agency workspace, Editorial + Publishing teams, 2 brands, guest on Brand A, second org | Done (untested) | `scripts/seed-v2-tenancy.ts` | Seed itself not tested; same shapes are exercised by TG/CO/AD fixtures |
| 2.9 | Workspace switch clears client caches/drafts/counts | Done (untested) | `web/lib/client/workspace-sync.ts` (caches, storage, BroadcastChannel reload) | No browser test |
| 2.10 | Server validates workspace + membership; header/ID is not authority | Done (tested) | `svc/workspaces.ts` `assertExpectedWorkspace`, `svc/tenancy.ts` `loadAccess`; TG "stale tabs are refused"; TN "cannot switch the session…" | |

## §3 Authorization

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 3.1 | Central `authorize(subject, action, resource, context)` with reason code + policy version | Done (tested) | `svc/authz.ts`, `core/authz.ts` `evaluate`; AZ | |
| 3.2 | Permission identifiers per spec | Done (tested) | `core/authz.ts` `PERMISSIONS` (+ `comments.internal/shared`, `content.create_draft`) | |
| 3.3 | Deny by default; same policy in API, server actions, exports, storage, workers | Done (tested) | `svc/tenancy.ts` `requireAction`/`assertBrand`; AD; AU (dispatch gate); PR (exports) | No websockets/SSE exist |
| 3.4 | Role presets and their limits | Done (tested) | `core/authz.ts` `PRESET_PERMISSIONS`; AZ "admin lacks ownership transfer"; CO "a publisher cannot bypass required review" | Adds `team_manager`, `exporter`, `integration` |
| 3.5 | Multiple scoped roles; union; suspension/expiry/deny override; precedence documented + tested | Done (tested) | `core/authz.ts` header; `docs/PERMISSIONS_MATRIX.md`; AZ; TG | |
| 3.6 | Team membership ≠ grants; delegation ceiling; publishing-team join is a privilege grant | Done (tested) | `svc/teams.ts`, `mig/009` `delegation_limits`; TG "team managers act only within their delegation ceiling" | Admin adding to a publishing team needs step-up |
| 3.7 | No self-escalation, mass assignment, cross-workspace team IDs | Done (tested) | `core/authz.ts` `canDelegate`, `svc/grants.ts`; TG | |
| 3.8 | Effective access view (brands/connections, actions, source grant, expiry) | Done (tested) | `svc/access.ts` `effectiveAccess`; `web/app/(app)/team/members/[userId]`; TG | UI not E2E-tested |
| 3.9 | No private-resource existence leakage | Done (tested) | 404 for invisible resources (`svc/tenancy.ts`); AD; TN | |

## §4 User lifecycle and team management

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 4.1 | Admin screens: search, filters, role, team, grants, status, invite state, expiry, last sign-in | Done (untested) | `web/app/(app)/team/**`; `svc/members.ts` `last_sign_in_at`; `evidence/v2/team-*.png` | Screenshots only |
| 4.2 | Invitation = workspace, verified email, scoped roles, inviter, expiry; 72 h default, configurable | Done (tested) | `svc/auth/invitations.ts`, `mig/011`; LC "carries scoped grants + teams; 72 h default" | TTL configurable only in DB (`security_policy.invite_ttl_hours`) |
| 4.3 | Random single-use hashed tokens; resend invalidates; atomic expiry/revoke/accept | Done (tested) | LC "resend rotates the token…"; MB | |
| 4.4 | Acceptance requires the intended verified identity | Done (tested) | LC; AT "redirects back to the invitation with an error when the email does not match" | |
| 4.5 | Join another workspace without linking by unverified email | Done (tested) | `acceptInvitationForUser`; LC | |
| 4.6 | Adding members audited + server-authorized; bulk per-row results, duplicate-resistant | Done (tested) | `bulkInvite`; LC "bulk invites validate each row…" | |
| 4.7 | Guest grants require expiry (default 30 d); enforced at access time AND by cleanup job | Partial | `mig/009` CHECK, `mig/011`; LC; AZ "expired guest grant gives nothing" | No cleanup job (access-time only) |
| 4.8 | No user enumeration in invitation/login/recovery | Done (tested) | `previewInvitation` masks email; LC "preview never enumerates users" | Login/recovery are Keycloak's; realm has password reset disabled |
| 4.9 | Removal, suspension, team removal, scope reduction are distinct | Done (tested) | `svc/lifecycle.ts`, `svc/teams.ts`; LC "suspension and scope reduction are distinct operations" | |
| 4.10 | Immediate revocation; caches invalidated; open tabs cannot mutate | Done (tested) | grants reloaded per request (`svc/authz.ts`); LC "removal blocks the next request from any open tab" | No permission cache, no live subscriptions exist |
| 4.11 | Removal does not log the user out of other workspaces | Done (tested) | `removeMember` clears only `active_workspace_id`; LC | |
| 4.12 | Handover preview + reassignment without exposing unrelated brands | Done (tested) | `handoverPreview`, `reassignWork`; LC "handover reassigns … never exposing other brands" | |
| 4.13 | Never delete historical posts/audit on departure | Done (tested) | LC removal test (history kept) | |
| 4.14 | Last active owner preserved, incl. concurrent removals | Done (tested) | `lockWorkspace` + `assertNotLastOwner`; LC "concurrent owner removals…"; TN | |
| 4.15 | Ownership transfer: fresh auth, acceptance, atomic, notifications | Done (tested) | `proposeOwnershipTransfer`/`acceptOwnershipTransfer`; LC "transfer needs fresh assurance on both sides" | Notifications are in-app only |
| 4.16 | Flag connections for verification; never claim provider ownership moved | Done (tested) | `connections.verification_*` (`mig/011`); LC removal test | |
| 4.17 | Record revision, policy version, approvals, authority, destinations at scheduling | Done (tested) | `publication_authorizations` (`mig/011`, immutable trigger); `svc/engine/authority.ts`; AU | |
| 4.18 | Revalidate at dispatch incl. required approvers | Done (tested) | `checkPublicationAuthority` in `engine/process.ts`; AU "the dispatch gate is the backstop" | |
| 4.19 | Removal/suspension of scheduler holds jobs for adoption | Done (tested) | `holdPublication`, `adoptPublication`; AU; `web/app/(app)/team/held` | |
| 4.20 | Draft author removal alone does not invalidate approved work | Done (tested) | AU "… not when the draft author leaves" | |
| 4.21 | Tightening holds; loosening never auto-publishes | Done (tested) | AU "re-granting does not release it"; CO policy weakening test | |
| 4.22 | In-flight external calls complete; boundary reported | Done (tested) | AU "in-flight sends complete…" | |

## §5 Authentication, MFA, sessions, recovery

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 5.1 | MFA via IdP mechanisms: TOTP | Done (tested) | Keycloak realm LoA2 flow; AT; ES (TOTP enrol + sign-in) | Keycloak replaces Dex (D20) |
| 5.2 | Passkeys (WebAuthn) | Partial — stream A in progress | realm `webauthn-register` action; `svc/security.ts` action; `amr` `hwk` accepted (ID) | Never exercised end to end; needs production RP ID |
| 5.3 | Default MFA for owners, admins, publishers, security/account managers | Done (tested) | `security_policy.mfa_required_for` (`mig/009`); ID "owner/admin/publisher need verified MFA…" | Also `brand_manager` |
| 5.4 | Option to require MFA for all members | Partial | `mfa_required_all` enforced in `core/authz.ts` `requiresMfa` | No API/UI to change it (SQL only) |
| 5.5 | Sensitive actions unavailable during enrolment; assurance server-side | Done (tested) | `evaluate` → `mfa_required`; `sessions.mfa_verified` written only by `svc/auth/oidc.ts`; ID | |
| 5.6 | Step-up for ownership transfer, sensitive grants, factor change, recovery regeneration, SA keys | Done (tested) | `requireAction(…, { stepUp: true })` in lifecycle/members/teams/invitations/service-accounts; `startFactorAction`; LC, SA, ES | |
| 5.7 | Step-up for social credential changes and security-policy weakening | Partial — stream A in progress | Approval-policy weakening: step-up (CO) | Connect/reconnect and provider secrets need MFA but no freshness; workspace security policy has no editor |
| 5.8 | Freshness window 5 min, configurable | Done (tested) | `step_up_seconds` 300; ID "step-up actions require authentication within the freshness window" | Configurable only in DB |
| 5.9 | Supported `acr`/`amr` defined and tested | Done (tested) | `assuranceFromClaims`; ID; AT | `acr=mfa` AND amr ∈ {otp,hwk,swk,sms,rc,mfa} |
| 5.10 | Security page: sessions, device metadata, last activity, revoke; no invented location | Done (tested) | `svc/security.ts`, `web/components/security/security-page.tsx`; ID; ES | No IP-derived location |
| 5.11 | Session rotation, secure cookies, CSRF, server-side invalidation | Done (tested) | `svc/auth/session.ts`; ID "rotation replaces the cookie value and CSRF token"; AT | |
| 5.12 | 30 min idle / 12 h absolute; explicit refresh/remember policy | Done (tested) | `IDLE_TIMEOUT_MS`, `SESSION_TTL_MS`; ID | No refresh; realm `rememberMe=false` |
| 5.13 | Back-channel/IdP logout revokes app sessions | Done (tested) | `handleBackchannelLogout`; ID (forged/replayed tokens); ES (real Keycloak) | |
| 5.14 | Provider-managed recovery codes: hashed, one-time, shown once, atomic consume | Done (tested) | Keycloak recovery codes; ES "cannot reuse it" | E2E only, not re-run in latest report |
| 5.15 | Regeneration invalidates old codes; recovery/factor changes notify via verified channel | Partial — stream A in progress | Regeneration via Keycloak action (step-up) | App sends no notification; relies on Keycloak `email` event listener (configured locally, unverified) |
| 5.16 | Workspace admins cannot remove another user's MFA | Done (untested) | `svc/auth/idp-admin.ts`: client holds only `view-users`; no endpoint | By absence; no negative test |
| 5.17 | No email-only recovery bypass; audit, notify, revoke sessions after sensitive recovery | Partial — stream A in progress | Realm `resetPasswordAllowed=false` | No session revocation or app notification after a recovery-code sign-in |
| 5.18 | Documented owner-lockout procedure via IdP; no master password/bypass | Done (untested) | `docs/OPERATIONS.md` "Owner lockout" | |
| 5.19 | Tests of enrolment, verification, factor change/removal, code reuse, session revocation | Done (tested) | ES (7 tests), ID, AT | E2E full-suite run pending (stream A) |

## §6 Collaboration and editorial control

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 6.1 | Campaigns, assignees, due dates | Done (tested) | `svc/collab/{campaigns,planning}.ts`; CO "campaigns and assignments" | |
| 6.2 | Internal comments and mentions | Done (tested) | `svc/collab/comments.ts`; CO | |
| 6.3 | Review requests and version history | Done (tested) | `svc/posts/versions.ts`, `post_versions` (`mig/012`); CO | |
| 6.4 | Notification preferences | Done (tested) | `svc/collab/notifications.ts`; CO | |
| 6.5 | Optimistic concurrency; recoverable conflict | Done (tested) | conflict copies in `post_versions`; CO "§12 case 11" | |
| 6.6 | Presence / advisory edit lease (optional) | Not started | – | Optional in spec |
| 6.7 | Policies: none, one stage, two sequential stages | Done (tested) | `svc/posts/approval-policy.ts`; CO "two sequential stages" | |
| 6.8 | Quorum counts distinct currently eligible people | Done (tested) | CO "a person in two eligible teams counts once" | |
| 6.9 | Separation of duties | Done (tested) | CO "authors/editors … cannot give its independent approval" | |
| 6.10 | Publisher role cannot bypass required review | Done (tested) | CO | |
| 6.11 | Approval binds revision, assets, destinations, links, schedule, policy generation; changes invalidate; no inherited approval | Done (tested) | `approvals.binding_hash`; CO "§12 case 13" | |
| 6.12 | Disabling approval: privileged, fresh-auth, audited, no auto-release | Done (tested) | CO "weakening needs brands.manage + step-up…" | |
| 6.13 | Authenticated, resource-scoped guest review; no anonymous links by default | Done (tested) | `svc/collab/review.ts`, `review_shares`; `web/app/review/**`; CO | Portal UI screenshots only |
| 6.14 | Shared vs internal comments; guests never get internal notes (API/notifications/exports) | Done (tested) | CO "§12 case 14" | |
| 6.15 | Mentions only to entitled people at send; deep links recheck; minimal email content; delayed sends recheck | Done (tested) | CO "mentions and notifications" | |
| 6.16 | Notify once; daily digest; quiet hours; critical alerts separate; click never approves/publishes | Done (tested) | CO; worker `notification-emails` sweep | |

## §7 Additional product improvements

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 7.1 | Account health centre with affected schedules | Done (tested) | `svc/product/health.ts`; PR; unit `v2-product`; EP | |
| 7.2 | Approval inbox grouped by brand/assignee/due; exact variant previews | Done (tested) | `svc/collab/inbox.ts`; CO | Grouping UI screenshots only |
| 7.3 | Publishing readiness preflight | Done (tested) | `svc/product/readiness.ts`; PR | |
| 7.4 | Duplicate/collision warning (not idempotency) | Done (tested) | `svc/product/duplicates.ts`; PR "never blocks" | |
| 7.5 | Calendar ownership without exposing inaccessible brands | Done (untested) | planner decoration; `evidence/v2/collab-planner-ownership.png` | |
| 7.6 | Per-workspace/team budgets (AI, storage, exports, provider calls), atomic reservations | Done (tested) | `svc/product/budgets.ts`, `mig/013`; PR | |
| 7.7 | Fair scheduling across workspaces/accounts | Done (tested) | `svc/engine/fairness.ts`; PR; `evidence/v2/fairness.json` (p95 lag 6.5 s → 0.9 s) | Simulated providers |
| 7.8 | Service account for TipSignal (no human token) | Done (tested) | `mig/010` backfill; TS | |
| 7.9 | Activity/security centre with filters | Done (tested) | `svc/product/activity.ts`; PR; EP | |
| 7.10 | Client handover: scoped export + responsibility transfer | Done (tested) | `svc/product/handover.ts`; PR; reassignment in 4.12 | |
| 7.11 | Unsupported metrics are unavailable, not zero | Done (tested) | V1.1 `analytics.test` | |
| 7.12 | AI draft-only, scoped to workspace/brand, authority rechecked on apply | Done (tested) | V1.1 `ai.test` "rechecks authorization after generation" | |
| 7.13 | No billing, SAML/SCIM, social listening, custom roles, DM inbox | Done (untested) | Not built | Out of scope by design |

## §8 Service accounts, integrations, credentials

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 8.1 | Workspace-owned, brand-scoped, named owner, expiry, last used, explicit actions; TipSignal default draft-only | Done (tested) | `svc/service-accounts.ts`, `mig/009`/`010`; SA; TS | |
| 8.2 | API keys high-entropy, shown once, hashed; provider tokens encrypted (separate) | Done (tested) | SA "key is shown once, stored as sha256 only"; V1 `crypto.test` | |
| 8.3 | Rotation/revocation keep attribution; revoked rejected immediately; no secrets logged | Done (tested) | SA "revoked, expired and rotated-out keys…", "keys never appear in logs" | |
| 8.4 | Inbound webhooks: signature, replay/dedupe, size limit; tenant from integration | Done (tested) | TS; V1 webhook tests | |
| 8.5 | Outgoing custom webhooks (optional) | Not started | – | Optional in spec |
| 8.6 | Versioned, recoverable credential rotation; backup restore with keys | Done (tested) | V1 `crypto.test` KEK rotation; `scripts/restore-drill.sh` | |
| 8.7 | Secrets never returned after storage | Done (tested) | V1 `/setup` write-only | `setup.test` secret assertion currently not reached (see test report) |

## §9 Isolation and hardening

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 9.1 | Tenant scoping beyond CRUD (search, queue, retries, exports, metrics, previews, notifications, AI) | Done (tested) | AD; CO; PR; V1.1 `ai`/`analytics` | |
| 9.2 | FKs prevent cross-brand references | Done (tested) | composite FKs; `schema.test` | |
| 9.3 | Separate least-privilege DB roles (app, worker, migrator) | Done (tested) | `infra/postgres/roles.sql`, `packages/db/src/roles.ts`, `scripts/db-roles.ts`; DB | Production provisioning is external |
| 9.4 | Row-level security (optional) | Not started | – | Not adopted; authorization is in the service layer |
| 9.5 | Signed URLs scoped to asset + TTL; residual window acknowledged | Done (tested) | V1 `media.test`; threat model residual risks | No proxying of sensitive downloads |
| 9.6 | Upload validation, CSV injection, quotas, SSRF, cookies, rate limits | Done (tested) | V1 `media.test`; AS; PR export | |
| 9.7 | Real CSP compatible with auth/uploads | Done (tested) | `web/proxy.ts`, `web/lib/csp.ts`; UH; ES "CSP + security headers" | No violation reporting endpoint |
| 9.8 | Errors/telemetry never serialize credentials or draft content | Done (untested) | `svc/log.ts` `redact`, audit redaction | Only key redaction is tested (SA) |
| 9.9 | Audit: actor, workspace, resource, action, before/after, time, result, correlation ID | Partial | `svc/audit.ts`; TG "audited" | No `result` field; denied attempts mostly not audited |
| 9.10 | Audit append-only for app roles; tamper boundary documented | Done (tested) | `roles.sql` revokes UPDATE/DELETE; DB; threat model | |
| 9.11 | Immutable external audit sink (optional) | Not started | – | Not configured; see activation checklist |
| 9.12 | No silent support impersonation | Done (untested) | No support-access feature exists | |
| 9.13 | Dependency, secret and static scans with triage | Done (tested) | `scripts/secret-scan.sh`, `pnpm audit --prod` 0 vulns; `docs/v2-progress/A.md` §7 | 6 dev-only advisories (vitest/tinypool) open |

## §10 Data model and migration

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 10.1 | Suggested tables (teams, grants, invitations, history, policies, approvals, authority, service accounts, notifications, budgets) | Done (tested) | `mig/009`–`013` | `policy_version` column instead of a versions table; `audit_events` serves security events |
| 10.2 | IdP sessions/factors not reimplemented; subject/issuer mapping stored | Done (tested) | factors read via `svc/auth/idp-admin.ts`; AT | |
| 10.3 | Composite tenant constraints, unique memberships/acceptance, immutable approval evidence, indexes | Done (tested) | `mig/011`/`012` triggers; `schema.test` | |
| 10.4 | Backfill V1 roles without broadening; ambiguous items marked for review | Done (tested) | `mig/009` backfill + `migration_review_items`; rehearsal checks | Review items have no UI |
| 10.5 | Verify counts/invariants; rehearse on disposable copy | Done (tested) | `scripts/migration-rehearsal.sh`; `evidence/v2/migration-rehearsal.txt` PASS | |
| 10.6 | Explicit MFA enrolment transition; no sensitive actions during enrolment | Done (tested) | `mfa_required` deny; step-up returns `setupRequired`; ID | |
| 10.7 | No two schedulers on one queue; worker drainage; app rollback documented | Done (untested) | `docs/V2_MIGRATION_RUNBOOK.md` | V1.1 image rollback is unsafe (see runbook) |
| 10.8 | Restored DB starts with dispatch paused | Done (tested) | V1 restore drill; rehearsal "dispatch still disabled" | |

## §11 UI and API

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 11.1 | Workspace switcher and teams directory | Done (untested) | `web/components/shell/workspace-switcher.tsx`, `team/teams` | Screenshots |
| 11.2 | Members/invitations with effective access and scoped roles | Done (untested) | `team/members`, `team/invitations` | Service layer tested (TG, LC) |
| 11.3 | Brand/team assignment and delegated membership | Done (untested) | `team/teams/[id]` | Service layer tested (TG) |
| 11.4 | My security: MFA, recovery, sessions | Done (tested) | `web/app/(app)/security`; ES | |
| 11.5 | Guest/client review portal | Done (untested) | `web/app/review/**` | Service layer tested (CO) |
| 11.6 | Approval policy builder (supported stages/quorum) | Done (untested) | settings policy card; `evidence/v2/collab-policy-builder.png` | Service layer tested (CO) |
| 11.7 | Activity/security log with permitted export | Done (tested) | `web/app/(app)/activity`; PR; EP | |
| 11.8 | Service accounts, usage controls, connection health | Done (tested) | Settings → Service accounts; budgets; `accounts/health`; SA, PR, ES, EP | |
| 11.9 | Offboarding preview, reassignment, queued-publication adoption | Done (untested) | `team/members/[userId]`, `team/held` | Service layer tested (LC, AU) |
| 11.10 | Every mutation validates actor, scope, expected version, step-up | Partial | expected version on drafts/scheduling (`svc/posts/*`); step-up per 5.6 | Admin mutations (teams/grants/members) use locks + idempotency, no client expected version |
| 11.11 | Idempotent create/revoke/invite/approve/adopt | Done (tested) | idempotency keys (invites, SA create, schedule); `adoptPublication` no-op when active; LC bulk replay | |
| 11.12 | No trusted roles/tenant IDs/assurance/actor from client | Done (tested) | TG "server derives scope from ids"; ID | |
| 11.13 | Accessible desktop/mobile layouts with conflict, expired invite, revoked session, denied, incomplete MFA, empty states | Partial | mobile screenshots `evidence/v2/*mobile*.png`; EP viewer @mobile | No accessibility audit of V2 screens |
| 11.14 | No success toast before server commit | Done (untested) | client code convention | Not systematically verified |

## §12 Fixtures, negative/race cases, release gates

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 12.0 | Fixtures (2 workspaces, 2 brands, 2 teams sharing a brand, roles, expired guest, service account) in DB tests and browser workflows | Partial | `tests/integration/helpers.ts` `v2Ctx` fixtures; `scripts/seed-v2-tenancy.ts` | Browser workflows cover security/product only |
| 12.1 | Cross-workspace/brand ID substitution denied (API, search, export, media, jobs) | Done (tested) | AD; TG; TN | |
| 12.2 | Team manager cannot exceed delegation ceiling | Done (tested) | TG | |
| 12.3 | Combined team grants; suspension/expiry/deny override | Done (tested) | AZ; TG | |
| 12.4 | Invite unusable after expiry/revoke/resend/accept; concurrent accept once | Done (tested) | LC; MB | |
| 12.5 | Different verified identity cannot accept | Done (tested) | LC; AT | |
| 12.6 | Removal blocks existing tabs/subscriptions; no cached permissions | Done (tested) | LC | No live subscriptions exist |
| 12.7 | Offboarding preserves other workspaces, history, holds/adoption | Done (tested) | LC; AU | |
| 12.8 | Last owner protected incl. concurrent; transfer needs acceptance + fresh assurance | Done (tested) | LC; TN | |
| 12.9 | MFA recovery/removal not an admin/email bypass; recovery-code reuse fails | Partial — stream A in progress | ES (reuse refused); 5.16, 5.17 | Reuse covered by E2E only; no post-recovery session revocation |
| 12.10 | Step-up freshness and session revocation server-side | Done (tested) | ID; AT | |
| 12.11 | Concurrent draft saves conflict without loss | Done (tested) | CO | |
| 12.12 | No self-approval under SoD; duplicate team membership counts once | Done (tested) | CO | |
| 12.13 | Content/time/media/destination changes invalidate; revoked approver holds | Done (tested) | CO; AU | |
| 12.14 | Guests cannot read internal notes/unrelated posts/notifications | Done (tested) | CO | |
| 12.15 | Scoped service keys cannot publish/access other brands; expired/revoked fail | Done (tested) | SA; TS; ES | |
| 12.16 | Workspace switch leaks no cached content or old channels | Partial | Server: TG. Client: `workspace-sync.ts` | Client cache clearing untested |
| 12.17 | Dispatch honours policy, suspension, pause, deadline, adoption | Done (tested) | AU; EN (pause/deadline) | |
| 12.18 | Budgets and throttles under concurrent workers; fair dispatch | Done (tested) | PR | |
| 12.19 | No secrets in logs/exports; CSV injection; upload/SSRF | Done (tested) | SA; PR; AS; V1 `media.test` | |
| 12.20 | V1 publish/schedule/partial/retry/restart correct for four providers | Done (tested) | EN (24); contracts (348) | Simulated providers; live is 12.24 |
| 12.21 | Migration and rollback rehearsals preserve data, no replay | Partial | migration rehearsal PASS (004–014) | No rollback rehearsal; V1.1 image rollback unsafe |
| 12.22 | Policy failures fail closed; no owner fallback | Done (tested) | AD; TG; AU | |
| 12.23 | Unit, integration, contract, browser and production build checks with outcomes | Partial | `docs/V2_TEST_REPORT.md` | E2E and build not run in latest report; 2 integration failures (V3) |
| 12.24 | Live provider actions on disposable destinations | Blocked (external) | – | No credentials/test destinations (V1 checklist §2–5) |

## §14 Deliverables

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 14.1 | V2 docs: CHANGELOG, THREAT_MODEL, PERMISSIONS_MATRIX, USER_LIFECYCLE, MIGRATION_RUNBOOK, TEST_REPORT, REQUIREMENTS_MATRIX, IMPLEMENTATION_GAPS, FINAL_ACTIVATION_CHECKLIST | Done (untested) | `docs/V2_*.md`, `docs/PERMISSIONS_MATRIX.md`, `docs/USER_LIFECYCLE.md` | |
| 14.2 | Updated startup instructions, env template, operations guide | Partial — stream A in progress | `README.md`, `.env.example`, `docs/OPERATIONS.md` (uncommitted edits) | |
| 14.3 | Current build status | Not started | `docs/BUILD_STATUS.md` still says "V2 — queued" | Lead |

## Totals

| Status | Count |
|---|---|
| Done (tested) | 119 |
| Done (untested) | 21 |
| Partial | 9 |
| Partial — stream A in progress | 6 |
| Not started | 5 (4 optional in spec: 6.6, 8.5, 9.4, 9.11) |
| Blocked (external) | 1 |
| **Total** | **161** |
