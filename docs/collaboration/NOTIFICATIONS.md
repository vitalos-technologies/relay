# Collaboration notifications

One pipeline for every collaboration event (comments, mentions, tasks, reviews, reminders), built on the V2 notification
service (`packages/services/src/collab/notifications.ts`). In-app delivery never depends on email.

## Flow

1. A change commits together with an **outbox** row (`comment.created`, `comment.edited`, `task.changed`,
   `approval.requested`, `approval.decided`, `approval.invalidated`, `review.reviewers_requested`, `assignment.changed`,
   `review.shared`) and a content-free **change-feed** row (`collab_events`) — nothing is confirmed before it is stored.
2. The worker's dispatcher moves outbox rows to pg-boss with deterministic job ids. Collaboration events go to their own
   queue, **`collab-notify`** (workload class `notifications`: ≤ 2 at a time per worker, never deferred, separate from the
   `delivery-due` publishing queue), so a comment or reminder burst can't delay publishing.
3. The handler works out recipients and calls `deliverNotification` once per person:
   - **entitlement now** (still a member, still allowed to see that thread / post / review) — otherwise skipped;
   - the person's channel choice for the type (own setting → workspace default → product default);
   - **insert once** per `(user, dedupe_key)` — duplicated or replayed events can't create a second notification;
   - quiet hours (person's time zone) defer the email, never the in-app item;
   - a `notification` change-feed event for the recipient (their bell refreshes on open pages).
4. Email (if SMTP is configured) is sent immediately or by the worker sweep after quiet hours / for the daily digest. The
   recipient's access is re-checked right before sending.

## What a notification contains

- **Stored title**: generic (“You were mentioned in an internal note”, “A task is due soon”, “Your review was requested”).
  This is the only text an email or a lock screen ever shows, plus a link.
- **No comment text, post text or task details** are stored in, or sent by, a notification. The in-app feed adds context
  at read time from the live record (post title for staff, “Review · <brand>” for client guests, task title) and an
  actor-led headline (“Eden Editor mentioned you”). If access is gone, the item disappears from the feed.
- **Deep link** (`link_path`, relative only): the thread (`/posts/:id?thread=…`, or `/review/:id?thread=…` for guests), the
  task (`/tasks?task=…`) or the review (`/approvals/:id`). Opening a link only navigates; it never approves or publishes.

## Types and defaults

| Type (preference key) | Sent when | In app | Email |
|---|---|---|---|
| Mentions (`mention`) | someone mentions you (new comment, or newly added in an edit) | on | on |
| Replies and client comments (`comment`) | a reply in a discussion you started or joined; a client comments on your review | on | off |
| Review requests (`review_requested`) | you're eligible for the current stage, or someone asks you specifically (merged into one item) | on | on |
| Review decisions (`review_decided`) | your post is approved, changes are requested, or a review is reset because the post changed | on | off |
| Tasks and assignments (`assignment`) | a task or review is assigned to you; a task you follow is done, cancelled or blocked; a task needs a new assignee | on | on |
| Deadline reminders (`reminder`) | a task is due within the workspace lead time (default 24 h), overdue, or a review passes its review date | on | off |

Workspace admins set defaults for people who haven't chosen (Admin → Collaboration settings). People change their own in
Settings → Personal → Notifications (in app / email / daily digest, time zone, quiet hours).

## Reminders (bounded)

- One “due soon” per deadline (inside the lead time), then at most **N** overdue reminders (default 3), at least 24 h apart.
- Moving a deadline starts a new (bounded) series; it never changes a schedule.
- Shown in the task's own time zone (“Due Mon 11 Mar, 02:00 GMT+9”); the email is deferred by the recipient's quiet hours.
- Overdue reviews notify the assignee / requested reviewers and the requester once per review request.
- The sweep runs every minute in the worker (`runCollabSweeps`) and handles ≤ 200 tasks per pass.

## Email delivery states

`none` (in-app only) · `pending` (waiting for quiet hours or a retry) · `digest` · `sent` · `skipped` (recipient lost
access) · `not_configured` (no SMTP — **never shown as sent**) · `failed` (refused 3 times, 5/10 min backoff). Admins see
problems with the reason code and can retry (Admin → Collaboration → Notification delivery); platform operators see
installation-wide counts only.

## Dedupe keys

`mention:<comment>` · `reply:<comment>` · `comment:<comment>` · `approval:<id>:stage:<n>` · `approval:<id>:req:<user>`
(merged into the stage item when it exists) · `approval:<id>:<decision>` · `approval:<id>:invalidated` ·
`approval:<id>:overdue` · `task:<id>:<kind>:<event>` · `task:<id>:soon:<due>` · `task:<id>:overdue:<due>:<n>` ·
`task:<id>:offboard:<user>`.

## External activation

Email needs `SMTP_URL` + `EMAIL_FROM` (Instance setup or the deployment secret manager). Development uses Mailpit. There is
no push/mobile notification channel.
