# Copy cleanup — stream CA (main app: create & publish)

Status: done (pending lead review). Presentation/copy only — no route, validation, auth, event, API field or persisted-value
changes. Inspected rendered screens before and after (session rows inserted like `scripts/v4-final-shots.mjs`; inspection
script kept in the session scratchpad). Text dumps: `evidence/copy/ca/before/text/`, `evidence/copy/ca/after/text/`.

## Finding
The CA screens were already terse from earlier passes (V3–V5). The remaining noise was mostly repetition in one context
(same state shown twice, the same "Simulated" label three or four times per card), implementation details (policy
version, env-var names and OAuth redirect URIs shown to every member), one broken accessible label and one mobile
overflow. Those are what changed; everything else was left as is on purpose.

## Changes (before → after)
- Connection health: "← Accounts / Account health / [9 healthy] … All destinations healthy … 9 healthy" →
  "← Connections / Connection health … All connections healthy … 9 healthy" (the summary badges show only when
  something needs attention). Overview "All accounts healthy" → "All connections healthy" (nav term is Connections).
- Content sources (Connections page + Settings): "Not configured — An owner adds GOOGLE_CONTENT_CLIENT_ID, … in Setup.
  Redirect URI: http://…/callback" → owners: "Not set up — Add GOOGLE_CONTENT_CLIENT_ID, … in Setup." + Setup link (the
  redirect URI lives in Setup's own hint); everyone else: "Not set up — An owner can set this up." Picker banner
  "File picker not configured (GOOGLE_PICKER_API_KEY, GOOGLE_PICKER_APP_ID)" → "File picker not set up" + the same
  owner/non-owner line. Errors: "The provider did not accept the authorization." / "The connection could not be
  completed." → "Couldn't connect. Try again."; "This source is not configured yet." → "Not set up yet."
- Team: removed the "v3" policy-version chip beside the Team title and "policy v3" beside "Effective access".
  Permission chips "Brand · Accounts · Connect accounts" → "View brand · Connections · Manage connections" (the old
  "Brand" chip sat in the "Brand" row).
- Notifications: publishing rows read "Partial: event reminder · Post: Partial: event reminder Missed: …" — the
  duplicated "Post: <title>" line is dropped on display when it equals the context line (stored body unchanged).
- Approvals list: the "Waiting" badge on every row of the Waiting view is gone (the filter already says it); "Your turn"
  stays, decided rows keep Approved / Changes requested. At 390 px titles now show in full instead of "Supper club: spr…".
- Post page (published / read-only): banner "Delivered to simulated destinations · read only" + Duplicate + Edit →
  "Already sent" + Edit (status badge already says "Simulated · delivered"; the sticky bar already has "Read only" +
  Duplicate). "Shared by N destinations" in the editor header now shows only below 1024 px (the content switcher shows it
  on desktop).
- Delivery card: published simulated deliveries showed "Simulated" badge + "Simulated delivery <time>" + "Simulated ·
  delivered" + "Simulated result" → badge omitted for published simulated rows (state badge says it), "Delivered <time>".
  Non-published simulated rows keep the badge.
- Preview header: dropped the per-preview "Simulated" chip (it repeated the destination card / name; demo banner and
  destination labels still say simulated). Fixes "Approximate preview" wrapping on approval detail.
- Planner/Overview destination icons: accessible label read "Facebook (simulated): undefined" for posts awaiting approval →
  "Facebook (simulated): Not scheduled yet".
- Setup: "Env" badge + "From environment" line → "Set" badge + "From environment"; long hints/redirect URIs now wrap
  (fixed page-level horizontal scroll at 320–430: scrollWidth 461 at 390 before).
- Invite: removed the "Status: Pending" fact (an unusable invite already shows "No longer valid — ask for a new one").
- Signup: "You'll sign in or create an account, then name your workspace. You're billed for the active members in your
  workspace when you subscribe; …" → "Next, sign in or create an account and name your workspace. When you subscribe,
  you're billed per active member; Billing shows the seats and total before you buy. Prices in GBP; any tax is shown at
  checkout." (all billing facts kept).
