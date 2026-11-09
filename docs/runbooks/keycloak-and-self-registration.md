# Identity provider (Keycloak), sign-in and self-registration

Audience: operators. Repo only. Reviewed 2026-11-09 (product 2026-11). Reference realm:
`infra/keycloak/social-lite-realm.json` (local, disposable). Background: `docs/OPERATIONS.md` (identity section),
`content/help/developers/authentication-and-authorization.md`.

**Affected resources:** the identity provider realm (users, credentials, clients, sessions, events), Relay `users`,
`sessions`, `memberships`, `workspaces`, trials (`billing_trial_redemptions`).

## How sign-up works

1. Marketing "Start free trial" → `/signup?plan=standard|professional` → sign in or **register** at the identity
   provider (the reference realm allows self-registration with email as username, requires email verification and
   has brute-force protection).
2. After the first verified sign-in, a person without memberships can create a workspace. In production this is
   allowed only while no workspace exists (bootstrap) or when `ALLOW_SELF_SERVE_WORKSPACES=true`.
3. Creating the workspace from signup starts its one 14-day no-card trial on the chosen plan, in the same transaction.
   At most one trial per workspace, ever; only an audited staff extension changes its end.

The plan name in the URL only selects which public plan to trial; it never grants anything by itself.

## Symptoms

| Symptom | Likely cause |
|---|---|
| Login page shows `error=rate_limited` | More than 20 sign-in starts per minute from one IP |
| `error=not_configured` | `OIDC_*` settings missing |
| `error=idp_unavailable` / `login_failed` | Identity provider unreachable, wrong issuer, clock skew, or a callback/state problem (expired after 10 minutes, different browser) |
| Signed in, but "You are not a member of any workspace yet" and no create option | Production with workspaces already present and `ALLOW_SELF_SERVE_WORKSPACES` not `true` |
| Person cannot complete a sensitive action | Their role requires two-step verification and they have no second factor, or the step-up window passed |
| Owner lost authenticator and recovery codes | Owner lockout (below) |
| Wave of new accounts or trials | Self-registration abuse (below) |

## Diagnostics (READ-ONLY)

- Web log: `oidc_login_start_failed`, `oidc_callback_failed` with the correlation id.
- Identity provider login and admin events (enabled in the reference realm): failed logins, registrations, required
  actions, admin changes.
- `SELECT id, email, oidc_issuer, disabled_at, created_at FROM users WHERE email ILIKE '<address>';`
- New workspaces and trials per day:
  ```sql
  SELECT date_trunc('day', created_at) d, count(*) FROM workspaces WHERE NOT is_demo GROUP BY 1 ORDER BY 1 DESC LIMIT 14;
  ```

## Corrective actions

### Identity provider outage or misconfiguration

Existing Relay sessions keep working (sessions are Relay's own); new sign-ins and step-ups fail. Restore the identity
provider; confirm `OIDC_ISSUER` matches its discovery `issuer` exactly; check server clocks.

### Owner lockout (lost second factor and recovery codes)

There is no master password or bypass in Relay.

1. Verify the person out of band (known phone or video call with a second workspace owner or the account's verified
   contact). Record the ticket.
2. **CHANGES DATA** Identity provider admin console → realm → Users → the user → Credentials: delete the lost OTP,
   passkey and recovery-code credentials (the password stays); set the required action "Configure OTP".
3. Users → the user → Sessions → Sign out. The back-channel logout revokes their Relay sessions immediately.
4. The person signs in, enrols a new factor, then generates new recovery codes on the Security page. Relay audits the
   factor changes, revokes other sessions and emails the person.
5. Tell the workspace's other owners.

### Self-registration abuse

1. Check registration events and new workspaces per day.
2. Options, smallest first:
   - block abusive sources at the edge (reverse proxy / WAF);
   - require stronger registration checks at the identity provider (for example a CAPTCHA or domain restrictions);
   - **CHANGES DATA** turn self-registration off at the identity provider (realm → Login → User registration off);
     the marketing signup then only works for invited people and existing accounts;
   - set `ALLOW_SELF_SERVE_WORKSPACES` to anything other than `true` and restart web: new self-serve workspaces stop
     (existing ones are unaffected).
3. Suspend abusive accounts (`/admin/platform/accounts` → Suspend: blocks sign-in, ends sessions) and abusive workspaces
   (`/admin/platform/workspaces/<id>` → Suspend). Do not delete them while investigating.

### MFA enrolment problems

Factors (authenticator app, passkeys, recovery codes) are managed at the identity provider through application-initiated
actions from the Relay Security page. The Relay client account can only read factors (`view-users`); it cannot remove
anyone's factor. Use the identity provider console for exceptional cases, with the same out-of-band verification as
for lockout.

## Verification

- Sign-in completes and lands in the app; `/api/session` returns the user; step-up works for a privileged action;
  registration events return to normal.

## Escalation

Identity provider compromise, unexpected admin events, or many lockouts at once: incident lead
([key-rotation-and-security-incidents.md](key-rotation-and-security-incidents.md)).
