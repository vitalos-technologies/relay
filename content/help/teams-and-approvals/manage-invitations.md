---
title: Resend, revoke or replace an invitation
summary: Keep invitations under control - resend with a fresh link, revoke one sent by mistake, and understand expiry.
section: teams-and-approvals
audience: user
roles: [owner, admin]
status: available
related: [invite-people, accept-an-invitation, invitation-link-not-working]
product_version: "2026-11"
reviewed: 2026-11-09
order: 21
keywords: [resend invite, revoke invite, expired invitation, invitation link]
---

**Required permission:** `members.invite` (Owner or Admin). Open **Team → Invitations** ([/team/invitations](/team/invitations)).

The list shows every open invitation: email, role and brands, teams, a **Guest** badge for guest reviewers, who sent it,
and **Expires in…** or **Expired…**.

## Resend an invitation

1. Select the resend icon on the row (**Resend to …**).
2. **Result:** Relay creates a **new link** and restarts the expiry. The old link stops working immediately ("Resent — old
  link no longer works"). If email isn't set up you see "New link created — email not sent" and the link once, to copy.

Relay refuses to resend a guest invitation when the guest's access would end within an hour; send a new invitation with
a new access period instead.

## Revoke an invitation

1. Select the revoke icon (**Revoke invitation for …**) and confirm **Revoke**.
2. **Result:** the link stops working at once and shows *revoked* to anyone who opens it. Nothing else changes.

## When an invitation expires

- Links expire after the workspace setting **Invitations expire after (hours)**, default 72 hours (1–720).
- An expired invitation stays in the list marked **Expired** until you resend or revoke it.
- Expiry of the *link* is separate from a guest's *access period*: a guest's grants end on their access end date even
  after they accepted.

## Checks made at acceptance

When someone accepts, Relay checks in one step that the invitation is still open, that they signed in with the invited
email, that a guest's access period hasn't ended, and that **the person who sent it still has the right to grant those
roles**. If the inviter lost their admin rights in the meantime, the invitation fails with "invitation invalid": send a
new one.

## Limitations

- You can't edit an invitation (role, brands, teams). Revoke it and send a new one.
- A **suspended** member can't be brought back with an invitation; reactivate them on their member page instead.
