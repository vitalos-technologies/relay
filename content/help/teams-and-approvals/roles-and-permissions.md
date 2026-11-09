---
title: Understand roles and permissions
summary: What each role can do in Relay, where a role applies (workspace or brand), and how access from several roles combines.
section: teams-and-approvals
audience: user
roles: [owner, admin, team_manager, brand_manager, editor, approver, publisher, analyst, viewer, exporter, guest, integration, care_agent]
status: available
related: [effective-access-and-overlapping-roles, invite-people, teams-and-delegated-administration, workspace-security-policy, guests-and-client-reviews]
product_version: "2026-11"
reviewed: 2026-11-09
order: 10
keywords: [role, permission, access, matrix, rights, preset]
---

Everything you can see and do in Relay comes from **roles** you hold in a workspace. A role is a fixed bundle of
permissions (a "preset"). Relay checks your permissions on the server for every request, so hiding a button is only a
convenience: if you don't hold the permission, the action is refused even if you find a way to call it.

## The roles at a glance

| Role | In one line | Typical person |
|---|---|---|
| **Owner** | Everything, including ownership transfer and the workspace security policy. | The account holder. There is always at least one. |
| **Admin** | Everything operational except transferring ownership and changing the security policy. | Operations lead, agency director. |
| **Brand manager** | Everything on a brand: content, publishing, inbox, brand settings. | Account manager for one client. |
| **Editor** | Draft, upload media, submit for review. Cannot schedule or publish. | Copywriter, designer. |
| **Approver** | Approve or request changes; can pause publishing. Cannot publish. | Client lead, compliance reviewer. |
| **Publisher** | Schedule, publish now, pause, resume and retry. | Social media manager. |
| **Care agent** | Read and answer the inbox, assign conversations, work on cases. No publishing, no settings. | Customer care. |
| **Analyst** | Read content and analytics, read listening. | Reporting, insights. |
| **Viewer** | Read only. | Stakeholder. |
| **Team manager** | See the workspace, members and teams, and manage the membership of teams they manage within limits. | Team lead. |
| **Exporter** | Create exports only. | Finance or records. |
| **Guest** | Only reviews explicitly shared with them; access always expires. | External client reviewer. |
| **Integration** | Create drafts on one brand through the API. Service accounts only. | An automated feed. |

## Where a role applies (scope)

A role is granted at one of three scopes:

- **Workspace**: the role covers every brand, including brands created later.
- **Brand**: the role covers one brand only. Someone with *Editor on Brand A* cannot see Brand B at all.
- **Connection**: the role covers one connected account of a brand. The policy supports this scope, but the Team screens
  only grant workspace or brand scope today.

Some permissions only make sense for the whole workspace (marked **ᵂ** below): members, teams, workspace settings,
audit, security, service accounts, billing and the workspace's support requests. A brand-scoped grant never gives these,
even for a role that contains them.

Guests always get brand scope, and their access always has an end date.

## Full permission matrix

Generated from the role presets in Relay's authorization policy (`packages/core/src/authz.ts`, reviewed 2026-11-09).
✓ = included in the role. **ᵂ** = workspace-only permission. **ˢ** = sensitive: needs two-step verification when your
workspace requires it for your role (see [Workspace security policy](/help/account-security/workspace-security-policy)).

### Staff roles

