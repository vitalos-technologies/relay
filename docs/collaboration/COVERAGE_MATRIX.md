# Collaboration coverage matrix

Brief: `docs/queue/03d_COLLABORATION_PROMPT.md`. Baseline = what V2 stream C (`docs/v2-progress/C.md`, migration 012) and
V3.1 DATA (021) already had. Status: **existed** (kept as is), **repaired** (existing code fixed or extended), **added**
(new in this stream, migration 027). Evidence = the test that proves it (I = `tests/integration/collab-complete.test.ts`,
V2 = `tests/integration/v2-collab.test.ts`, U = `tests/unit/collab.test.ts`, E = `tests/e2e/collaboration.spec.ts`,
M = `scripts/collab-mobile-qa.mjs`).

## 1. Baseline inventory

| Area | Before this stream | Now |
|---|---|---|
| Workspaces / teams / brands / memberships | V2 scoped grants, teams, brand scoping (`authorize()`) | existed — every collaboration path uses it |
| Drafts + immutable revisions | `post_versions` (V2), `post_revisions` (V1), autosave + recovery (V3.1) | existed; history UI + compare **added** |
| Comments + client-visible feedback | flat comments, internal/shared, guest review portal | **repaired** into threads (027) |
| Assignments + approvals | post assignee/due (planning), review assignee, approval policies (stages, quorum, SoD) | existed; tasks + requested reviewers **added** |
| Notifications + activity | in-app + email + digest + quiet hours, entitlement re-check | **repaired** (deep links, delivery states, own queue, centre page) |
| Realtime | none (polling per page) | **added** change feed + SSE |
| Admin controls | approval backlog only | **added** collaboration admin + platform view |
| Mobile | composer steps, approvals | **added** collaboration sheet + workflows verified |

## 2. Threaded comments

| Requirement | Status | Where | Evidence |
|---|---|---|---|
| Threads on posts and on review requests, replies | added | `comment_threads`, `collab/comments.ts` | I "two users…", E |
| Explicit internal / client-visible threads | repaired (visibility moved to the thread; DB trigger keeps comments in line) | 027 `comments_visibility_matches_thread` | I "internal threads never reach a client" |
| Resolve / reopen | added | `setThreadResolved` | I |
| Edit history + delete tombstones | added | `comment_edits` (immutable), tombstone on delete | I "edit history and delete tombstones" |
| Link to a specific revision | added | `anchor_version`, `anchor_revision_id` (review threads) | I, UI badge "Review r3" / "From v2" |
| Unread indicators | added | `comment_thread_reads`; planner + tab badge | I |
| Deep links to threads | added | `/posts/:id?thread=…`, `/approvals/:id?thread=…`, `/review/:id?thread=…` | E, M workflow 1 |
| Accessible sanitised rich text | added | `sanitizeCommentBody`, `tokenizeComment` (text nodes only) | U |
| Selected text / media anchor, preserved, flagged outdated | added | `parseAnchor`, `anchorStatus` | U, I |
| Internal content never in client threads, emails, search, exports, notifications, realtime | added + verified | audience filter (`collab/events.ts`), entitlement at send, generic email titles; comments are not indexed in search or exported | I, E |
| Visibility change is explicit and authorised; never silent | added | `setThreadVisibility` with `confirm_count` (409 when stale), audited | I |
| Commenting never approves | verified | approvals only through the approval engine | I, E |

## 3. Mentions

| Requirement | Status | Where | Evidence |
|---|---|---|---|
| Searchable real identities, bounded | repaired (was: first 300 members, no search) | `mentionCandidates(q)` ≤ 40 scanned, ≤ 8 returned | I |
| Suggest only people with access to workspace, brand, post and visibility | existed (per visibility) → kept | same | I |
| Keyboard-accessible menu; name vs identity | added | `MentionTextarea` (combobox/listbox, ↑/↓/Enter/Esc; name + email) | E, M |
| Store identity references | added | `@[uuid]` tokens; names resolved at read | U, I |
| Notify once per comment event; no repeats on edits | repaired | `comment.edited` only notifies newly added people | I |
| Removed/deactivated members | added | skipped at send; shown as "Former member" | I |
| Mentions never grant access | verified | entitlement at send; outsider gets nothing and still 404s | I |
| Team mentions | not built (needs its own permission + rate limits) | — | `IMPLEMENTATION_GAPS.md` |
| Rate limits | added | 30 comments/min, 100 mentions/h per person | code |

