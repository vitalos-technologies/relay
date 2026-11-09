---
title: Every setting and where it's explained
summary: A map of every Settings group and sub-setting, who can change it, and the article that explains it.
section: administration
audience: admin
status: available
related: [workspace-and-brand-settings, use-the-admin-console, roles-and-permissions]
product_version: "2026-11"
reviewed: 2026-11-09
order: 1
keywords: [settings, preferences, configuration, options, where is setting]
---

Open **Settings** ([/settings](/settings)). Use **Search** to jump to a setting. You only see items you can use; some
open their own page (Team, Connections, Security, Audit log). Items you can see but not change are marked **View only**.

| Group → setting | Who can change it | Article |
|---|---|---|
| **Personal** → Profile | Your identity provider | [Profile, appearance and accessibility](/help/account-security/profile-appearance-and-accessibility) |
| Personal → Appearance | You | [Profile, appearance and accessibility](/help/account-security/profile-appearance-and-accessibility) |
| Personal → Notifications | You | [Manage notifications](/help/teams-and-approvals/notifications-and-preferences) |
| Personal → Security and sessions | You | [Two-step verification](/help/account-security/set-up-two-step-verification), [Sessions](/help/account-security/manage-sessions) |
| **Workspace** → General | `workspace.manage` | [Workspace and brand settings](/help/administration/workspace-and-brand-settings) |
| Workspace → Brands | `brands.manage` | [Workspace and brand settings](/help/administration/workspace-and-brand-settings) |
| Workspace → Time zone and locale | `workspace.manage` | [Time zones and DST](/help/calendar-and-scheduling/time-zones-and-dst) |
| Workspace → Plan and billing (`billing.read` to see) | `billing.manage` | [Plans](/help/billing-and-plans/plans-and-features), [Seats](/help/billing-and-plans/manage-seats), [Change or cancel](/help/billing-and-plans/change-plan-or-cancel) |
| Workspace → Draft recovery | `workspace.manage` | [Recover unsaved changes](/help/publishing/recover-unsaved-changes) |
| **People and access** → Members | `members.manage` | [Effective access](/help/teams-and-approvals/effective-access-and-overlapping-roles), [Suspend or remove](/help/teams-and-approvals/suspend-or-remove-a-member) |
| People and access → Invitations | `members.invite` | [Invite people](/help/teams-and-approvals/invite-people) |
| People and access → Teams | `teams.manage` | [Teams](/help/teams-and-approvals/teams-and-delegated-administration) |
| People and access → Workspace security | Owners (`security.manage`) | [Workspace security policy](/help/account-security/workspace-security-policy) |
| **Publishing** → Defaults | `brands.manage` | [Workspace and brand settings](/help/administration/workspace-and-brand-settings) |
| Publishing → Approval policies | `brands.manage` | [Approval policies](/help/teams-and-approvals/approval-policies-and-stages) |
| Publishing → Posting slots | `brands.manage` | [Slots and queue](/help/calendar-and-scheduling/posting-slots-and-queue) |
| Publishing → Safety rules | `brands.manage` | [Readiness checks](/help/publishing/check-before-sending) |
| Publishing → Brand rules (optional feature) | `brands.manage` | [Brand rules](/help/publishing/brand-rules) |
| Publishing → Campaign links (optional feature) | `brands.manage` | [Campaign links](/help/publishing/campaign-links-and-utm) |
| **Connections** → Social accounts | `connections.manage` | [Connect social accounts](/help/social-connections/connect-social-accounts) |
| Connections → Google Drive and Docs | `connections.manage` | [Google Drive and Docs](/help/content-sources/google-drive-and-docs) |
| Connections → Notion | `connections.manage` | [Notion](/help/content-sources/notion) |
| Connections → Connection health | `connections.manage` | [Connection status and fixes](/help/social-connections/connection-status-and-fixes) |
| Connections → Business apps | `integrations.manage` | [Business apps](/help/business-apps/business-apps-overview) |
| **Inbox** → Channels | `inbox.manage` | [Inbox channels by network](/help/inbox-and-care/inbox-channels-by-network) |
| Inbox → Service levels | `inbox.manage` | [Cases and service levels](/help/inbox-and-care/cases-and-service-levels) |
| Inbox → Saved replies | `inbox.manage` | [Saved replies and views](/help/inbox-and-care/saved-replies-and-views) |
| **Listening** → Sources | `listening.manage` | [Set up listening](/help/listening/set-up-listening) |
| **AI and automation** → Brand voice | `brands.manage` | [Brand voice and knowledge](/help/ai-and-mcp/approved-knowledge-and-brand-voice) |
| AI and automation → Inbound sources | Owners | [Receive drafts from TipSignal](/help/administration/inbound-sources) |
| **Developer** → MCP | see article | [MCP server](/help/developers/mcp-server) |
| Developer → API and service accounts | `service_accounts.manage` | [Service accounts and API keys](/help/account-security/service-accounts-and-api-keys) |
| **Operations** → Audit log | Owners, Admins (read) | [Audit log](/help/teams-and-approvals/audit-log) |
| Operations → Usage and limits | `workspace.manage` | [Usage and limits](/help/billing-and-plans/usage-and-limits) |
| Operations → Feature flags | `workspace.manage` | [Feature flags](/help/administration/feature-flags) |
| Operations → Data export | `exports.create` | [Export a brand's data](/help/administration/export-workspace-data) |

Admins find the same settings, grouped differently, in the [admin console](/help/administration/use-the-admin-console).
