# Social Lite V2 — Autonomous Security and Multi-Team Upgrade Prompt

Version 2.0 • 7 November 2026

Use this as the next coding-agent prompt in the Social Lite repository. It replaces the V1 execution prompt for this upgrade and preserves the original product specification unless explicitly changed below. V1 implementation has not been inspected in preparing this prompt; the executing agent must establish its real state first. This is an implementation brief, not evidence that any security controls are already present.

---

You are the autonomous engineering lead for **Social Lite V2**, a lightweight publishing application for **Instagram, Facebook Pages, Telegram channels and X/Twitter**.

Upgrade the existing application into a secure platform where multiple teams, brands, clients and contractors can collaborate without inappropriate access or accidental publication. Implement, test, repair, document and package the work. Do not stop at an audit or plan. Do not replace a sound implementation with a new scaffold.

Use the original Social Lite specification as a baseline if available. This V2 prompt changes team permissions, approval workflows, offboarding and security requirements; those V2 rules take precedence over the corresponding V1 rules. Preserve existing working publishing, scheduling, account connections and UI. If V1 is incomplete, implement missing prerequisites before dependent V2 features and report their actual status.

Continue the autonomous workflow: make routine decisions without asking me, use parallel agents if available, and gather missing external configuration into one final activation checklist. Aim for one intensive 24-hour upgrade sprint, but do not pretend an unverified security or multi-tenant system is complete because a deadline elapsed. Prioritize security and isolation over extra features. Finish independent work when credentials or services are unavailable.

## 1. Authority, scope and initial inspection

You may inspect and modify this project's code, install dependencies, create isolated local services, write and test migrations, run tests, fix defects, use local browser QA, create commits and prepare deployment artifacts without intermediate approval. Use only resources assigned to this project. Preserve unrelated user changes and existing data. Do not print or commit secrets.

Do not invent cloud access, spend limits, provider approvals or successful live tests. Deploy only to an already-authorized target; otherwise deliver a reproducible local deployment. Use explicitly designated test accounts for live social canaries. Do not repurpose other Vitalos/TipSignal production databases or overwrite an existing Telegram webhook. Respect runtime permission denials and continue through allowed alternatives.

First inspect repository instructions, architecture, schema, authentication/session code, authorization, workers, providers, tests and deployment state. Establish baseline build/test results. Create a requirement-to-code-and-test matrix. Classify existing components as working, partial, missing or unsafe, with evidence.

Document a compact threat model: tenants, teams, guests, authenticated attackers, compromised sessions, malicious uploads, provider tokens, background jobs and privileged operators. Identify trust boundaries, high-impact actions and current gaps. Implement corrections immediately after recording them; do not spend the day generating audit prose.

Use the current maintained stack where sensible. Default to a TypeScript modular monolith, PostgreSQL, private object storage and separate web/worker processes if foundations are missing. Do not add Kubernetes or separate microservices merely to support teams.

## 2. Product hierarchy and tenant boundaries

Adopt this explicit hierarchy:

- **User:** a person identified by trusted identity-provider issuer and subject, not by editable email alone.
- **Workspace:** the organisation/security tenant. A user can belong to several workspaces with different permissions.
- **Team:** a group of workspace members. A team never spans workspaces.
- **Brand:** the content/account boundary inside a workspace. Multiple teams can work on the same brand through explicit assignments.
- **Connection:** an Instagram, Facebook, Telegram or X destination owned by a brand.
- **Campaign/post/asset:** brand-scoped resources; connections never infer permissions for the entire workspace.

A separate client workspace gives the strongest organisational boundary. For agency use inside one workspace, brand-scoped client access is supported, but workspace owners/admins retain administrative visibility; say this clearly. Do not claim a brand is isolated from its own workspace administrators.

Example seed: one agency workspace, Editorial and Publishing teams, two demo brands and a guest reviewer assigned only to Brand A. A second workspace belongs to a separate synthetic organisation. Demonstrate that Brand A's guest cannot see Brand B or the other workspace, while both assigned teams can collaborate on Brand A.

A user switching workspaces must not carry cached permissions, search results, drafts, notification counts or assets from the previous workspace. Clear or correctly namespace client caches. Server endpoints independently validate the selected workspace and membership; a supplied workspace ID or header is not proof of authority.

## 3. Authorization model — implement centrally

