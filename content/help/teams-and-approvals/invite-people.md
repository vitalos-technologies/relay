---
title: Invite people to your workspace
summary: Send a member or guest invitation, choose role, brands and teams, and follow it until it is accepted.
section: teams-and-approvals
audience: admin
roles: [owner, admin]
status: available
related: [manage-invitations, accept-an-invitation, roles-and-permissions, guests-and-client-reviews, manage-seats]
product_version: "2026-11"
reviewed: 2026-11-09
order: 20
keywords: [invite, add user, new member, onboarding, bulk invite]
---

## Before you start

- **Required permission:** `members.invite` (Owner or Admin). Inviting someone with a role that can schedule, publish,
  manage connections or administer the workspace counts as a sensitive change: if your workspace requires two-step
  verification for your role, Relay asks you to verify again first.
- You can only give roles you could grant yourself. Nobody can invite an **Owner**; only Owners can invite an **Admin**.
- On a paid plan, every accepted member is a billable seat. If all paid seats are in use, add seats in
  [Plan and billing](/help/billing-and-plans/manage-seats) first. Pending invitations are not billed.

## Invite one person

1. Go to **Team → Invitations** ([/team/invitations](/team/invitations)) and select **Invite**.
2. Choose the **Type**:
   - **Member** for people in your organisation.
   - **Guest reviewer** for an external client who should only review what you share with them (see
     [Guests and client reviews](/help/teams-and-approvals/guests-and-client-reviews)).
3. Enter the **Email** address. The person must later sign in with this exact address.
4. For a member, choose a **Role**. The hint under the field says what the role does.
   For a guest, choose **Access for** (7, 14, 30, 60 or 90 days, never more than your workspace's maximum).
5. Choose **Brands**. For members, leaving every brand unticked means *all brands* (a workspace-wide grant). Admins
   always get the whole workspace, so the brand list is hidden for them. Guests need at least one brand.
6. Optionally tick **Teams**. Teams marked **Publishing** let their members schedule and publish.
7. Select **Send**.

**Result:** the invitation appears in the list with its expiry ("Expires in 3 days"). If email is set up for your Relay
installation the person gets an email with the link; otherwise you see "Invitation created — email not sent" and a
dialog with the **Invitation link (shown once)**. Copy it and send it yourself through a channel you trust.

![Invite dialog with Member or Guest reviewer, Email, Role (Editor: Draft, upload, submit), Brands where none means all, and Send](/help/img/teams-and-approvals/invite-dialog.png)

## Invite several people at once

1. On **Team → Invitations**, select **Bulk**.
2. Paste up to **100** email addresses, one per line (commas and semicolons also work).
3. Choose one **Role** (Admin is not offered in bulk) and one **Brand**, or **All brands**.
4. Select **Invite**. Each row is checked separately and shows its own result: *invited*, *already invited*, or an error
   with a reason. Running the same bulk invite twice doesn't create duplicates.

## What the invited person sees

The link opens a page that names the workspace, the role, a masked version of the invited email and the expiry. They
select **Accept** and sign in. See [Accept an invitation](/help/teams-and-approvals/accept-an-invitation).

## Common errors

| Message | Meaning | What to do |
|---|---|---|
| Already invited | There is an open invitation for this email in this workspace. | Resend or revoke the existing one. |
| You can't grant this role | Your own roles don't include every permission of that role. | Ask an Owner or Admin. |
| Two-step verification required / verify again | Sensitive role and your session isn't verified recently. | Complete the prompt, then send again. |
| All paid seats are in use | Billing shows no free seat. | Add seats first (owners and admins with billing access). |

## Limitations

- One open invitation per email per workspace.
- The Invite dialog doesn't offer the **Care agent** role. Invite with another role, then add Care agent on the member's
  page (**Team → member → Grants → Add**) or through a team.
- Invitation links expire after the workspace's setting (default **72 hours**, see
  [Workspace security policy](/help/account-security/workspace-security-policy)).
