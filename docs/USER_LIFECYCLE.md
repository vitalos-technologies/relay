# User lifecycle (V2)

What the code does today, from invitation to removal. Permissions and precedence: [PERMISSIONS_MATRIX.md](PERMISSIONS_MATRIX.md). Every change below runs in one database transaction, bumps the workspace `policy_version`, and writes an audit event (actor, workspace, resource, action, safe diff, correlation ID).

```
invite ──accept──▶ active ◀──reactivate── suspended
  │                  │  ▲                     ▲
  │ expire/revoke    │  └──── grants/teams ───┘ (scope changes)
  ▼                  ▼
 dead             removed  (history kept; re-invite reactivates)
```

## 1. Identity (sign-in)

- Users are keyed by IdP **issuer + subject** (`svc/auth/users.ts`). Email must be IdP-verified (`email_verified`), else `email_not_verified`.
- Pre-provisioned users (`oidc_issuer='pending'`) are bound on their first verified login with the same email. A bound user is never re-bound: another identity with the same email gets `account_conflict`.
- Login is OIDC code + PKCE + nonce; single-use state; the attempt is bound to the starting browser. Any session cookie the browser already had is revoked (rotation).

## 2. Invitation

| Step | Behaviour (`svc/auth/invitations.ts`) |
|---|---|
| Who can invite | `members.invite` (workspace owner/admin). Inviting with sensitive roles (any preset holding a sensitive permission) needs **step-up**. |
| Contents | Email, scoped grants `[{role, scope, brand, connection}]`, optional teams, kind `member`/`guest`, inviter, expiry. Grants are ceiling-checked against the inviter (`canDelegate`). Nobody can invite an owner. |
| Expiry | Link: `security_policy.invite_ttl_hours` (default **72 h**). Guests: grants expire at `access_expires_at` — required, default **30 days**, max `guest_max_days` (90). Guest grants are brand/connection scope only. |
| Token | 32 random bytes, only SHA-256 stored, shown once (response + email). One open invitation per email per workspace (`409 already_invited`). |
| Resend | Rotates the token (old link dies), restarts expiry. Refused for a guest whose access ends within 1 h. |
| Revoke | Immediate; link shows "revoked". |
| Bulk | Each row validated separately; per-row results; idempotency key prevents replays. |
| Preview (public) | Workspace name, masked email, role summary, kind, expiry, status — no user enumeration. |

## 3. Acceptance

Two paths: the invite token travels through the OIDC login (callback accepts it), or a signed-in user opens the link (`acceptInvitationForUser` — joins another workspace without account linking).

Checks, in one row-locked transaction (concurrent accepts succeed once):
1. Not used, revoked or expired; workspace active.
2. The user is bound to a real identity whose **IdP-verified email equals the invited email** (else `email_mismatch`).
3. Guest access period not over.
4. The inviter still holds workspace owner/admin and can still delegate every grant (else `invitation_invalid`).
5. A **suspended** membership cannot be reactivated by an invite (`membership_suspended`).

Effects: membership created (or a removed one reactivated), status history row, grants upserted (missing brands/connections skipped; guest grants carry the expiry), teams joined, `accepted_issuer/subject` recorded, publication authorities revalidated.

## 4. Active member

- **Access** is recomputed from the database on every request (no permission cache): membership status, grants (direct + via teams), restrictions, then MFA/step-up.
- **MFA enrolment.** Default policy requires verified MFA for `owner`, `admin`, `publisher`, `brand_manager` on sensitive permissions (`workspace.manage`, `members.*`, `teams.manage`, `connections.manage`, `security.manage`, `service_accounts.manage`, `content.schedule/publish`, `exports.create`). Until the session has `acr=mfa` + a second-factor `amr`, those actions return `mfa_required`; other actions work.
  - Factors live in Keycloak: TOTP, passkeys (WebAuthn), recovery codes. Users manage them on **Security** via Keycloak application-initiated actions. Adding the first factor needs no step-up; adding/replacing when one exists, removing, or regenerating recovery codes needs a session that verified MFA within `step_up_seconds` (300 s).
  - A user with a factor who signed in with password only is asked for the second factor right after login. A user without any factor who hits step-up is sent to enrol first.
  - The app can only **read** factors (Keycloak `view-users`); no app endpoint changes anyone else's factors.
- **Step-up** (`acr_values=mfa`; D34: second factor only, no new email): must complete in the same session as the same subject with a fresh `auth_time`; the session token and CSRF token rotate.
- **Sessions:** 30 min idle, 12 h absolute, no refresh. **Security** lists the user's own live sessions (browser, created, last seen, assurance) and revokes one or all others. Keycloak back-channel logout revokes the app sessions bound to that IdP session.
- **Grant changes** (direct grants, restrictions, team membership, team grants) follow delegation ceilings; team managers act only on their own team within `delegation_limits` and never on themselves. Joining a team that holds grants is a privilege grant (ceiling-checked; admins adding to a publishing team need step-up).

