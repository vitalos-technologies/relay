---
title: Pause publishing in an emergency
summary: Stop all outgoing posts for one brand or the whole workspace at once, and resume safely afterwards.
section: calendar-and-scheduling
audience: user
roles: [owner, admin, brand_manager, publisher, approver]
status: available
related: [reschedule-pause-or-cancel, delivery-statuses, schedule-a-post]
product_version: "2026-11"
reviewed: 2026-11-09
order: 45
keywords: [emergency stop, pause all, kill switch, stop publishing, crisis, resume]
---

Use a pause when something is wrong — a crisis, a mistake in a campaign, a compromised account — and nothing should go out.

## Who can pause

`publishing.pause`: Owner, Admin, Brand manager, Publisher and Approver. Pausing the **whole workspace** needs that
permission for the whole workspace (a workspace-wide role); a brand-level role can pause its brand.

## Pause the whole workspace

1. Select **Pause publishing** in the sidebar.
2. Read *Pause all of "<workspace>"?* — *Posts already sending may complete. Missed deadlines expire.*
3. Add a **Reason** (*Shown to your team*) and confirm.
4. **Result:** *Publishing paused*. Every page shows the **Publishing paused** banner; Overview shows **Workspace paused**.

## Pause one brand

1. Open **Settings → Publishing → Defaults** ([/settings/publishing/defaults](/settings/publishing/defaults)), choose the brand.
2. Select **Pause brand**, add a reason, confirm. *Posts already sending may complete. Other brands unaffected.*

## While paused

- Scheduled destinations become **Paused** — *Sends on resume if before its deadline.*
- You can keep writing, scheduling and approving. New schedules wait.
- Anything already being sent may still complete.

## Who can resume

`publishing.resume`: Owner, Admin, Brand manager and Publisher. **Approvers can pause but not resume**: they see the
**Publishing paused** banner without a **Resume** button, and the server refuses a resume from them.

## Resume

1. Select **Resume publishing** (or **Resume** on the brand banner) and confirm.
2. **Consequence:** paused posts still within their deadline are sent; **posts whose deadline passed during the pause
   expire and are never sent late**. Check **Overview** and **History** for expired posts and reschedule what still matters.

## Limitations

- A pause doesn't remove anything already published. Delete those on the network itself.
