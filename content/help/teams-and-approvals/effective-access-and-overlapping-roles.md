---
title: Check someone's effective access
summary: See exactly what a member can do on each brand, where each permission comes from, and how overlapping roles and restrictions combine.
section: teams-and-approvals
audience: user
roles: [owner, admin, team_manager]
status: available
related: [roles-and-permissions, teams-and-delegated-administration, suspend-or-remove-a-member, why-cant-i-see-or-do-this]
product_version: "2026-11"
reviewed: 2026-11-09
order: 31
keywords: [effective access, overlapping roles, restriction, deny, expiry, temporary access]
---

**Required permission:** `members.read` to look; `members.manage` to change grants and restrictions.

## Read the Effective access panel

1. Go to **Team** ([/team](/team)) and open a member.
2. **Effective access** lists workspace-wide permissions first, then one block per brand, grouped (Content, Publishing,
   Library and so on). Each chip is colour-coded:
   - **Direct** (green): from a grant on the person.
   - **Via team** (blue): only from team membership.
   - **⏱**: at least one source expires.
   - **Denied** (red, struck through): an explicit restriction blocks it.
3. Hover or focus a chip to see its sources, for example *Publisher via Social team · Editor (direct) until 30/11/2026*.
4. **Grants** lists the direct grants (with who granted them) and the grants received through teams (linked to the team).

## How overlapping roles combine

- Access **adds up**. *Editor on Brand A* (direct) plus membership of a team with *Publisher on Brand A* means the person
  can draft and also schedule on Brand A.
- A **workspace** grant covers every brand. A **brand** grant covers only that brand.
- Workspace-only permissions (members, teams, settings, audit, security, service accounts, billing) come only from
  workspace grants.
- An **expired** grant gives nothing; the chip disappears when it lapses.
- A **restriction** always wins over any grant.

## Give temporary access

1. On the member page, under **Grants**, select **Add**.
2. Choose a **Role** and **Brand** (or **All brands**), and set **Expires**.
3. Select **Grant**. **Result:** the access works until the expiry time and then stops by itself.

## Deny one action without changing roles

1. Under **Restrictions**, select **Deny**.
2. Choose the **Action** (Everything, publish, schedule, edit, approve, export, manage connections, upload), the **Brand**
   or **All brands**, and an optional **Reason**.
3. Select **Deny**. **Result:** the action is refused for that person even if a role allows it. Lift it later with
   **Lift restriction**.

## Reduce access

- Revoke a direct grant with the bin icon next to it.
- Access that comes **via a team** can only be removed by removing the person from that team (or changing the team's
  access). Relay reports when access remains through teams rather than silently removing it.

## Consequence for scheduled posts

Whenever access changes, Relay re-checks scheduled posts that this person authorised. If they no longer may publish to
every destination, those posts are **held** instead of being sent. See
[Reassign work and held posts](/help/teams-and-approvals/reassign-work-and-held-posts).

## Limitations

- Changes take effect on the person's next request; there is no permission cache to clear.
- You can't edit a grant; revoke it and add a new one.
