---
title: Transfer workspace ownership
summary: Hand the Owner role to another member safely; the new owner must accept, and the workspace always keeps at least one owner.
section: teams-and-approvals
audience: user
roles: [owner]
status: available
related: [suspend-or-remove-a-member, roles-and-permissions, step-up-verification]
product_version: "2026-11"
reviewed: 2026-11-09
order: 51
keywords: [owner, change owner, ownership, last owner, accept ownership, decline, cancel transfer]
---

Ownership never changes through the role picker. It moves only through a transfer that the new owner accepts.

## Before you start

- **Required:** you are an **Owner** (`workspace.transfer_owner`). Relay asks you to sign in again (step-up) and, when
  your policy requires it for owners, to use your second factor.
- The new owner must be an **active** member who isn't already an owner.
- Only one transfer can be pending per workspace.

## Propose the transfer

1. Go to **Team** ([/team](/team)) and open the member.
2. Select **Make owner**. Read *Requires fresh sign-in. They must accept within 7 days.*
3. Choose what happens to you after they accept: **Stay as Admin** (default) or **Give up your access** (you keep only
   other roles you already hold, if any). Select **Send transfer**.
4. **Result:** "Transfer sent — they must accept". The person is notified in the app. The proposal **expires after 7 days**.

While it's pending, **Team** and the member's page show *Ownership transfer to <email> pending*, with who sent it and
when it expires.

## Accept or decline (new owner)

The new owner doesn't need any Team permissions: a banner at the top of **every page** says
*<email> wants you to become the owner of <workspace>*, with the expiry. The notification leads there too.

- **Accept ownership:** confirm, then complete a fresh, two-step-verified sign-in if Relay asks. **Result:** in one step
  you become Owner and the previous owner becomes **Admin** (or keeps no admin role, if they chose that). Owners and
  admins are notified.
- **Decline:** confirm. The current owner stays the owner and is notified that you declined.

## Cancel a pending transfer

On **Team** or the member's page, select **Cancel transfer** and confirm. The proposed owner is notified. The person
who proposed it, the proposed owner (by declining) and any owner can end a pending transfer. Every step is recorded in the
audit log: proposed, accepted, declined, cancelled.

## What can stop a transfer

| Message | Meaning |
|---|---|
| An ownership transfer is already pending. Cancel it first. | Only one at a time. |
| This transfer has expired. Ask the owner to start a new one. | More than 7 days passed. |
| The proposing owner is no longer an owner. This transfer is not valid. | The proposer lost ownership meanwhile. |
| Confirm it's you to continue. | Step-up needed; sign in again. |

Removing either person cancels a pending transfer automatically.

## Limitations

- The banner shows the transfer for the workspace you have open. If you belong to several workspaces, switch to the one
  named in the notification.
