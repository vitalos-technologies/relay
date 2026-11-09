---
title: Turn optional features on or off
summary: Enable optional features such as brand rules, campaign links, the evergreen queue, the setup checklist and release notes for your workspace.
section: administration
audience: user
roles: [owner, admin]
status: available
related: [brand-rules, campaign-links-and-utm, posting-slots-and-queue]
product_version: "2026-11"
reviewed: 2026-11-09
order: 20
keywords: [feature flags, beta, enable feature, optional features, rollout]
---

**Required:** `workspace.manage` (Owner, Admin); others see **View only**. Open **Settings → Operations → Feature flags**
([/settings/operations/features](/settings/operations/features)).

Each feature has **Default**, **On** or **Off**. *Default* follows Relay's rollout for your workspace; all of these are
**off by default**.

| Feature | What it adds |
|---|---|
| Guided onboarding checklist | A **Get set up** checklist on Overview with connection readiness. |
| Evergreen content queue | The content queue for reusable posts (see [Slots and queue](/help/calendar-and-scheduling/posting-slots-and-queue)). |
| Campaign short links with app-observed clicks | Campaign links, UTM defaults and short links (see [Campaign links](/help/publishing/campaign-links-and-utm)). |
| Brand rules editor and review list | Brand rules, brand profile and media licences (see [Brand rules](/help/publishing/brand-rules)). |
| Integration test centre | **Connections → Diagnostics**: read-only checks per connected account. |
| In-app release notes | **What's new** in the account menu. |

Relay can switch a feature off for everyone if it misbehaves; then your setting has no effect until it's restored.
Changes are recorded in the audit log.