Use explicit permission grants constrained by workspace, brand and where necessary connection. Deny by default. Enforce the same policy in API endpoints, server actions, exports, storage access, websocket subscriptions and workers. UI hiding is convenience, not authorization.

Proposed permission identifiers:

```text
workspace.read, workspace.manage, workspace.transfer_owner
members.read, members.invite, members.manage
teams.read, teams.manage
brands.read, brands.manage
connections.read, connections.manage
content.read, content.create, content.edit, content.archive
content.submit, content.approve, content.schedule, content.publish
publishing.pause, publishing.resume, publishing.retry
assets.read, assets.upload, assets.manage
analytics.read, exports.create
audit.read, security.manage, service_accounts.manage
```

### Role presets

| Role | Default authority | Explicit limit |
|---|---|---|
| Workspace owner | Workspace administration, ownership and security | Cannot silently bypass required editorial policy |
| Workspace admin | Users, teams, brands and operational configuration | Cannot remove/transfer last owner or read stored token values |
| Team manager | Manage assigned team membership within delegated authority | Cannot grant roles, brands or permissions they cannot delegate |
| Brand manager | Manage assigned brand's content and workflow | No other-brand or workspace administration |
| Creator/editor | Draft, edit, upload and submit on assigned brands | No approval, scheduling or publishing by default |
| Approver | Review and approve assigned brand content | Approval does not grant publishing or account management |
| Publisher | Schedule/publish valid approved revisions on assigned destinations | Cannot rewrite content and preserve its approval |
| Analyst/viewer | Read allowed content and analytics | Export is a separate grant; no mutations |
| Guest/client reviewer | View/comment/approve specifically shared resources | No general brand library, account details or internal notes |

Allow people to hold multiple scoped roles; use preset roles for V2 rather than building an arbitrary policy language. Compute effective permissions as the union of valid scoped grants, restricted by mandatory workspace/brand policies and current membership status. Suspension, expired guest grants and explicit deny/restriction rules override allows. Document this precedence and test it.

Keep team membership separate from authorization grants. A team manager may add a member only within a documented delegation ceiling; adding someone to a publishing team is a privilege grant, not an innocent directory edit. An invite or role update cannot grant more authority than the actor is allowed to delegate. Prevent self-escalation, mass-assignment of role fields and cross-workspace team IDs.

Provide an **Effective access** view: user, allowed brands/connections, actions, source of each grant and expiry. Access checks use a common service such as `authorize(subject, action, resource, context)`; its output includes a safe reason code and policy version. Do not reveal private resource existence through error messages.

## 4. User lifecycle and team management

Implement user/team administration screens with search, filters, current role, team, brand grants, status, invite state, expiry and last sign-in metadata only where available.

### Invitations and membership

- Invitations contain workspace, intended verified email, scoped roles, inviting actor and expiry. Default expiry: 72 hours; configurable.
- Use cryptographically random, single-use tokens stored as hashes; resend invalidates the old token. Expiry/revocation/acceptance are atomic.
- Acceptance requires authentication with the intended verified identity. Do not accept a different user's invitation because they possess its URL.
- An existing user can join another workspace without linking accounts solely by matching an unverified email claim.
- Adding a member is an audited, server-authorized operation. Bulk invites validate each row, produce per-item results and resist duplicate actions.
- Guest/contractor grants have a required expiration date; default 30 days. Expiry is enforced at access time as well as by a cleanup job.
- Avoid public user enumeration in invitation, login and recovery responses.

### Removal, suspension and handover

- Support workspace removal, temporary suspension, team removal and scope reduction as distinct operations.
- Revoke workspace access immediately in application policy, invalidate applicable permission caches, disconnect live subscriptions and prevent already-open tabs from continuing to mutate data.
- A global identity session may serve other workspaces; removing membership must not unnecessarily log the person out of all unrelated organisations. Sensitive global account compromise is handled separately.
- Show a handover preview: drafts, assigned tasks, pending approvals, scheduled publications and integration ownership affected. Reassign to an authorized member without exposing unrelated brands.
- Never delete historical posts or audit records just because their author left.
- Preserve the last active owner. Ownership transfer requires fresh authentication and acceptance by the new owner, with atomic state changes and notifications.
- Social-account authorization may depend on a departing person's provider access. Flag the connection for verification/reconnect; never claim a local reassignment transfers provider ownership.

### Queued publication after permission changes

Make the policy explicit and override the vague V1 behaviour:

1. At scheduling, record the immutable revision, policy version, approval IDs, scheduling authority and intended workspace/brand/destinations.
2. At dispatch, revalidate current workspace/brand policy, connection authority and mandatory approvals, including whether required approvers remain authorized.
3. Default on removal/suspension of the scheduling authority: hold their not-yet-dispatched jobs for an authorized publisher to adopt/revalidate. Do not silently cancel or blindly continue.
4. Removing a draft author alone does not invalidate independently approved/scheduled work unless a policy or explicit offboarding choice requires it.
5. Policy tightening holds affected queued work; policy loosening never auto-publishes previously blocked work.
6. Already in-flight external calls may complete. Report that boundary honestly and reconcile the outcome.

## 5. Authentication, MFA, sessions and recovery

Use the maintained identity provider/established authentication library already present. Implement MFA with its supported mechanisms rather than custom cryptographic protocols. Support TOTP and/or passkeys when the selected provider supports them; never represent an unsupported factor as implemented.

Default workspace policy: require verified MFA for owners, admins, publishers and security/account managers. Allow requiring it for all members. During enrollment, sensitive workspace actions remain unavailable until the requirement is met. Keep current factor assurance in server-trusted session state; do not trust a client boolean or mere existence of an enrolled factor.

Require fresh authentication and verified MFA/appropriate identity assurance for ownership transfer, sensitive role grants, factor removal/replacement, recovery-code regeneration, social credential changes, service-account key creation and security-policy weakening. Suggested freshness window: five minutes; configurable. Define and test supported OIDC `acr`/`amr` or provider equivalents.

Provide a security page with session list, device/browser metadata, approximate location only if legitimately available, last activity and revoke actions. Do not invent precise location. Implement session rotation, secure cookies, CSRF protection and server-side invalidation checks. Proposed defaults: 30-minute idle timeout and 12-hour absolute session lifetime, with explicit refresh/remember-device policy and step-up for sensitive actions.

Recovery must work end to end:

- Use provider-managed recovery where supported. If implementing application recovery codes, use high-entropy one-time values, store only hashes, show them once and atomically consume a code.
- Regeneration invalidates old codes; recovery and factor changes notify the user through a verified channel.
- Do not let a workspace admin remove another user's global MFA through an ordinary member-management endpoint.
- Do not make email-only recovery an unexamined bypass of privileged MFA. Use an explicitly documented provider recovery process; audit, notify and revoke sessions after sensitive recovery.
- Provide a documented owner-lockout procedure using the identity provider's supported recovery route; no hard-coded master password or hidden bypass endpoint.

Test actual enrollment, verification, factor change/removal, recovery-code reuse prevention and session revocation. A nonfunctional security button is a release defect.

## 6. Collaboration and editorial control

Implement campaigns, assignees, due dates, internal comments, mentions, review requests, version history and notification preferences. Keep this lightweight; no full project-management suite.

Use optimistic concurrency with expected versions for draft saves and workflow changes. Show a recoverable conflict instead of overwriting another editor's work. Presence indicators or an expiring advisory edit lease are useful, but they do not replace server concurrency controls. Rich CRDT collaborative editing is deferred unless already present.

Brand policies may require no approval, one stage or two sequential stages (for example internal review then client review). Optional quorum must count distinct currently eligible people; a user belonging to two teams counts once. If separation of duties is enabled, an author/editor of the revision cannot satisfy its required independent approval. Required review cannot be bypassed by possessing a separate publisher role.

Approval binds revision, asset versions, destinations, links, schedule and policy generation. Any relevant change invalidates it. A new reviewer never silently inherits the previous reviewer's approval. Disabling approval policy must be a privileged, fresh-authenticated, audited change and must not automatically release blocked publications.

Client reviews use authenticated, resource-scoped guest access for V2. Do not make anonymous bearer links the default. Shared comments and internal notes are separate types with explicit visibility; test that guests cannot retrieve internal notes through APIs, notifications or exports.

Mentions notify only people entitled to the resource at send time. Deep links recheck access on open. Notification emails should contain minimal sensitive content because emails cannot be revoked after access changes. Recheck recipient permissions for delayed/batched notifications.

Notify once per actionable event; provide daily digest and quiet hours, with critical security alerts handled separately. Notification clicking never approves or publishes by itself.

## 7. Additional V2 product improvements

Implement these after isolation and user lifecycle are passing:

