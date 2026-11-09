# CC — Admin, Platform, settings shell, shared UI (copy cleanup)

Status: done (pending lead review). Resumed after the container restart 2026-11-09. Copy/presentation only; no route, validation, auth, event, API-field or persisted-value changes.

## Done
- Admin (Workspace): overview card details (server `admin/overview.ts`), footnote; deliveries/connections/analytics/content/operations
  toasts, plurals, humanised codes (`humanize()` display helper in `lib/client/format.ts`), "Content library"/"Sources" link labels.
- Admin (Platform): health, workspace detail (support banner, suspend dialog plural, en-GB date, humanised states), accounts,
  operators (role labels, add dialog), plans (provider meta, plural), billing (access label), audit (area/outcome labels),
  integrations (repeated "Network review/approval…" note → one footnote), marketing (dev subtitle removed, hints), AI, collaboration.
- Support access: readable status labels (`SUPPORT_LABEL`) on workspace + platform pages and ticket; specific toasts.
- Shell: "Activity" → "Audit log" (nav label, page title, caption; matches Settings/Admin), toasts ("Couldn’t …"), session error title.
- Settings: card titles that repeated the page title removed (Profile, General, Time zone, Workspace security, Draft recovery,
  Brands, Defaults, Brand voice); save toasts → "Saved"; security page toasts/empty/error.
- Shared UI: ErrorState default "Couldn’t load this", generic fallbacks "Something went wrong. Try again.", zone abbreviation
  gets a real space ("14:30 GMT").
- Client errors (`lib/client/api.ts`, `upload.ts`): network/server/upload messages → problem + next action.
- Server messages (text only): forbidden default, CSRF/session, rate limit, sign-in (oidc/users/idp), widget, content-hub creds,
  SSRF, comment anchor, operator add, support access.

## Tests updated (text only)
- tests/e2e/admin.spec.ts: support access badge 'active'/'ended' → 'Active'/'Ended'.
- tests/e2e/v2-product.spec.ts: heading 'Activity' → 'Audit log'.
- tests/e2e/security.spec.ts: toast 'Security policy saved' → 'Saved' (scoped to role=status).
- tests/unit/v5-widget.test.ts: /could not be sent/ → /Couldn’t send your message/.

## Notes for the lead (other streams' files)
- `components/collab/review-shell.tsx` (CA) still says "We couldn’t load your session" (shell/admin now "Couldn’t load your session").
- `components/support/attachments.tsx` (CB) has the old upload network message.
- `components/collab/notification-prefs.tsx` (CA) card "Notifications" repeats the Settings page title.
- Claimed as settings/admin (not listed for CA/CB): `app/(app)/activity`, `components/security/security-page.tsx`.

## Resumed 2026-11-09
- Remaining copy: server messages CA asked for ("Fix it on Accounts" / "Open Accounts…" → Connections in `posts/service.ts`,
  `engine/process.ts`, `engine/manual.ts`, `engine/notify.ts`; missed-deadline message in `engine/claim.ts` shortened —
  dropped the "(for example during downtime or a pause)" aside). Shared `ErrorState` on 404: no extra "Not found" title or
  reference id above the server's own message ("Invitation not found"). Settings → "Business integrations" → "Business apps"
  (keyword "integrations" kept for search). `ui-v5` (marketing-only primitives) and marketing copy reviewed: no change
  (pricing/legal/claims text kept, E2E asserts it).
- D28 grouped nav: `components/shell/nav-config.ts` (new, pure model: groups, admin, `navFor`, `bottomBarHrefs`),
  `components/shell/app-shell.tsx` (sidebar groups Publish · Engage · Insights · Workspace with headings at ≥1280 px,
  separators + sr-only headings on the 72 px rail; empty groups hidden; Admin group unchanged), Connections = one item
  (`/accounts`, active on `/integrations/**` too). Tabs: `components/shell/connections-tabs.tsx` (new; link tabs with
  aria-current, Business apps only with integrations.read, bar hidden when only one tab) rendered under the "Connections"
  header on `/accounts` (CA page, one line) and `/integrations` (CB `hub-page.tsx`: title "Integrations" → "Connections").
  `integrations-hub/hub-shell.tsx`: hub index renders full width like the Social accounts tab; connector pages keep the
  left list, now "Business apps" / "All apps"; back link "Business apps". "Open Integrations"/"Open hub"/"…in Integrations
  first" → Business apps. `/integrations` metadata title "Business apps".
- D29 bottom bar: publishers/approvers Overview · Planner · Create · Approvals; inbox readers without content.approve →
  Inbox instead of Approvals; inbox readers with no content.create/edit/submit/schedule/publish/approve → Overview · Inbox.
  More menu lists the rest grouped (Publish/Engage/Insights/Workspace labels) and scrolls within the available height.
- Tests: new `tests/unit/nav-groups.test.ts` (6); `tests/e2e/integrations.spec.ts` back link 'Integrations' → 'Business apps'.
- Also: `tests/e2e/admin.spec.ts` support-access "Ended" assertion scoped to the status badge (the facts list now also
  shows an "Ended" label since the badge became sentence case) — same check, no longer ambiguous.

## Verification (2026-11-09)
- `pnpm -s typecheck` clean; `pnpm test` 46 files / 630 tests passed (incl. new nav-groups 6).
- Integration: 67 files / 592 tests passed (quiet host). A run during the web build had 2 load-sensitive failures
  (listening 20k-mention timing bound, analytics overview equality); both passed on rerun and in the clean full run.
- Full E2E (`npx playwright test --trace off`, under the lock, fresh build + seed): 112 passed, 1 failed, 9 skipped (53.8 min).
  The failure was the ambiguous "Ended" locator above; after the fix `admin.spec.ts` 6/6 passed.
- No page-level horizontal scroll at 320/360/390/430 for publisher and care agent on /overview (+ More menu open),
  /accounts, /integrations, /integrations/asana, /inbox, /settings, /help.
- Bottom bar observed: publisher Overview · Planner · Create · Approvals · More; care agent Overview · Inbox · More;
  brand manager Overview · Planner · Create · Inbox · More (temporary users, removed afterwards).
- Keycloak realm still allows self-registration (registration form served).
- Screenshots: `evidence/copy/cc/nav-sidebar-{1440,1024}-{light,dark}.png`, `nav-bottom-{publisher,care,brandmgr}-390-
  {light,dark}.png`, `nav-more-*-390-light.png`, `connections-{social,business}-1440-{light,dark}.png`, `connections-social-390-light.png`.
- Not inspected rendered: rail at exactly 768 px, admin-console pages after the "Open Business apps" link rename,
  `/integrations/link/slack`, Settings → Business apps entry, 404 ErrorState on an unknown invite (logic change only).
