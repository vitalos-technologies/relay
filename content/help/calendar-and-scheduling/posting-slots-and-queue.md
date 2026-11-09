---
title: Use posting slots and the queue
summary: Set recurring posting times per brand, add posts to the next free slot with one click, and run an evergreen content queue.
section: calendar-and-scheduling
audience: user
roles: [owner, admin, brand_manager, publisher, editor]
status: available
related: [schedule-a-post, time-zones-and-dst, use-the-planner, feature-flags]
product_version: "2026-11"
reviewed: 2026-11-09
order: 50
keywords: [slots, queue, recurring times, posting schedule, evergreen, best time]
---

## Set up posting slots

**Required:** `brands.manage` on the brand to change slots (Brand manager, Admin, Owner); others see **View only**.

1. Open **Settings → Publishing → Posting slots** ([/settings/publishing/slots](/settings/publishing/slots)) and choose the **Brand**.
2. Select **Add slot** and fill in:
   - **Days** (at least one), **Time**, **Time zone**.
   - **Destinations**: the connected accounts this slot publishes to (simulated accounts are labelled).
   - Optional **Label** (for example *Morning*) and **Active**.
3. Select **Save**.

**Next 14 days** previews upcoming slot times and what's already in them (**Free**, or the post's title). *Times use each
slot's own zone. A time skipped by a clock change is shown; a repeated hour uses the first one.*

Editing or deleting a slot never moves posts already queued (*Posts already queued keep their time*).

## Add a post to the queue

1. In the editor, select **Add to queue** (desktop button, or **⋯ → Add to queue**). Its hint: *Next free slot (uses the
   slot's destinations)*.
2. **Result:** "Queued" with the time, for example *Tue 2 Dec 2026, 09:00 GMT*. On brands that require approval the
   post is **submitted for review** for that slot instead ("Queued for review").

The post uses the **slot's destinations**, and normal checks and approval rules apply. If there are no slots you see
*No posting slots*; add one first.

## Evergreen content queue (optional feature)

When an admin turns on **Evergreen content queue** in [Feature flags](/help/administration/feature-flags):

- In a post's **Reuse** card, mark it **Evergreen** and add it to the content queue (eligible posts only).
- **Content queue** (from the planner's **Queue** button) lists queued posts as **Eligible**, **Skipped** or **Used**.
- **Schedule next** places the next eligible item into the next free slot. Each item is used once; slots never repost
  the same content.
- **Pause** / **Resume** the queue; **Remove** an item (*The post itself isn't changed*).

## Limitations

- The queue fills the next free slot only; there's no automatic "best time" prediction.
