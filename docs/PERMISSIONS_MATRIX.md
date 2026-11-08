# Permissions matrix (V2)

Source of truth: `packages/core/src/authz.ts` (`PRESET_PERMISSIONS`, `evaluate`). Enforced by `packages/services/src/{authz,tenancy}.ts` on every API route, export, media URL, worker dispatch and notification.

## Precedence (highest first)

1. No active membership (missing / removed / **suspended**) or disabled/expired service account → **deny**
2. Explicit restriction (`access_restrictions`) covering action + scope → **deny**
3. Mandatory assurance: MFA required for the subject's roles and the action is sensitive (or step-up requested) and the session lacks verified MFA / fresh authentication → **deny** (`mfa_required` / `step_up_required`)
4. Union of active, unexpired grants — direct and via teams — whose scope covers the resource → **allow**
5. Otherwise **deny** (default)

Every decision returns a reason code and the workspace `policy_version`. Errors never reveal whether a resource in another scope exists (404).

## Presets

| Permission | owner | admin | brand_manager | editor | approver | publisher | analyst | viewer | exporter | guest | integration |
|---|---|---|---|---|---|---|---|---|---|---|---|
| workspace.read / manage | ✓ | ✓ | | | | | | | | | |
| workspace.transfer_owner | ✓ | | | | | | | | | | |
| members.read / invite / manage | ✓ | ✓ | | | | | | | | | |
| teams.read / manage | ✓ | ✓ | | | | | | | | | |
| brands.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | |
| brands.manage | ✓ | ✓ | ✓ | | | | | | | | |
| connections.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | |
| connections.manage | ✓ | ✓ | | | | | | | | | |
| content.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | shared only | |
| content.create / edit / archive / submit | ✓ | ✓ | ✓ | ✓ | | | | | | | |
| content.create_draft | ✓ | ✓ | | | | | | | | | ✓ |
| content.approve | ✓ | ✓ | | | ✓ | | | | | shared only | |
| content.schedule / publish | ✓ | ✓ | ✓ | | | ✓ | | | | | |
| publishing.pause | ✓ | ✓ | ✓ | | ✓ | ✓ | | | | | |
| publishing.resume / retry | ✓ | ✓ | ✓ | | | ✓ | | | | | |
| assets.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | |
| assets.upload | ✓ | ✓ | ✓ | ✓ | | | | | | | |
| assets.manage | ✓ | ✓ | ✓ | | | | | | | | |
| analytics.read | ✓ | ✓ | ✓ | | | | ✓ | | | | |
| exports.create | ✓ | ✓ | | | | | | | ✓ | | |
| comments.internal | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | |
| comments.shared | ✓ | ✓ | ✓ | ✓ | ✓ | | | | | ✓ | |
| audit.read | ✓ | ✓ | | | | | | | | | |
| security.manage | ✓ | | | | | | | | | | |
| service_accounts.manage | ✓ | ✓ | | | | | | | | | |

`team_manager` adds `workspace.read`, `members.read`, `teams.read` plus delegated team-membership management within `delegation_limits` (roles + brands).

## Scope

- Workspace-only permissions (workspace/members/teams/audit/security/service accounts) are granted only by workspace-scope grants.
- Brand grants cover that brand; connection grants cover only that destination.
- Guests: brand/connection scope only, **must** expire (default 30 days, max per policy 90).
- Service accounts: `integration`, `viewer` or `editor` only.

## Delegation

`canDelegate(delegatorRoles, role)`: nobody grants `owner` (ownership moves only via transfer); only owners grant `admin`; admins grant any other preset; anyone else may grant a preset only if they already hold every permission in it, and team managers additionally only within their team's ceiling. Self-grants are rejected.

## Mandatory MFA (default workspace policy)

Required for owner, admin, publisher and brand_manager on sensitive permissions: workspace.manage, transfer_owner, members.invite/manage, teams.manage, connections.manage, security.manage, service_accounts.manage, content.schedule/publish, exports.create. Step-up (fresh authentication within 300 s) for ownership transfer, sensitive role grants, factor/recovery changes, social credential changes, API key creation and security-policy weakening.