| Permission | What it allows | Owner | Admin | Brand manager | Editor | Approver | Publisher | Care agent |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `workspace.read` ᵂ | See workspace administration | ✓ | ✓ | — | — | — | — | — |
| `workspace.manage` ᵂ ˢ | Change workspace settings | ✓ | ✓ | — | — | — | — | — |
| `workspace.transfer_owner` ᵂ ˢ | Transfer ownership, delete workspace | ✓ | — | — | — | — | — | — |
| `members.read` ᵂ | See members | ✓ | ✓ | — | — | — | — | — |
| `members.invite` ᵂ ˢ | Invite people | ✓ | ✓ | — | — | — | — | — |
| `members.manage` ᵂ ˢ | Change roles, suspend, remove | ✓ | ✓ | — | — | — | — | — |
| `teams.read` ᵂ | See teams | ✓ | ✓ | — | — | — | — | — |
| `teams.manage` ᵂ ˢ | Create and change teams | ✓ | ✓ | — | — | — | — | — |
| `brands.read` | See brands | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `brands.manage` | Change brand settings | ✓ | ✓ | ✓ | — | — | — | — |
| `connections.read` | See connected accounts | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `connections.manage` ˢ | Connect, reconnect, disconnect accounts | ✓ | ✓ | — | — | — | — | — |
| `content.read` | Read posts | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `content.create` | Create posts | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `content.edit` | Edit drafts | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `content.archive` | Archive, move to Trash | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `content.submit` | Submit for review | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `content.approve` | Approve or request changes | ✓ | ✓ | — | — | ✓ | — | — |
| `content.schedule` ˢ | Schedule | ✓ | ✓ | ✓ | — | — | ✓ | — |
| `content.publish` ˢ | Publish now | ✓ | ✓ | ✓ | — | — | ✓ | — |
| `publishing.pause` | Pause publishing | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| `publishing.resume` | Resume publishing | ✓ | ✓ | ✓ | — | — | ✓ | — |
| `publishing.retry` | Retry deliveries | ✓ | ✓ | ✓ | — | — | ✓ | — |
| `assets.read` | Use the library | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `assets.upload` | Upload media | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `assets.manage` | Organise, trash media | ✓ | ✓ | ✓ | — | — | — | — |
| `analytics.read` | See analytics | ✓ | ✓ | ✓ | — | — | — | — |
| `exports.create` ˢ | Create exports | ✓ | ✓ | — | — | — | — | — |
| `audit.read` ᵂ | Read the audit log | ✓ | ✓ | — | — | — | — | — |
| `security.manage` ᵂ ˢ | Workspace security policy | ✓ | — | — | — | — | — | — |
| `service_accounts.manage` ᵂ ˢ | Service accounts and API keys | ✓ | ✓ | — | — | — | — | — |
| `comments.shared` | Client-visible comments | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `comments.internal` | Internal notes | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `content.create_draft` | Create drafts only (API) | ✓ | ✓ | — | — | — | — | — |
| `inbox.read` | Read the inbox | ✓ | ✓ | ✓ | — | — | — | ✓ |
| `inbox.reply` | Reply in the inbox | ✓ | ✓ | ✓ | — | — | — | ✓ |
| `inbox.assign` | Assign conversations | ✓ | ✓ | ✓ | — | — | — | ✓ |
| `inbox.manage` | Inbox channels and settings | ✓ | ✓ | — | — | — | — | — |
| `cases.manage` | Work on cases | ✓ | ✓ | ✓ | — | — | — | ✓ |
| `integrations.read` | See business apps | ✓ | ✓ | ✓ | — | — | — | ✓ |
| `integrations.manage` ˢ | Install and configure business apps | ✓ | ✓ | — | — | — | — | — |
| `listening.read` | See listening | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `listening.manage` | Manage searches and alerts | ✓ | ✓ | — | — | — | — | — |
| `ai.use` | Use the assistant and AI | ✓ | ✓ | ✓ | ✓ | — | — | ✓ |
| `automation.manage` ˢ | Manage automation | ✓ | ✓ | — | — | — | — | — |
| `billing.read` ᵂ | See plan and billing | ✓ | ✓ | — | — | — | — | — |
| `billing.manage` ᵂ ˢ | Change plan, seats, payment | ✓ | ✓ | — | — | — | — | — |
| `support.workspace` ᵂ | See the workspace’s support requests | ✓ | ✓ | — | — | — | — | — |

### Limited and special roles