## 5. Suspension (`suspendMember`)

- Needs `members.manage`; actor re-verified under a workspace lock; the last active owner cannot be suspended.
- Membership `status='suspended'` (reason, actor, time) + history row. Grants are kept but give nothing: every request in that workspace is denied (`suspended`). Sessions are not revoked — other workspaces keep working.
- Publications this person authorised are revalidated and **held** (§8).
- **Reactivation** restores access. Held publications stay held until someone adopts them.

## 6. Scope reduction (`reduceScope`)

Revokes the member's **direct** grants on chosen brands (actor must be able to grant them); membership stays. Access still coming from teams is reported (`still_via_teams`), not silently removed. Team removal (`removeTeamMember`) is a separate operation with the same revalidation.

## 7. Removal / offboarding (`removeMember`)

1. **Handover preview** (only brands the viewer can see): drafts, pending/assigned approvals, scheduled publications (and held ones), service accounts they own, connections they authorised, number of other workspaces, eligible reassignment candidates.
2. Optional **reassignment** to one member: drafts/assignments (brands the target can edit), pending approval assignments, scheduler authority (only where the target may schedule every destination; others skipped and counted), service-account ownership (only if the target has `service_accounts.manage`).
3. Removal: `status='removed'`; all direct grants revoked; team memberships and V1 brand grants deleted; connections they created flagged *verify or reconnect* (provider-side ownership is not transferred); pending ownership transfers involving them cancelled; their sessions stay valid but this workspace stops being their active one; history row; authorities revalidated (holds).
4. Never deleted: posts, revisions, approvals, audit events.
5. Members may remove themselves, except the last owner. Concurrent removals serialise on the workspace row.
6. Not done automatically: service accounts they own keep working unless reassigned or disabled.

## 8. Publication authority: holds and adoption (`svc/engine/authority.ts`)

- When a schedule activates, a `publication_authorizations` row records revision, destinations, brand, basis (`scheduler` or `approval`), principal + permission, approval IDs, approvers and policy version. Its scope is immutable (DB trigger).
- After any grant/membership change, and again at dispatch, the record is revalidated: the scheduler must still hold the permission on every destination, approvals must still be approved, approvers must still hold `content.approve`. Failure → record `held`, not-yet-started deliveries `blocked` (`authority_hold`). Missing record or evaluation error → held (fail closed). Already-sending deliveries finish.
- Loosening policy or re-granting **never** releases a hold. Removing only the draft author does not hold approval-based work.
- **Adoption** (**Team → Held**): a member with `content.schedule` (or `content.publish` for publish-now) on the brand and every destination — MFA policy applies — becomes the principal. Approval and approvers are revalidated; holds caused by a withdrawn approval, an unauthorised approver or a revision mismatch cannot be adopted (resubmit). Held deliveries past their publish-before deadline expire; the rest re-queue. Idempotent; recorded in `adoption_events` and audit.

## 9. Ownership transfer

1. An owner proposes (needs `workspace.transfer_owner` + step-up). One pending transfer per workspace; expires after 7 days; the target is notified in-app.
2. The target accepts with a fresh, MFA-verified session. Atomically: owner grant to the target, old owner grant revoked, old owner optionally kept as admin; owners/admins notified in-app.
3. Either side can cancel/decline. Admins cannot remove or demote an owner; ownership moves only this way.

## 10. Service accounts (`svc/service-accounts.ts`)

| Stage | Behaviour |
|---|---|
| Create | Owner/admin (`service_accounts.manage`) with MFA + step-up. Name, named owner (active member), one brand, role `integration` (default, draft-only) / `viewer` / `editor`, optional expiry ≤ 1 year. |
| Keys | `sl_live_<prefix>_<secret>`, shown once, SHA-256 stored; max 5 active per account; new key or rotation needs step-up; rotation revokes the old key and links it (`rotated_from`). |
| Use | Machine API (`/api/v1/*`) authenticates by key; `last_used_at` updated (1 min resolution). Revoked/expired keys and disabled/expired accounts fail on the next request. |
| Revoke / disable | Revoke: immediate, no step-up. Disable: revokes all keys and grants. The TipSignal account is unbound in Integrations instead. |
| Offboarding | Listed in the owner's handover preview; ownership can be reassigned. |

TipSignal: migration 010 turned the V1 "acting member" binding into a `TipSignal` service account (owner = former acting member) with an `integration` grant on the bound brand.
