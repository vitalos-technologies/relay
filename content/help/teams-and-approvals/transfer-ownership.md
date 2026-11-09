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
keywords: [owner, change owner, ownership, last owner]
---

Ownership never changes through the role picker. It moves only through a transfer that the new owner accepts.

## Before you start

- **Required:** you are an **Owner** (`workspace.transfer_owner`). Relay asks you to sign in again (step-up) and, when
  your policy requires it for owners, to use your second factor.
- The new owner must be an **active** member who isn't already an owner.
- Only one transfer can be pending per workspace.

## Propose the transfer

1. Go to **Team** ([/team](/team)) and open the member.
2. Select **Make owner**, read *Requires fresh sign-in. They must accept; you stay as admin.*, and select
   **Send transfer**.
3. **Result:** "Transfer sent — they must accept". The person is notified in the app. The proposal **expires after 7 days**.

## Accept (new owner)

1. Open **Team**. A banner says *<email> wants you to become the owner*.
2. Select **Accept ownership**. You need a fresh, two-step-verified sign-in.
3. **Result:** in one step you become Owner and the previous owner becomes **Admin**. Owners and admins are notified.

## What can stop a transfer

| Message | Meaning |
|---|---|
| An ownership transfer is already pending. Cancel it first. | Only one at a time. |
| This transfer has expired. Ask the owner to start a new one. | More than 7 days passed. |
| The proposing owner is no longer an owner. This transfer is not valid. | The proposer lost ownership meanwhile. |
| Confirm it's you to continue. | Step-up needed; sign in again. |

Removing either person cancels a pending transfer automatically.

## Limitations

- The app always keeps the previous owner as **Admin**; to remove them afterwards, the new owner removes or changes them
  like any member.
- The **Accept ownership** banner is shown on the Team page, which needs `members.read`. A recipient whose roles don't
  include it (for example an Editor) can't see the banner; give them Admin first, or ask Relay support.
- There is no button to cancel or decline a pending transfer in the app today; it lapses after 7 days, or ends when
  either person is removed. (Reported as a gap.)
