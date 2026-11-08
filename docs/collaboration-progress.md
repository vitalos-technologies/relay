# Collaboration completion — progress (resume point)

Brief: `docs/queue/03d_COLLABORATION_PROMPT.md` (sections 1–15). Migration: `packages/db/migrations/027_collaboration.sql`
(additive; follow-ups go in 028). No git. Checkpoints → `evidence/collaboration/checkpoints/<n>-<area>-<theme>.png` (1440, DSF 2).

## Decisions
- Extend V2 stream C, no parallel subsystem: `comments` stay the comment store; 027 adds `comment_threads` (every comment
  belongs to a thread; legacy comments backfilled as one-comment threads with thread id = comment id, plus a BEFORE INSERT
  compat trigger). Visibility lives on the thread; a trigger refuses a comment whose visibility differs from its thread.
- Visibility change = explicit `PATCH /api/threads/:id` with `confirm_count` (number of comments that become visible);
  stale count → 409. Audited. Replies never change visibility on their own.
- Delete = tombstone (body replaced, edit history rows removed, who/when kept). Edit history = immutable `comment_edits`.
- Mentions: identity tokens `@[<uuid>]` in the body; display names resolved at read time (removed members shown as
  "Former member"). Notified once per (comment, user) via the existing dedupe key; edits only notify newly added people.
  Candidate search is bounded (prefix search, ≤ 8 results), entitlement checked per candidate. Individual mentions only.
- Tasks: new `collab_tasks` (+ followers, immutable events). Linked to a post, campaign or review request. Completing a
  task never approves or publishes; task due dates never touch schedules. Offboarding: worker sweep flags/unassigns tasks
  whose assignee lost access (workspace policy `flag` | `unassign`); admin reassign page.
- Reviews: approval engine unchanged in authority; adds requested reviewers (eligibility = stage eligibility), outbox
  `approval.invalidated`, overdue sweep, "Request changes" = reject with reason.
- Notifications: one pipeline (`deliverNotification`), new queue `collab-notify` (workload class notifications) so
  publishing (`delivery-due`) never waits behind it. Email states gain `failed` / `not_configured` (never "sent" without
  SMTP). Deep links stored as `link_path`. No comment text in any notification or email.
- Realtime: `collab_events` (id-ordered, content-free) written in the same transaction as the change; SSE stream
  `/api/collab/stream` (re-checks access every 15 s, closes on revocation, 55 s lifetime, Last-Event-ID resume) with JSON
  polling fallback `/api/collab/events`. Clients refetch the affected resource; ids make replays harmless.
- Presence: `post_presence` heartbeats (20 s), live 60 s, "recent" 5 min, rows purged after 10 min. Informational only.
- Concurrency: existing autosave/conflict (021) extended in the client: field-level compare, apply selected changes to
  latest, copy mine, discard mine (explicit). Remote-save notice via the event stream.
- History: paginated version metadata with change summaries; compare endpoint (lazy); restore = new version (existing).

## Status
- 2026-11-07: started; inventory + design done.
- Backend done: migration 027 APPLIED to dev (frozen; follow-ups → 028) + db:roles re-run (collab_task_events append-only).
  Services collab/{comments (threads), events, settings, tasks, presence, reviewers, notification-center, history, admin, sweeps};
  API routes; worker queue `collab-notify` + `collab-sweeps` loop (WORKER NEEDS REBUILD + RESTART once UI lands).
- tests/integration/collab-complete.test.ts 11/11 + v2-collab 13/13 green.

## Done
- Backend + integration tests (see Files).

- UI done (production build on :3000, worker rebuilt): composer collaboration panel (sticky side column at ≥1280, sheet below),
  presence, remote-save banner, 3-way conflict dialog (apply selected / keep as new draft / copy / discard), /tasks, /notifications,
  bell, planner indicators, approvals detail (discussion, reviewers, tasks), review portal threads, admin pages + platform page.
- Lead review notes 1–5 addressed (sticky side column, two-line mention menu, chips + "Unread only", read-time context +
  actor headlines + merged review notifications + friendly due dates, "Created by me").
- tests/unit/collab.test.ts 10/10; tests/e2e/collaboration.spec.ts 5/5 (+1 desktop skip of the @mobile test).
- Demo data: scripts/seed-collab-demo.ts (Demo Workspace, synthetic); shots: scripts/collab-shots.mjs.

## Next
- Full screenshot set (1440 + 390, both themes), mobile QA script, perf + sync latency script, docs (7), full verification.