| Improvement | Required behaviour |
|---|---|
| Account health centre | Explain disconnected, expiring, missing-scope and revoked connections; identify affected schedules |
| Approval inbox | Group work by brand/assignee/due date; preview exact outgoing variants |
| Publishing readiness | Preflight tokens, permissions, media, policy, deadline, provider limits and budget |
| Duplicate/collision warning | Flag similar content to the same destination in a configurable window; do not confuse this warning with delivery idempotency |
| Calendar ownership | Show team, assignee and review state without exposing inaccessible brands |
| Usage and limits | Per-workspace/team budgets for AI, storage, exports and provider calls; atomic reservations under concurrency |
| Fair scheduling | Per-workspace/account concurrency and rate limits so one bulk campaign cannot starve others |
| Service accounts | Scoped machine identity for TipSignal ingestion; no human owner token embedded in scripts |
| Activity/security centre | Filter audit events, permission changes, connection changes and publishing actions |
| Client handover | Export scoped content/history and transfer responsibilities with explicit permissions |

Keep operational analytics truthful. Unsupported provider metrics are unavailable, not zero. AI assistance stays draft-only unless a separately explicit automation policy permits more. AI retrieval, prompt context, generated assets and tool calls must stay inside the authorized workspace/brand. Recheck authority when a proposed action is applied, not just when AI generated it.

Do not add full billing, enterprise SAML/SCIM, broad social listening, custom role programming or a cross-platform DM inbox in this sprint. Leave clean interfaces where needed, and document them as deferred rather than functional.

## 8. Service accounts, integrations and credential handling

Service accounts are workspace-owned, brand-scoped principals with named owners, expiry, last-used metadata and explicit actions. Default TipSignal integration permission is create draft on one brand, not publish, manage members or read all content.

Application-issued high-entropy API keys are shown once and stored as hashes. Provider refresh/access tokens must remain decryptable for API use and are encrypted instead; do not confuse the two storage requirements. Support key rotation/revocation without losing audit attribution. Reject revoked keys immediately; never log full secrets.

Incoming webhooks require the provider's correct signature or secret validation, replay/deduplication controls and payload size limits. Tenant identity derives from the registered integration, not an untrusted payload field. Outgoing custom webhooks are optional; if implemented, enforce SSRF controls, per-destination signing, secret rotation, bounded retries and redacted diagnostics.

Credential rotation must be versioned and recoverable. Persist key versions, support reading old encrypted records during controlled rotation and test backup restoration with the needed keys. Secrets are never returned to owners/admins after storage; reconnect/replace is supported instead.

## 9. Isolation and application hardening

Apply tenant scoping beyond ordinary CRUD: list/search, joins, caches, queue payloads, retries, exports, metrics, object keys, preview endpoints, webhooks, notification batches and AI context. Foreign-key relationships must prevent a Brand A post referencing Brand B credentials or assets unless a deliberately implemented sharing operation authorizes a copy.

Use separate least-privilege database roles for application, worker and migrations. Do not run normal application queries as a database superuser. If adding PostgreSQL row-level security, test it with the actual pooling model and use transaction-local context; never rely on connection session variables leaking safely across requests. RLS is defence in depth, not a substitute for brand/action authorization.

Scope signed download URLs to the asset and TTL. Revoking membership cannot revoke a previously issued ordinary presigned URL immediately: use short TTLs, acknowledge the residual window and proxy highly sensitive downloads through current authorization when required. Provider-fetch URLs are a separate narrowly scoped use case with sufficient processing TTL.

Implement hardened content rendering, upload validation/quarantine, safe exports against CSV formula injection, resource quotas, SSRF protection, secure CORS/CSP/cookie settings and appropriate request rate limits. Use a real CSP compatible with the app instead of breaking auth/uploads. Ensure error pages and telemetry never serialize credentials or private draft content by default.

Audit security-sensitive changes with actor, workspace, resource, action, safe before/after values, timestamp, result and correlation ID. Operational audit storage should be append-only for application roles. Hash chains may reveal changes but do not make a database administrator unable to rewrite history; document the threat boundary. If stronger tamper resistance is needed, use a separately controlled immutable sink and state whether it was actually configured.

Platform support/operator access is separate from customer workspace roles. Default to no content impersonation. If support access exists, require explicit time-bounded audited grants, reason and visible scope; never add a global silent impersonation feature.

Run dependency, secret and static security scans using available tools. Triage reachable risks and repair them. Do not ignore findings wholesale, remove checks, or claim independent penetration testing/certification from automated scan results.

