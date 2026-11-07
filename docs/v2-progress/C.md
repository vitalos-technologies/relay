# Stream C — Collaboration (progress)

Started 2026-11-07. Migration: `012_v2_collaboration.sql`.
Owned files: `packages/services/src/collab/**`, `packages/services/src/posts/{approval-policy,versions}.ts`,
web `app/review/**`, `app/(app)/approvals/**`, `components/collab/**`, API `/api/{campaigns,comments,review,approval-policies,notification-preferences}/**`,
tests `tests/integration/v2-collab*.test.ts`.

## Milestones
- [x] 0. Read contracts/spec
- [x] 1. Migration 012 — APPLIED to dev DB 2026-11-07 (do not edit; checksum)
- [x] 2. Approval policy service (posts/approval-policy.ts) + scheduling.ts (submit/approve/reject/reschedule) + process.ts gate + brands.ts switch
- [x] 3. Versions + conflict copies (posts/versions.ts, service.ts hooks), campaigns, assignments (collab/planning.ts)
- [x] 4. Comments + mentions + notifications (collab/{comments,notifications}.ts; notify.ts delegates)
- [x] 5. Guest review portal service (collab/review.ts)
- [x] 6. API routes (approvals inbox/detail/assignment, brands/:id/{approval-policy,campaigns,assignment-options}, campaigns/:id, posts/:id/{planning,versions,comments,mentions,review-shares}, comments/:id, review/**, notification-preferences, notifications/:id/open, planner decorated)
- [x] 7. UI: approvals inbox (grouped + inline previews), detail (stages/assign/share/comments), policy card + notification prefs in settings, composer CollabPanel + conflict copy, review portal app/review/**, planner ownership, guest redirect, worker sweep
- [x] 8. tests/integration/v2-collab.test.ts (13 tests, green); engine/crops/slots approval tests still green
- [x] 9. tsc root+web clean; pnpm test 254/254; integration 238/239 (only setup.test OIDC readiness — stream A)
- [x] 10. Screenshots evidence/v2/collab-*.png (12) — shared :3000 + isolated synthetic workspace 'Northwind Collab (synthetic)' in dev DB (users *@northwind-collab.test, casey@client-northwind.test; sessions minted, no IdP identities)

## Notes
- core/authz.ts visibleBrands excludes guest grants (guests only via review shares) — report to lead.
- Existing failing (not C): slots 'two users queueing' (B: content.schedule), members/auth tsc (B/A in flight).
- Private :3200 copy was OOM-killed (box shared by 3 dev servers); removed along with DB socialite_stream_c. Screenshots taken on :3000 instead.
- STATUS: DONE 2026-11-07.
