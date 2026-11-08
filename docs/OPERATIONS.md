# Operations runbook

## Daily

- **Operations** page (`/operations`): alerts, oldest due job, outbox backlog, worker heartbeat, Unknown count, live vs simulated success with denominators.
- **Home → Needs attention**: Blocked, Unknown, Failed, Expired.
- **Accounts**: anything not Ready (expiring tokens show 7 days ahead).

## Emergency pause

UI: sidebar **Pause** (owner/admin/approver) for the workspace, brand settings for a brand, Accounts for one account.
Effect: checked at dispatch — nothing new is sent after the pause commits. A request already sending may complete. On resume, timely jobs return to Scheduled; jobs past their deadline become Expired (never flooded out).

## Expired or revoked credentials

The account shows *Reconnect required* / *Missing permission*, its queued jobs become Blocked, owners/admins are notified (deduplicated). Fix: Accounts → Reconnect. Reconnecting the **same** identity restores Blocked jobs that are still timely; a **different** identity creates a new connection (old jobs are not redirected).

## Unknown results (ambiguous publication)

Cause: the provider may have created the post but the response was lost (timeout, crash mid-send).
1. The worker checks automatically (read-only) with backoff for up to 10 checks.
2. Telegram cannot be checked automatically. Open the channel, then on the post: **Resolve → Published** (paste the link) or **Not published**.
3. Retry of an Unknown requires ticking the duplicate-risk acknowledgement; it is audited and gets exactly one attempt.

## X budget

Caps per workspace in `workspaces.limits` (`x_monthly_writes`, `x_monthly_reads`). Notifications at 50/80/100 %. At 100 % X jobs are Blocked with the reason; other channels continue. Raise the cap (SQL, owner decision) and retry the blocked deliveries.

## Incident

1. Pause the affected scope. 2. Preserve evidence: `audit_events`, `delivery_attempts`, worker logs (correlation IDs). 3. Diagnose (`/operations`, `/api/diagnostics`). 4. Reconcile Unknowns. 5. Resume; only timely jobs proceed.

## Backup and restore

Backups: managed PostgreSQL PITR (target RPO ≤ 1 h). Drill (verified locally):

```bash
./scripts/restore-drill.sh   # dump → restore into isolated DB → dispatch OFF → reconciliation list
```
After a real restore **keep dispatch disabled** (`system_flags.dispatch_enabled=false`, workers stop claiming). Reconcile every delivery in the list (scheduled/in-flight/unknown and anything published in the last 24 h) against the providers — a restored database does not know about posts sent after the backup. Then:
```sql
UPDATE system_flags SET value='true' WHERE key='dispatch_enabled';
```

## Worker

Stateless; run one or more. Restart is safe: leases expire (90 s), preparation resumes from checkpoints, mid-send work becomes Unknown. SIGTERM drains for 30 s.

## Retention (worker, hourly)

Webhook bodies 7 days · idempotency keys 24 h · OAuth states / connection flows 1 day after expiry · sessions 7 days after expiry · dispatched outbox 30 days. Disconnected credentials are deleted immediately.

## Identity, MFA and owner lockout (Keycloak)

- Sign-in is OIDC (code + PKCE + nonce) against Keycloak. The session's assurance (`acr`, `amr`, `auth_time`) comes only from the verified ID token. Privileged roles (default: owner, admin, publisher, brand manager) need two-step verification (`mfa_required_for` in the workspace security policy); sensitive actions also need a verification within `step_up_seconds` (default 300 s): **Verify now** re-authenticates at Keycloak with password + second factor (`acr_values=mfa`, `max_age=0`, `prompt=login`).
- Factors are Keycloak's: authenticator app (TOTP), passkeys (WebAuthn) and recovery codes (one-time, consumed in order). Users change them on **Security** through Keycloak application-initiated actions; removing a factor or regenerating codes needs a fresh verification first. The app's client account holds only `realm-management/view-users`: the app can list a user's factors but cannot remove anyone's MFA, and no workspace admin endpoint can.
- After a sign-in with a **recovery code**, or any completed factor change (authenticator app / passkey added or removed, recovery codes generated or removed), Relay revokes the user's other sessions, audits it (`auth.recovery_code_used` / `auth.factor_changed_followup`) and emails the user's IdP-verified address.
- Connecting, reconnecting or disconnecting an account and creating service-account keys need a fresh verification (step-up window), not just MFA.
- **Settings → Security** (owners): require two-step for everyone or for chosen roles (owners always), the re-verify window, invitation lifetime and guest access limits. Every change is audited and bumps the policy version; anything less strict needs a fresh verification.
- Service accounts belong to a named member: while that member is suspended their keys are refused; removing the member disables any service account not reassigned in the removal dialog (keys revoked, audited).
- Sessions: 30 min idle, 12 h absolute, token rotated on sign-in/step-up. **Security → Sessions** lists and revokes them; ending a user's Keycloak sessions (admin console → Users → *user* → Sessions → Sign out, or the user signing out) sends a signed back-channel logout that revokes the matching app sessions at once.
- **Owner lockout** (lost authenticator and recovery codes): handled only through the identity provider — there is no master password or bypass endpoint in Relay.
  1. Verify the person out of band (known phone/video call with a second workspace owner or the account's verified contact); record the ticket.
  2. Keycloak admin console → realm → Users → *user* → **Credentials**: delete the lost OTP/passkey/recovery credentials (password stays), then **Required user actions** → *Configure OTP*.
  3. **Sessions → Sign out** for the user (back-channel logout revokes their Relay sessions).
  4. The user signs in, enrols a new factor at Keycloak, then generates new recovery codes on **Security**. Their Activity shows the factor changes.
  5. Keycloak admin events (enabled in the realm) and the Relay audit log keep the trail; notify the workspace's other owners.
- Service-account API keys (**Settings → Service accounts**): shown once, stored as hashes, revocation is immediate; a leaked key is revoked there (or the account disabled), never edited.