## Files
- new: scripts/{seed-collab-demo.ts,collab-shots.mjs}, tests/unit/collab.test.ts, tests/e2e/collaboration.spec.ts,
  apps/web/lib/client/collab.ts, apps/web/components/collab/{comment-text,discussion,tasks,review-panel,presence}.tsx (+ rewritten collab-panel,
  history-panel; comments-panel.tsx removed), apps/web/app/(app)/{tasks,notifications}/page.tsx, apps/web/app/(admin)/admin/collaboration/**,
  apps/web/app/(admin)/admin/platform/collaboration/page.tsx,
  packages/db/migrations/027_collaboration.sql, packages/core/src/collab.ts, packages/services/src/collab/{events,settings,tasks,presence,
  reviewers,notification-center,history,admin,sweeps}.ts, apps/web/app/api/{posts/[id]/{threads,threads/read,presence,history,compare,activity},
  threads/**, comments/[id]/history, tasks/**, approvals/[id]/{reviewers,reviewer-options}, notifications/[id]/unread, collab/{events,stream},
  collaboration/settings, admin/collaboration/**, platform/collaboration}, tests/integration/collab-complete.test.ts
- edited (collab-owned): packages/services/src/collab/{comments (rewritten on threads, same exports),notifications,inbox,planning,review,index}.ts,
  apps/web/app/api/{comments/[id],posts/[id]/mentions,notifications,review/[id]/comments}/route.ts
- edited (shared, small/additive): packages/core/src/index.ts (export collab), packages/services/src/outbox.ts (event types),
  engine/outbox-dispatcher.ts (QUEUE_COLLAB routing), engine/notify.ts (4 cases), workload/policy.ts (queue class),
  posts/approval-policy.ts + posts/service.ts (approval.invalidated outbox; post.saved event), data/drafts.ts (post.saved event),
  apps/worker/src/main.ts (collab-notify consumer, collab-sweeps loop, retention), infra/postgres/roles.sql (append-only task events),
  product/activity.ts (collaboration audit category), apps/web/components/composer/{composer,draft-resilience,editors}.tsx,
  apps/web/components/shell/{app-shell (Tasks nav),notification-bell}.tsx, apps/web/components/planner/agenda-item.tsx,
  apps/web/components/admin/nav.tsx, apps/web/app/(admin)/admin/help/page.tsx, apps/web/app/(app)/{activity,approvals/[id]}/page.tsx,
  apps/web/app/review/[id]/page.tsx, apps/web/lib/client/{api (keepalive),types}.ts, apps/web/components/collab/notification-prefs.tsx

## Lead review notes (checkpoints 1–4) — to fix
1. 1440: composer column blank when the panel is scrolled into view → region 3 becomes a sticky, independently scrolling aside; deep links scroll inside it.
2. Mention menu: name truncates → name first line, email second line.
3. Notifications page: duplicate "All" controls → type chips (no "All") + "Unread only" toggle.
4. Notification rows need context (post/task title), actor-led headline ("Eden mentioned you"), no duplicate review-request
   notifications (merge into the stage notification), friendly due dates ("Sat 7 Nov, 08:03").
5. Tasks summary card "I created, open" → "Created by me".

## Lead review round 2 — fixed
1. Notification rows: one detail line ("task · post · due Sat 7 Nov, 08:03 GMT"); stored reminder bodies are only the due date.
2. Panel tabs: icon-only for inactive tabs (name in sr-only + tooltip), active tab labelled; tighter padding so five fit at 1440.
3. Diffs (history + conflict): a space between a removed and an added token.
Also: approval page puts Discussion right after Review; reviewers card without a duplicate heading; admin nav exact match for
Collaboration › Overview; plain-wording admin tiles ("Needs attention" / "On track").

## Verification state (2026-11-07 ~22:00)
- typecheck clean; unit 505/505; integration 413/413 (52 files); collaboration E2E 5/5; mobile QA 0 overflow, 8/8 workflows;
  V3.1 browser budgets all within (composer 364 KB after lazy-loading non-default tabs); secret scan clean (incl. untracked).
- Lead round 3: conflict dialog actions stack full-width on phones in priority order; "Copy my text" is a secondary button with icon.
- Changed in other streams' files for compatibility: tests/e2e/v31-ui.spec.ts (new conflict dialog wording/flow),
  scripts/v31-browser-perf.mjs (nav link name with a pending-approvals badge), apps/web/app/api/auth/backchannel-logout
  (rejection reason in the warn log). security.spec back-channel test fails when the approver has other live Keycloak
  sessions; collaboration.spec therefore uses Tom (editor) as the second person.
- Media anchors now validated against the post's brand (+ integration assertion).
- Docs: docs/collaboration/{COVERAGE_MATRIX,USER_GUIDE,PERMISSIONS,NOTIFICATIONS,CONCURRENT_EDITING,TEST_REPORT,IMPLEMENTATION_GAPS}.md
- FINAL (2026-11-07 ~23:30, production build, worker rebuilt): full E2E 56 passed / 1 skipped / 0 failed; checkpoints
  `evidence/collaboration/checkpoints/<n>-<area>-<theme>.png` (light+dark) and full set `evidence/collaboration/<screen>-{1440,390}-{light,dark}.png`;
  composer side column widened to 364 px at ≥1280 so all five panel tabs fit.

## Status: done (report sent to lead)
