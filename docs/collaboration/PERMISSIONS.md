# Collaboration permissions

Collaboration adds no second permission system. Every read, write, stream, notification and admin view goes through the
V2 policy (`authorize()` via `route()` → `loadAccess`) and the same brand scoping as the rest of Relay. Identity and
workspace come from the server session; ids in a request are only looked up inside the caller's workspace, and anything
the caller can't see answers **404** (existence is not revealed).

"Staff" below = a non-guest grant on the brand. Guests (expiring guest grants) only ever reach review requests explicitly
shared with them (review portal).

## Discussions

| Action | Who | Notes |
|---|---|---|
| Read internal threads | staff with `comments.internal` on the brand (all presets except guest/integration/exporter) | never guests |
| Read shared threads | staff with `content.read`; guests with an active share of the post | guests see names only, no emails, no anchors |
| Start / reply internal | `comments.internal` | |
| Start / reply shared | staff with `comments.shared`; guests with `comments.shared` **and** workspace setting "Clients can comment" | replies on a closed review are refused for guests |
| Edit a comment | its author (who can still post in the thread) | previous text kept in edit history |
| Delete a comment | author, or brand manager (`brands.manage`) for staff threads | tombstone; text + edit history removed |
| Resolve / reopen | staff who can post in that thread | resolving never approves |
| Change thread visibility | staff with both `comments.internal` and `comments.shared`, who started the thread or manage the brand | making it shared needs the exact number of comments to be exposed (`confirm_count`); stale → 409; audited |
| Mention someone | anyone who can post | candidates = active members who can see that visibility now; re-checked at send; a mention grants nothing |

## Tasks

| Action | Who |
|---|---|
| See tasks | staff with `content.read` on the task's brand (guests never) |
| Create | staff who edit, submit, review or manage the brand (`content.edit` / `content.submit` / `content.approve` / `brands.manage`) |
| Assign to someone else | as above; if the workspace sets "Brand managers only", `brands.manage` |
| Be assigned | active staff with `content.read` on the brand (checked at assign time and by the offboarding sweep) |
| Edit / change status / reassign | creator, assignee, or brand manager; optimistic concurrency (`expected_version`) |
| Follow | any staff who can see it |

Completing or cancelling a task never approves, schedules or publishes anything; a task's deadline never changes a schedule.

## Reviews

| Action | Who |
|---|---|
| Request named reviewers | `content.submit` or `content.approve` on the brand; each person must be eligible for a stage of the request's policy (roles, teams, guests, separation of duties); self-requests refused |
| Decide | unchanged: the approval engine (eligible for the current stage, distinct people, quorum, SoD, binding to the exact revision) |

## Presence, events, notifications

| Thing | Rule |
|---|---|
| Presence | only for people who can read the post (staff); listed people must still be active members who can read it; workspace can turn it off |
| Change stream / polling | per event audience: internal → `comments.internal`; shared → staff or shared guest; staff → staff `content.read`; user → that person. Access is re-checked every 15 s; revoked → stream ends |
| Notifications | recipient entitled when created, when a delayed email is sent and every time the feed is read |
| Notification centre | your own notifications only |

## Admin (`/admin/collaboration/**`)

| Page / API | Needs |
|---|---|
| Overview | `content.read` (counts limited to visible brands); delivery numbers need `workspace.manage` |
| Reassign work | list: `content.read`; move: `members.manage`; each item only moves to someone who can see its brand |
| Notification delivery + retry | `workspace.manage`; metadata only (type, recipient, state, error code) |
| Collaboration settings | read: anyone; change: `workspace.manage` (audited) |
| Eligible reviewers | `content.read` on the brand |
| Platform → Collaboration pipeline | platform operator/support; counts and ages only, no workspace content or names |

## Database roles

`socialite_app` / `socialite_worker`: DML on the new tables; `collab_task_events` is append-only (UPDATE/DELETE revoked,
like `audit_events`); `comment_edits` rows are immutable (trigger) and only deleted with a tombstoned comment.

## Untrusted content

Comment bodies, mention labels, anchors and imported text are untrusted: control/bidi characters are stripped, markup is a
fixed tiny subset rendered as React text nodes (never HTML), links are http(s) only with `rel="noopener noreferrer
nofollow"`. Collaboration content is never sent to the AI assistant or MCP as instructions — the assistant only reads the
draft, and no MCP tool exposes discussions, tasks or notifications.