| Permission | What it allows | Analyst | Viewer | Team manager | Exporter | Guest | Integration |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `workspace.read` ᵂ | See workspace administration | — | — | ✓ | — | — | — |
| `workspace.manage` ᵂ ˢ | Change workspace settings | — | — | — | — | — | — |
| `workspace.transfer_owner` ᵂ ˢ | Transfer ownership, delete workspace | — | — | — | — | — | — |
| `members.read` ᵂ | See members | — | — | ✓ | — | — | — |
| `members.invite` ᵂ ˢ | Invite people | — | — | — | — | — | — |
| `members.manage` ᵂ ˢ | Change roles, suspend, remove | — | — | — | — | — | — |
| `teams.read` ᵂ | See teams | — | — | ✓ | — | — | — |
| `teams.manage` ᵂ ˢ | Create and change teams | — | — | — | — | — | — |
| `brands.read` | See brands | ✓ | ✓ | — | — | — | — |
| `brands.manage` | Change brand settings | — | — | — | — | — | — |
| `connections.read` | See connected accounts | ✓ | ✓ | — | — | — | — |
| `connections.manage` ˢ | Connect, reconnect, disconnect accounts | — | — | — | — | — | — |
| `content.read` | Read posts | ✓ | ✓ | — | — | ✓ | — |
| `content.create` | Create posts | — | — | — | — | — | — |
| `content.edit` | Edit drafts | — | — | — | — | — | — |
| `content.archive` | Archive, move to Trash | — | — | — | — | — | — |
| `content.submit` | Submit for review | — | — | — | — | — | — |
| `content.approve` | Approve or request changes | — | — | — | — | ✓ | — |
| `content.schedule` ˢ | Schedule | — | — | — | — | — | — |
| `content.publish` ˢ | Publish now | — | — | — | — | — | — |
| `publishing.pause` | Pause publishing | — | — | — | — | — | — |
| `publishing.resume` | Resume publishing | — | — | — | — | — | — |
| `publishing.retry` | Retry deliveries | — | — | — | — | — | — |
| `assets.read` | Use the library | ✓ | ✓ | — | — | — | — |
| `assets.upload` | Upload media | — | — | — | — | — | — |
| `assets.manage` | Organise, trash media | — | — | — | — | — | — |
| `analytics.read` | See analytics | ✓ | — | — | — | — | — |
| `exports.create` ˢ | Create exports | — | — | — | ✓ | — | — |
| `audit.read` ᵂ | Read the audit log | — | — | — | — | — | — |
| `security.manage` ᵂ ˢ | Workspace security policy | — | — | — | — | — | — |
| `service_accounts.manage` ᵂ ˢ | Service accounts and API keys | — | — | — | — | — | — |
| `comments.shared` | Client-visible comments | — | — | — | — | ✓ | — |
| `comments.internal` | Internal notes | ✓ | ✓ | — | — | — | — |
| `content.create_draft` | Create drafts only (API) | — | — | — | — | — | ✓ |
| `inbox.read` | Read the inbox | — | — | — | — | — | — |
| `inbox.reply` | Reply in the inbox | — | — | — | — | — | — |
| `inbox.assign` | Assign conversations | — | — | — | — | — | — |
| `inbox.manage` | Inbox channels and settings | — | — | — | — | — | — |
| `cases.manage` | Work on cases | — | — | — | — | — | — |
| `integrations.read` | See business apps | — | — | — | — | — | — |
| `integrations.manage` ˢ | Install and configure business apps | — | — | — | — | — | — |
| `listening.read` | See listening | ✓ | — | — | — | — | — |
| `listening.manage` | Manage searches and alerts | — | — | — | — | — | — |
| `ai.use` | Use the assistant and AI | — | — | — | — | — | — |
| `automation.manage` ˢ | Manage automation | — | — | — | — | — | — |
| `billing.read` ᵂ | See plan and billing | — | — | — | — | — | — |
| `billing.manage` ᵂ ˢ | Change plan, seats, payment | — | — | — | — | — | — |
| `support.workspace` ᵂ | See the workspace’s support requests | — | — | — | — | — | — |

## How Relay decides (precedence)

For every action, Relay applies these rules in order. The first rule that matches decides.

1. **Not an active member** (never joined, removed or suspended) → denied. A disabled or expired service account is denied.
2. **An explicit restriction** covers the action on that brand (or all brands) → denied, whatever roles you hold.
3. **Two-step verification required** for one of your roles, the action is sensitive, and this session hasn't verified a
   second factor → denied with "two-step verification required". Some actions also need a fresh sign-in (step-up).
4. **Any active, unexpired grant** (direct or through a team) whose scope covers the item and whose role includes the
   permission → allowed.
5. Otherwise → denied.

So access from several roles **adds up** (an Editor on a brand who is also in a publishing team can schedule there), but
a restriction always wins. See [Effective access and overlapping roles](/help/teams-and-approvals/effective-access-and-overlapping-roles).

## Who can grant which role

- Nobody can grant **Owner**: ownership moves only through [ownership transfer](/help/teams-and-approvals/transfer-ownership).
- Only an **Owner** can grant **Admin**.
- Admins can grant every other role.
- Anyone else (for example a team manager) can grant a role only if they already hold every permission in it, and team
  managers only inside their team's limits. Nobody can grant themselves access.

## Things roles don't do

- **Billing never implies content access, and content roles never imply billing.** Plan and billing need
  `billing.read` / `billing.manage` (owners and admins).
- **Relay support staff get nothing implicitly.** They see your workspace only through a support-access grant you approve.
- **Platform operators never get inbox access implicitly.** Private conversations need `inbox.read`.
- The **Editors can publish** switch in Settings → Publishing → Defaults no longer grants anything: scheduling and
  publishing come only from roles (Publisher, Brand manager, Admin, Owner).

## Limitations

- Roles are fixed presets. You can't create custom roles; combine presets, scopes, teams and restrictions instead.
- Restrictions can deny a short list of actions (everything, publish, schedule, edit, approve, export, manage
  connections, upload). They can't grant anything.
- The Invite dialog offers Editor, Publisher, Approver, Brand manager, Analyst, Viewer, Exporter and Admin. To make
  someone a **Care agent**, invite them with another role (for example Viewer) and then add the Care agent role on their
  member page, or add them to a team that holds it.
