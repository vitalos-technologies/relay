---
title: Suspend or remove a member
summary: Pause someone's access with suspension, or offboard them with removal and a handover - and know exactly what happens to their work.
section: teams-and-approvals
audience: admin
roles: [owner, admin]
status: available
related: [reassign-work-and-held-posts, scheduled-posts-when-someone-leaves, transfer-ownership, effective-access-and-overlapping-roles]
product_version: "2026-11"
reviewed: 2026-11-09
order: 50
keywords: [offboarding, leaver, deactivate, delete user, suspend, remove, reactivate]
---

## Before you start

- **Required permission:** `members.manage` (Owner or Admin). Only an Owner can suspend or remove another Owner.
- **Last-owner protection:** Relay never lets the last active Owner be suspended or removed ("You cannot suspend the last
  owner of a workspace." / "You cannot remove the last owner of a workspace."). Transfer ownership first.

## Suspend vs remove

| | Suspend | Remove |
|---|---|---|
| Access to this workspace | Stops immediately (every request is denied). | Stops immediately. |
| Roles and team memberships | **Kept** but give nothing while suspended. | Direct grants revoked; removed from every team. |
| Comes back with | **Reactivate** (one click). | A new invitation. |
| Their scheduled posts | Re-checked and **held** for adoption. | Re-checked and **held**, unless you hand them over. |
| Service accounts they own | Their API keys are **refused** while the owner is suspended; they work again on reactivation. | **Disabled with keys revoked**, unless you hand them over. |
| Social accounts they connected | Unchanged. | Flagged *verify or reconnect* (provider-side ownership can't be moved by Relay). |
| Pending ownership transfer | Unchanged. | Cancelled. |
| Their other workspaces | Unaffected. | Unaffected. |
| Posts, versions, approvals, comments, audit history | Kept. | Kept. Nothing is deleted. |

## Suspend someone

1. Go to **Team** ([/team](/team)) and open the person.
2. Check the **Handover** card: drafts, scheduled posts, reviews, service accounts, connected accounts and other workspaces.
3. Select **Suspend**, add an optional **Reason** (shown to admins on the member page) and confirm.
4. **Result:** the page shows **Suspended** with the reason. The dialog told you how many scheduled posts will be held.

To undo, select **Reactivate**. Access returns, but **posts held while they were suspended stay held** until someone
adopts them — Relay never releases held publishing automatically.

## Remove someone

1. Open the person on **Team**.
2. Optional but recommended: in **Handover**, choose **Reassign to** and select **Reassign** first, or pick a person in
   the removal dialog's **Hand over to** field. Choose **Nobody (hold)** to leave scheduled posts held.
3. Select **Remove**, add an optional **Reason**, and confirm.
4. **Result:** they disappear from the member list and you're returned to **Team**.

What a handover moves (only where the new person is allowed): drafts and assignments on brands they can edit, pending
review assignments, the authority behind scheduled posts (only where the new person may schedule **every** destination;
others are skipped and counted), and service-account ownership (only to someone with `service_accounts.manage`).
The confirmation lists what moved and how many items were skipped as *not authorised*.

## Leave a workspace yourself

Members can remove themselves, except the last Owner.

## Common errors

| Message | Meaning |
|---|---|
| Owners only | You're an Admin trying to act on an Owner. |
| You cannot change your own access | Use another admin, or leave the workspace. |
| A workspace needs at least one owner. Transfer ownership first. | Last-owner protection. |

## Limitations

- Removing someone doesn't sign them out of Relay; it only ends access to this workspace. Other workspaces keep working.
- Relay can't change who owns a social account on the network. Reconnect flagged accounts with an account your
  organisation controls (see [Connection health](/accounts/health)).