- Info tips tightened: presence ("updated every 20 s" implementation detail removed), quorum, tasks, limits ("Run Check
  on Accounts" → "Connections"); "Expired. Start again from Accounts." / "Accounts" button on Choose destinations →
  "Connections"; video upload error → "Upload failed. Check your connection and try again."

## Files (all CA-owned)
`app/(app)/accounts/health/page.tsx`, `app/(app)/accounts/select/page.tsx`, `app/(app)/approvals/page.tsx`,
`app/(app)/notifications/page.tsx`, `app/(app)/overview/page.tsx`, `app/(app)/setup/page.tsx`, `app/(app)/tasks/page.tsx`,
`app/(app)/team/page.tsx`, `app/(app)/team/members/[userId]/page.tsx`, `app/(app)/team/teams/[id]/page.tsx`, `app/invite/[token]/page.tsx`, `app/signup/page.tsx`,
`components/collab/presence.tsx`, `components/collab/stage-progress.tsx`, `components/composer/composer.tsx`,
`components/composer/editors.tsx`, `components/composer/preview.tsx`, `components/content-hub/source-connections.tsx`,
`components/deliveries/delivery-card.tsx`, `components/media/video-upload.tsx`, `components/planner/agenda-item.tsx`
(all under `apps/web/`). Test text: `tests/e2e/v2-product.spec.ts` ("Account health" → "Connection health").

## Requests for the lead / other streams (not edited — outside CA)
- Server messages (CC: `packages/services`): `posts/service.ts` readiness "…needs attention (…). Fix it on Accounts or
  deselect it." and `engine/process.ts` "…Fix it on Accounts; this post will resume…" → say "Connections". `engine/
  claim.ts` stored message "Missed: the publish-before deadline passed before this could be sent (for example during
  downtime or a pause). Review and reschedule if still relevant." is long and repeats in Overview/Notifications; the
  shorter `process.ts` variant ("Missed: the publish-before deadline passed. Review and reschedule if still relevant.")
  would do. `engine/notify.ts` connection-health body "Open Accounts to see the exact fix…" → "Connections".
- Shared `ErrorState` (CC) on an unknown invite shows "Not found" above "Invitation not found" plus a reference id.
- Activity (Audit log) and Operations pages are in no stream's list; not touched.
- Dev host: `.data/web.pid` stores the `npm exec next start` pid; `kill $(cat .data/web.pid)` leaves the `next-server`
  child running on :3000 (orphaned), so the next restart fails with EADDRINUSE and the stale server keeps serving the
  rebuilt `.next`. I killed the orphaned child of the pid in the file under the lock. Suggest restarting with
  `pkill -P <pid>` on the npm/sh chain, or starting `node_modules/.bin/next start` directly so `$!` is the server.
- Also fixed: Team → team detail "Manager ceiling" (tooltip-only meaning) → "What managers can grant", toast "Ceiling
  saved" → "Saved", and its role checkboxes now stack below 640 px (page-level horizontal scroll at 320/360 before).

## Verification
- `pnpm -s typecheck` clean; `pnpm test` 45 files / 624 tests passed.
- Integration: v2-product, collab-complete, content-hub, setup — 4 files / 53 tests passed.
- E2E (desktop + @mobile): publishing, collaboration, v2-product, v31-ui — 42 passed, 1 skipped (16.4 min).
- Page-level horizontal scroll at 320/360/390/430: all 61 inspected CA screens/states clean (Setup and team detail
  fixed in this pass).
- Screenshots: `evidence/copy/ca/after/*-{1440,390}-{light,dark}.png`; before: `evidence/copy/ca/before/`.
- Not inspected rendered: review portal detail (`/review/[id]`) and a populated client review list (no active review
  shares in the dev data), a valid invitation, `/onboarding` workspace creation step, Publish-now dialog.