## 10. Data model and migration requirements

Extend the existing schema; use compatible migrations and avoid duplicate concepts. Suggested additions:

```text
teams, team_memberships
scoped_role_grants, delegation_limits
invitations, guest_grants
membership_status_history, access_policy_versions
campaigns, assignments, comments, mentions
approval_policies, approval_stages, approval_decisions
publication_authorizations, adoption_events
service_accounts, api_key_hashes
notification_preferences, security_events
usage_budgets, usage_reservations
```

Identity-provider-owned sessions/factors should not be reimplemented in parallel tables unless the application needs minimal references. Store trusted subject/issuer mappings. Use composite tenant constraints, unique memberships/invitation consumption, immutable approval evidence and indexes for membership/policy lookup and bounded lists.

Migration sequence: inspect and back up applicable data; add new structures; backfill known V1 workspace roles without broadening brand access; mark ambiguous legacy permissions/schedules for review; verify counts and invariants; enable new policy checks; remove obsolete paths only after compatibility verification. Rehearse on a disposable copy first.

Do not infer that every legacy user should become workspace admin. Newly required MFA must use an explicit enrollment transition without granting sensitive actions during enrollment. Avoid running two publishing schedulers against the same live queue during rollout. Document worker drainage, schema compatibility and application rollback. A restored database starts with dispatch paused pending reconciliation.

## 11. Required UI and API changes

Add real, usable screens for:

- Workspace switcher and teams directory.
- Members/invitations with effective access and scoped roles.
- Brand/team assignment and delegated membership management.
- My security: MFA, recovery and sessions.
- Guest/client review portal with shared-only content.
- Approval policy builder limited to the supported stages/quorum.
- Activity/security log with permitted export.
- Service accounts, usage controls and connection health.
- Offboarding preview, reassignment and queued-publication adoption.

Use existing API conventions. Every new mutation validates actor, resource scope, expected version and relevant step-up assurance. Create/revoke/invite/approve/adopt operations must be idempotent where needed. Do not accept trusted roles, tenant IDs, current authentication assurance or audit actor directly from client fields.

Provide accessible desktop and mobile layouts with conflict, expired invite, revoked session, denied access, incomplete MFA and empty states. Never show a success toast before the server transaction commits.

## 12. Test fixtures and release gates

Create at least two workspaces, two brands in one workspace, two teams sharing one brand, another team with different access, owner/admin/editor/approver/publisher/viewer users, an expired guest and a service account. Use these in real database integration tests and browser workflows.

Mandatory negative and race cases:

1. Cross-workspace and cross-brand ID substitution in API, search, export, media and job paths is denied.
2. A team manager cannot add themselves/others to roles outside their delegation ceiling.
3. Combined team grants calculate correctly; suspension/expiry/denies override allows.
4. An invite is unusable after expiry, revocation, resend or first acceptance; concurrent acceptance succeeds once.
5. A different verified identity cannot accept an email-bound invite.
6. Removing a user blocks subsequent requests from existing tabs and live subscriptions; cached permissions do not survive.
7. Offboarding preserves other workspaces, historical content and appropriate queued-work holds/adoption.
8. Last owner cannot be removed, including concurrent removals; ownership transfer needs acceptance and fresh assurance.
9. MFA recovery/removal cannot be used as an admin or email-only privilege bypass; reuse of a recovery code fails atomically.
10. Step-up freshness and session revocation are enforced server-side.
11. Concurrent draft saves show a conflict without losing either revision.
12. Authors cannot approve their own revision under separation of duties; duplicate team membership cannot satisfy quorum twice.
13. Content/time/media/destination changes invalidate approvals; revoked approver authority holds required jobs.
14. Guests cannot read internal notes, unrelated posts or notifications, even via API/export/deep link.
15. Scoped service keys cannot publish or access another brand; expired/revoked keys fail.
16. Workspace switching cannot leak cached content or subscribe to old private channels.
17. Background dispatch honors new policy, suspension, pause, deadline and adoption rules.
18. Budget reservations and provider throttles work under concurrent workers; tenants receive fair dispatch.
19. Logs/exports do not expose secrets; CSV injection and upload/SSRF cases are handled.
20. V1 publish/schedule/partial-success/retry/restart behaviour remains correct for all four providers.
21. Migration and rollback rehearsals preserve data and do not replay already published jobs.
22. Authorization failures/policy-service outages fail closed; no fallback to an owner role.

