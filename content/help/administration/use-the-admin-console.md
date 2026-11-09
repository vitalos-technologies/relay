---
title: Find your way around the admin console
summary: What each area of the workspace admin console shows and who can open it.
section: administration
audience: admin
roles: [owner, admin, team_manager]
status: available
related: [audit-log, collaboration-settings, usage-and-limits, reassign-work-and-held-posts, support-access]
product_version: "2026-11"
reviewed: 2026-11-09
order: 5
keywords: [admin, admin console, administration, health, operations]
---

Open **Admin console** in the sidebar ([/admin](/admin)) — anyone with `workspace.read` (Owner, Admin, Team manager).
Each item appears only when you hold its permission.

| Group | Items | Needs |
|---|---|---|
| Overview | Health and things needing attention | `workspace.read` |
| People and teams | Members, Invitations, Teams, Held publications | `members.read` / `members.invite` / `teams.read` / `content.schedule` |
| Brands | Brands, Brand rules, Brand voice | per setting |
| Publishing | Deliveries (failed, unknown, retry, cancel, reschedule), Defaults, Posting slots, Safety rules, Campaign links | `content.read` / per setting |
| Approvals | Backlog | `content.read` |
| Collaboration | Overview, Reassign work, Notification delivery, Collaboration settings | `content.read` / `members.manage` / `workspace.manage` |
| Inbox, listening and AI | Overview, Inbox health, Integrations and sync, Listening coverage, AI and automation | workspace admins |
| Content and media | Jobs and storage (imports, exports, writeback, media, trash) | `content.read` |
| Connections | Social accounts, Diagnostics (when turned on) | `connections.read` |
| Analytics | Ingestion (sync freshness, coverage) | `analytics.read` |
| Automations | Inbound sources | Owner |
| Developer tools | API and service accounts, MCP, Webhooks | `service_accounts.manage` / members / `workspace.manage` |
| Security and audit | Audit log, Support access, Problem reports | `audit.read` / `members.read` |
| Operations | Queues and workers, Usage and limits | workspace admins |
| Settings | General, Time zone, Draft recovery, Profile, Appearance, Notifications, Instance setup (Owners) | per setting |
| Help | Admin guide | — |

Admin pages show counts, states and reasons. They never show inbox message text, AI prompts or secrets.

Relay staff have a separate **Platform** area; it isn't visible to workspace members.