## 4. Tasks + deadlines

| Requirement | Status | Where | Evidence |
|---|---|---|---|
| Tasks linked to post / campaign / review: title, description, assignee, creator, due + time zone, priority, status, activity, reassignment, followers | added | `collab_tasks`, `collab_task_events`, `collab_task_followers` | I "tasks + deadlines", E |
| Views: Assigned to me, Created by me, Team workload, overdue/upcoming, next action | added | `/tasks`, `listTasks`, `taskWorkload` | E, screenshots |
| Completion never approves/publishes; deadline ≠ publication time | verified | no engine calls; schedule unchanged | I |
| Offboarding policy + work needing reassignment | added | `runOffboardingSweep` (flag / unassign), `/admin/collaboration/reassign` | I "revoked access…" |

## 5. Reviewer requests + notifications

| Requirement | Status | Where | Evidence |
|---|---|---|---|
| Request review from eligible reviewers (engine eligibility) | added | `approval_reviewer_requests`, `requestReviewers` | I "reviews" |
| Notify reviewers; request changes with reason; notify author | existed (stage notifications, reject + reason) → kept, merged duplicate | `inbox.ts`, `reviewers.ts` | I, M workflows 5–6 |
| Notify on approved / rejected / invalidated / overdue | repaired (invalidated + overdue added) | outbox `approval.invalidated`, `runReviewOverdue` | I |
| Status against the exact revision | existed (binding) → shown | Review tab + history revisions | I |
| Quorum, SoD, no self-approval; "approved" comments never count | existed + verified | approval engine | V2, I |
| Content/media/destination/schedule changes invalidate per policy | existed + now notified | `invalidatePendingApprovalIfChanged`, `invalidateRequest` | I |
| Notification centre (read/unread, filters, deep links, preferences) | added | `/notifications`, `listNotificationFeed`, bell | I, E |
| Quiet hours, time-zone-aware bounded reminders | existed (quiet hours) + added (reminders) | `reminderDue`, `runTaskReminders` | U, I |
| Durable background pipeline; email if configured; access re-checked at delivery; no private content in email | repaired | queue `collab-notify`, states `not_configured`/`failed`, generic titles | I |

## 6–8. Presence, concurrent editing, history

| Requirement | Status | Where | Evidence |
|---|---|---|---|
| Presence: viewing / editing / recent / offline, heartbeats with expiry, cleared on leave and revocation, informational only | added | `post_presence`, `presence.ts`, `usePresence` | I |
| Revision-based optimistic concurrency, autosave states | existed (V3.1) | `data/drafts.ts` | V3.1 tests |
| Detect others' changes while editing; revalidate after reconnect | added | `post.saved` events, recovery-status on reset | E |
| Conflict choices: review differences, copy mine, apply selected to latest, discard explicitly | repaired (was take theirs / keep both / use mine) | `DraftConflictDialog` (3-way defaults) | E, M workflow 8 |
| Never silently overwrite a newer revision | existed + verified | server 409 + conflict copy | I, E |
| History: author, time, change summary, approval state, publication references | added | `listVersionHistory` | I |
| Compare text, per-network, media, links, destinations, scheduling, options (lazy) | added | `compareVersions` | I, E |
| Restore as a new version; never rewrite history or restore approvals | existed + verified | `restoreVersion` | I, E |
| Which comments/approvals refer to older revisions | added | open-thread counts per version, "Older than current", anchor badges | I |

## 9–15

| Requirement | Status | Where |
|---|---|---|
| Panel in composer + post detail: Discussion, Tasks, Review, Activity, History | added | `components/collab/collab-panel.tsx` (side column ≥ 1280 px, sheet below) |
| Planner: assignee, review status, deadlines, unread | repaired (unread + open tasks added) | `components/planner/agenda-item.tsx` |
| Admin integration (permissions, reviewers, backlogs, reassign, defaults, client access, audit, delivery diagnosis; platform health without content) | added | `/admin/collaboration/**`, `/admin/platform/collaboration` |
| Permissions + security tests | added | I, E, `PERMISSIONS.md` |
| MCP | not exposed (no collaboration tools); see gaps | — |
| Mobile 320–768 | verified | M (`evidence/collaboration/mobile-qa.json`) |
| Performance + sync | measured | `evidence/collaboration/perf-collab.json`, `TEST_REPORT.md` |
| Docs + contextual help | added | this folder; InfoTips in panels; admin help topics |