Run unit, real PostgreSQL integration, adapter contract, browser and production build checks. Capture commands and outcomes. Test mobile keyboard/accessibility workflows and actual security UI buttons. Test live provider actions only where authorized access and disposable destinations exist. Test fixtures never count as live proof.

Release gates: no unresolved demonstrated cross-tenant access, privilege escalation, credential exposure, approval bypass or duplicate-publication regression. A failed gate prevents declaring production readiness, but must not stop independent fixes or packaging. Present implemented/locally verified/live verified/awaiting activation/incomplete separately.

## 13. Autonomous execution and delivery order

Use the same no-routine-questions policy as V1. Detect missing credentials early, implement against explicit test transports, and gather required external inputs at the end. Real connections must not fall back to fake success. Local OIDC/email/object-storage/PostgreSQL services allow most functionality to be verified without production accounts.

If subagents are supported, assign bounded owners:

1. Lead: architecture, shared authorization contracts, integration and final verification.
2. Identity/security: sessions, MFA, recovery and scoped service identities.
3. Tenancy/data: teams, grants, migrations, revocation and worker authority.
4. Collaboration/UI: invites, reviews, concurrent editing, handover and guest experience.
5. QA/reliability: adversarial tests, publishing regression, deployment and evidence.

Set contracts and migration ownership before parallel edits. Independently review agent results. Preserve the modular architecture and integrate small slices frequently.

Suggested sequence for a 24-hour target:

| Window | Outcome |
|---|---|
| 0–2 hours | Baseline, threat model, real gaps, permissions matrix and migration design |
| 2–7 hours | Tenant/team model, policy enforcement, invitations and access tests |
| 7–12 hours | MFA/session/recovery, offboarding and queued authority |
| 12–16 hours | Reviews, guest access, conflict handling and administration UI |
| 16–19 hours | Service accounts, budgets, account health and audit |
| 19–24 hours | Regression/adversarial tests, fixes, migration rehearsal, packaging and final activation |

This is a target allocation, not evidence of feasibility for an unknown V1. Do not quietly drop core security tests to fit it. Record genuine unfinished work if a runtime/deadline is reached, leave a resumable checkpoint and never claim it is merely configuration.

## 14. Required deliverables and final handoff

Deliver working code, migrations, UI, tests, deployment changes and:

- `docs/V2_CHANGELOG.md`: actual before/after behaviour.
- `docs/V2_THREAT_MODEL.md`: threats, controls, evidence and residual risks.
- `docs/PERMISSIONS_MATRIX.md`: action/role/scope/delegation/deny precedence.
- `docs/USER_LIFECYCLE.md`: invite, enroll, join, suspend, remove, handover and recover.
- `docs/V2_MIGRATION_RUNBOOK.md`: backfill, worker coordination, validation and rollback.
- `docs/V2_TEST_REPORT.md`: executed results, failures and not-run checks.
- `docs/V2_REQUIREMENTS_MATRIX.md`: requirement mapped to source and evidence.
- `docs/V2_IMPLEMENTATION_GAPS.md`: unfinished engineering only.
- `docs/V2_FINAL_ACTIVATION_CHECKLIST.md`: external inputs only, collected at the end.
- Updated startup instructions, environment template, operations guide and current build status.

For each activation item name the missing setting/service/access, exact place to configure it, safe verification step and affected feature. Include identity-provider MFA/passkey support, production email, encryption-key custody, provider scopes and authorized deployment target only where actually missing. Do not request secret values in chat. Do not list “implement authorization” or “finish MFA UI” as configuration.

Final response: working location/startup; summary of security and collaboration changes; test/migration evidence; four-provider regression status; exact implementation gaps; one consolidated activation checklist. Be explicit that automated tests are not a security certification.

Start now. Inspect, implement, integrate, verify and repair without intermediate approval requests. Missing external dependencies should leave a tested configuration boundary, not an abandoned project.

---

## Design references for the implementing agent

Consult current official guidance and the chosen identity provider's documentation. These sources support the general security principles; the concrete product roles, defaults, workflow and sprint plan above are proposed design decisions, not quotations or a compliance certification.

- OWASP Authorization Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html — default denial and request-by-request permission enforcement.
- OWASP Multifactor Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html — factor lifecycle and recovery considerations.
- OWASP Multi-Tenant Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html — tenant context and isolation beyond individual API routes.

References reviewed 7 November 2026. Verify implementation-specific identity and provider APIs at build time.
