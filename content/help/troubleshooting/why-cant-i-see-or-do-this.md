---
title: Why can't I see a page or do an action?
summary: Work out whether a missing page, brand or button comes from your role, its scope, a restriction, two-step verification, your plan or a billing hold.
section: troubleshooting
audience: user
status: available
related: [roles-and-permissions, effective-access-and-overlapping-roles, step-up-verification, plans-and-features, when-paid-actions-are-paused]
product_version: "2026-11"
reviewed: 2026-11-09
order: 10
keywords: [permission denied, forbidden, missing button, greyed out, no access, cannot see brand, 403, 404]
---

Relay hides what you can't use and explains disabled buttons when you hover or focus them. Work through these in order.

1. **Right workspace and brand?** Check the workspace switcher and the **Brand filter** in the header. You only see brands
   where you hold a role. Things in other brands or workspaces answer "not found" — Relay doesn't reveal whether they exist.
2. **Does your role include it?** For example Editors can't schedule, Approvers can't publish, Analysts can't edit, Care
   agents can't publish. See [Roles and permissions](/help/teams-and-approvals/roles-and-permissions).
3. **Is your role for the whole workspace or one brand?** Members, teams, settings, audit, billing and service accounts
   need a workspace-wide role.
4. **Has access expired?** Guest access and temporary grants end on their date.
5. **Is there a restriction?** Admins can deny single actions (for example publish) even if your role allows them.
6. **Two-step verification?** Sensitive actions need it when your workspace requires it for your role, and some need a
   fresh sign-in. See [Why Relay asks you to verify again](/help/account-security/step-up-verification).
7. **Plan?** Some features are Professional only (*Not in your plan*). See [Plans and features](/help/billing-and-plans/plans-and-features).
8. **Billing hold?** During a restriction, publishing, replies, AI and uploads pause. See
   [When paid actions are paused](/help/billing-and-plans/when-paid-actions-are-paused).
9. **Optional feature off?** Brand rules, campaign links, the content queue and a few others are off until an admin turns
   them on ([Feature flags](/help/administration/feature-flags)).
10. **Brand rule or approval policy?** Mandatory brand rules and review requirements block scheduling until met.

Admins can see exactly why: **Team → member → Effective access** shows each permission and where it comes from.
