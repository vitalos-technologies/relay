---
title: Use teams and delegate administration
summary: Group people into teams, give a team access once, and let team managers add or remove members within limits you set.
section: teams-and-approvals
audience: user
roles: [owner, admin, team_manager]
status: available
related: [roles-and-permissions, effective-access-and-overlapping-roles, invite-people, reassign-work-and-held-posts]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [team, group, delegation, team manager, publishing team]
---

A **team** is a group of members with shared access. Give the team a role (for example *Publisher on Brand A*) and
everyone in the team gets it. People can be in several teams; their access adds up with their own direct grants.

## Who can do what

| Action | Who |
|---|---|
| See teams | `teams.read` (Owner, Admin, Team manager) |
| Create, rename, archive a team; change its access and its managers' limits | `teams.manage` (Owner, Admin) |
| Add or remove members of a team | Owner and Admin; a **team manager** for their own team, only when every role the team grants fits the limits set for that team |

Team managers can never add themselves, appoint other managers, or change the team's access or limits. Admins can't
add themselves to a team that grants access either (ask another admin); only an Owner can.

## Create a team and give it access

1. Go to **Team → Teams** ([/team/teams](/team/teams)) and select **New team**. Enter a **Name** and select **Create**.
2. Open the team. Under **Team access**, add a role and choose **All brands** or one brand. Teams can hold Brand manager,
   Publisher, Editor, Approver, Care agent, Analyst, Viewer or Exporter.
3. A team whose access includes publishing is labelled **Publishing team**, and the page warns: *Adding someone here lets
   them schedule and publish*.

## Add members and managers

1. On the team page select **Add member**, choose a person and optionally tick **Team manager**.
2. To make an existing member a manager (or remove that), use the manager toggle on their row.
3. To remove someone from the team, use **Remove … from team**.

Adding someone to a team that grants access is a privilege change: Relay checks that you could grant every role of the
team yourself, records it in the audit log, and—when the team can publish and your workspace requires two-step
verification—asks admins to verify again.

## Set what managers can grant

Under **What managers can grant**, choose the roles and brands a team manager may hand out by adding people to this team.
You can't set a limit higher than what you could delegate yourself. A manager can then only add or remove members while
every grant of the team fits these limits.

## Archive a team

Select **Archive team** and confirm. **Consequence:** members lose this team's access immediately. Scheduled posts that
relied on that access are **held** and wait for someone to adopt them (see
[Reassign work and held posts](/help/teams-and-approvals/reassign-work-and-held-posts)). Direct grants are unaffected.

## Limitations

- Teams belong to one workspace and never span workspaces.
- Removing a person from a team removes only that team's access; access they also hold directly or via another team stays.
  The member page shows exactly where each permission comes from.
