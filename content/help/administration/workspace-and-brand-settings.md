---
title: Set up workspace and brand settings
summary: Name the workspace, set time zones, create and configure brands, and set publishing defaults such as the deadline window.
section: administration
audience: user
roles: [owner, admin, brand_manager]
status: available
related: [time-zones-and-dst, pause-publishing-in-an-emergency, approval-policies-and-stages, approved-knowledge-and-brand-voice, feature-flags]
product_version: "2026-11"
reviewed: 2026-11-09
order: 10
keywords: [workspace settings, brand, create brand, time zone, locale, deadline, publishing defaults, rename]
---

Settings are grouped in **Settings** ([/settings](/settings)): Personal, Workspace, People and access, Publishing,
Connections, Inbox, Listening, AI and automation, Developer, Operations. You only see what you can use; **Search** finds
any setting. Items you can see but not change show **View only**.

## Workspace → General

**Name** (up to 120 characters), plus **Created** and **Type** (*Standard*, or *Demo (simulated)*). Changing it needs
`workspace.manage` (Owner, Admin).

## Workspace → Time zone and locale

**Time zone** — *For new brands and display. Never moves an existing scheduled post.* (*Scheduled posts keep their
times.*) Dates are shown day-month-year (en-GB) and weeks start on Monday; these aren't configurable.

## Workspace → Brands

1. **Create brand** / **New brand**: **Name** and **Time zone**. Needs `brands.manage` at workspace level.
2. Choose a brand to edit its **Name** and **Time zone** (*Default for new schedules. Existing ones keep their time.*).

## Publishing → Defaults (per brand)

- **Deadline (minutes)**, 1–10,080: *If a post can't send within this window it expires instead of posting late.* The
  default for new schedules; each schedule can override it.
- **Editors can publish** (*Off: editors submit for review*). **Note:** this switch is kept for older workspaces and **no
  longer changes anything**. Who can schedule and publish comes only from roles; whether review is required comes from the
  brand's [approval policy](/help/teams-and-approvals/approval-policies-and-stages).
- **Pause brand** — see [Pause publishing](/help/calendar-and-scheduling/pause-publishing-in-an-emergency).

Brand settings need `brands.manage` on the brand (Brand manager, Admin, Owner).

## Other brand-level settings

| Setting | Where | Article |
|---|---|---|
| Approval policy | Publishing → Approval policies | [Approval policies](/help/teams-and-approvals/approval-policies-and-stages) |
| Posting slots | Publishing → Posting slots | [Slots and queue](/help/calendar-and-scheduling/posting-slots-and-queue) |
| Duplicate check | Publishing → Safety rules | [Readiness checks](/help/publishing/check-before-sending) |
| Brand rules | Publishing → Brand rules | [Brand rules](/help/publishing/brand-rules) |
| Campaign links | Publishing → Campaign links | [Campaign links](/help/publishing/campaign-links-and-utm) |
| Brand voice | AI and automation → Brand voice | [Brand voice](/help/ai-and-mcp/approved-knowledge-and-brand-voice) |

## Limitations

- Brands can't be moved between workspaces.
