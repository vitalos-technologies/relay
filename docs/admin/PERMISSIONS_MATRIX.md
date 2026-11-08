# Admin permissions matrix (V3.1 Admin)

Workspace scope uses the V2 policy unchanged (`docs/PERMISSIONS_MATRIX.md`, `packages/core/src/authz.ts`): every admin
API calls `requireAction()` / `authorizeCtx()` with brand/connection scope, re-reads grants per request, and returns 404
for resources outside the caller's scope. Navigation hides what a session can't use; the server enforces regardless.
Platform scope is a separate, explicit authority (`platform_operators`, migration 026) re-read on every request by
`platformRoute()`; non-operators get **404** from `/api/platform/**`.

## Workspace admin (who sees and does what)

| Admin area | Read | Write / act | Extra checks |
|---|---|---|---|
| Overview (`/api/admin/overview`) | workspace.read (owner, admin, team manager) | – | cards filtered by the viewer's permissions; brand-scoped counts |
| Change feed (`/api/admin/changes`) | workspace.read | – | no record data; denied to brand-scoped members |
| Members / invitations / teams | members.read, teams.read | members.invite, members.manage, teams.manage | delegation ceiling (`canDelegate`), no self-grant, last-owner lock, MFA + step-up for sensitive roles |
| Deliveries list + detail | content.read (per brand) | retry/resolve: publishing.retry; cancel/reschedule/adopt: content.schedule; pause: publishing.pause; resume: publishing.resume | approval + authority + brand rules + duplicate-risk rules from the shared services |
| Dead letters | workspace.manage | workspace.manage (requeue safe types) | conditional update ⇒ once |
| Social accounts | connections.read | connections.manage (reconnect, pause) | step-up for credential changes |
| Content jobs + storage | content.read; reports need analytics.read; media needs assets.read | in owning screens | brand-scoped |
| Analytics ingestion | analytics.read | resync request (throttled) | stored data only |
| Webhooks (inbound) | workspace.manage | – | bodies never shown |
| Audit log | audit.read | export: + exports.create | append-only for app roles |
| Support access | members.read | approve/decline: members.manage + fresh MFA; end: members.manage | no self-approval; requester must still be an operator |
| Problem reports | audit.read | – | redacted at write |
| Operations (queues, workers, diagnostics) | workspace.manage (`diagnostics.read`) | pause scopes as above | – |
| Usage and limits | workspace.manage | caps: security.manage (owner) | – |
| Settings sub-pages | per registry item (`visible`) | per item's own API | unchanged |
| Instance setup | setup.manage (= security.manage, owner) | same | see IMPLEMENTATION_GAPS G-A1 |

Role presets → admin areas (summary): **owner** everything; **admin** everything except ownership transfer, security
policy weakening and caps; **team manager** overview + people within their team ceiling; **brand manager / publisher /
approver** no admin overview, but the same publishing actions in the main app; **viewer, editor, analyst** none.

## Platform scope

| Action | support | operator | Fresh MFA (≤ 300 s) | Audited |
|---|---|---|---|---|
| Platform health, workspaces (metadata), accounts search, integrations matrix, rollouts (view), platform audit, operators (view) | ✓ | ✓ | – | – |
| Request / cancel / end own support access | ✓ | ✓ | – | platform + workspace audit |
| Suspend / reactivate workspace | – | ✓ | ✓ | both audits |
| Workspace dispatch share | – | ✓ | ✓ | both audits |
| Installation dispatch on/off | – | ✓ | ✓ | platform audit |
| Feature rollout / kill switch | – | ✓ | ✓ | platform audit |
| Suspend / reactivate account | – | ✓ | ✓ | platform audit |
| Grant / revoke operators | – | ✓ (never self) | ✓ | platform audit |

Operators hold **no** workspace permission. Private content requires an approved support access, which is an ordinary,
expiring, read-only `viewer` grant evaluated by the same `authorize()` as every member.
