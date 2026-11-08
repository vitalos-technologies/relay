# V2 changelog (V1.1 → V2)

Relay — *Create. Coordinate. Publish.* User- and admin-visible changes only. Status of each item: [V2_REQUIREMENTS_MATRIX.md](V2_REQUIREMENTS_MATRIX.md); open work: [V2_IMPLEMENTATION_GAPS.md](V2_IMPLEMENTATION_GAPS.md).

## Identity & security

- **Sign-in provider (local):** Keycloak 26.4 replaces Dex. Production still uses any OIDC provider; factor management on **Security** needs Keycloak.
- **Two-step verification** through the IdP: authenticator app (TOTP), passkeys (WebAuthn), recovery codes. Relay never stores factors.
- **MFA required by default** for owners, admins, publishers and brand managers on sensitive actions (members, teams, connections, security, service accounts, scheduling/publishing, exports). Without MFA in the current session those actions answer `mfa_required`; everything else works.
- **Step-up** (re-enter password + second factor; valid 5 min) for ownership transfer, granting/inviting sensitive roles, changing sign-in methods, regenerating recovery codes, creating service accounts or keys, and weakening an approval policy.
- **Sessions:** idle timeout 2 h → **30 min**; 12 h absolute unchanged; token and CSRF token rotate on sign-in and step-up. Assurance comes only from the verified ID token.
- **Security page (new):** assurance, sign-in methods, live sessions (browser, last seen) with revoke one / revoke all others, recent security events. No IP-based location.
- **IdP logout:** signing a user out in Keycloak ends their Relay sessions (back-channel logout).
- **Service accounts (new):** workspace-owned machine principals with a named owner, one brand, expiry and API keys (shown once, hashed, rotate/revoke). Machine API under `/api/v1`.
- **Headers:** nonce-based Content-Security-Policy on every page, `default-src 'none'` on API responses, HSTS in production (V1.1 sent only `X-Frame-Options`).

## Tenancy & access

- **Permissions model:** V1's five workspace roles become **scoped grants** of 12 presets (owner, admin, team manager, brand manager, editor, approver, publisher, analyst, viewer, exporter, guest, integration) on a workspace, brand or single connection. People can hold several; access is their union.
- **Precedence:** suspended/removed → explicit restriction (deny) → MFA/step-up → grants → default deny. Every decision carries a reason and policy version.
- **Behaviour changes from V1.1:**
  - Approvers can no longer schedule, and the brand's "editors can publish" switch no longer grants anything. Both need an explicit **publisher** grant (migration 009 lists affected brands/users for review; nothing is granted automatically).
  - Only owners can grant admin; nobody grants owner — ownership moves only by transfer. Other grants are limited to what the granting person holds.
- **Teams (new):** team directory, team grants on brands, team managers with a delegation ceiling (roles + brands they may grant). Joining a team with grants is treated as a privilege grant.
- **Restrictions (new):** explicit deny of actions for a member on a brand or the workspace.
- **Effective access (new):** per member — brands, connections, actions, the grant (direct or team) behind each, and expiry.
- **Invitations:** expiry 7 days → **72 h**; carry scoped grants and teams; resend rotates the link; bulk invite with per-row results; guest invitations with required access end date (default 30 days, max 90).
- **Guests (new):** client reviewers see only review requests explicitly shared with them, in a separate review portal.
- **Member lifecycle:** suspend / reactivate, scope reduction and team removal are separate from removal. Removal shows a handover preview and can reassign drafts, approvals, scheduled authority and service-account ownership; it keeps history and leaves the person's sessions and other workspaces untouched.
- **Queued posts after access changes:** posts scheduled by someone who loses publishing rights (or whose approver loses approval rights) are **held**, not sent and not cancelled. **Team → Held** lets an authorised publisher adopt them. Re-granting access never releases a hold.
- **Ownership transfer:** two steps — owner proposes (step-up), new owner accepts (fresh MFA); previous owner can stay admin.
- **Connections** set up by a departing member are flagged *verify or reconnect*.
- **Workspace switching** clears client caches and reloads other open tabs; requests from a tab showing the old workspace are refused.
- **TipSignal** runs as a draft-only service account instead of a human "acting member".

## Collaboration

- **Campaigns, assignees and due dates** on posts (brand-scoped).
- **Version history** for drafts; a save that loses a concurrent-edit race is kept as a recoverable **conflict copy**.
- **Comments:** internal notes vs comments shared with guests; @mentions notify only people who can see the post.
- **Approval policies per brand:** none, one or two sequential stages; quorum of distinct people; eligible roles/teams; optional guest stage; optional separation of duties (authors can't approve). V1.1's single "approval required" switch maps to one stage with quorum 1. Any change to text, media, destinations, links, time or policy invalidates approvals. Weakening a policy needs step-up and never releases blocked posts.
- **Approval inbox** grouped by brand, assignee or due date with exact outgoing previews.
- **Notifications:** per-event in-app/email/daily-digest preferences, quiet hours (security alerts bypass them), minimal email content, access re-checked before each send.
- **Planner** shows team, assignee and review state.

## Product & fairness

- **Account health centre:** disconnected, expiring, revoked, missing-scope, throttled connections with the fix and affected upcoming posts.
- **Publishing readiness** check before scheduling (permissions, tokens, scopes, media, approval, deadline, provider limits, budget).
- **Duplicate warning** for similar text or media to the same destination within a brand window (default 24 h); warns, never blocks.
- **Budgets:** per-workspace and per-team caps for AI tokens, X reads/writes, storage and exports, with atomic reservations.
- **Fair dispatch:** per-workspace concurrency cap and round-robin claiming so one bulk campaign cannot starve other workspaces.
- **Activity centre:** filter audit events by category/brand/actor; CSV export (needs export + audit permissions; formula-injection safe).
- **Client handover export:** one brand's content, revisions, history and asset links as a ZIP.

## Operations

- **Database roles:** `socialite_app` (web), `socialite_worker` (worker) and `socialite_migrator` (DDL) replace a single owner connection; audit log is append-only for app roles. New env vars `MIGRATOR_DATABASE_URL`, `WORKER_DATABASE_URL`, `DATABASE_ADMIN_URL`; `pnpm db:roles`.
- **Migrations 009–013** (additive, with V1 backfill and review items) — see [V2_MIGRATION_RUNBOOK.md](V2_MIGRATION_RUNBOOK.md).
- **Worker:** new sweeps for expired budget reservations and deferred/digest notification emails; dispatch gate revalidates publication authority.
- **CI:** Keycloak + Mailpit in integration tests, secret scan (`scripts/secret-scan.sh`), `pnpm audit --prod`.
- **IdP configuration** documented in `docs/DEPLOYMENT.md`; owner-lockout procedure in `docs/OPERATIONS.md`.
