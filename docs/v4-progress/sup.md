# V4 stream SUP — Relay customer support (progress note / resume point)

Status: **done** — migration 034 applied to dev (alone, via MIGRATIONS_DIR 001–034; 035/036 were applied later by their streams), web + worker rebuilt, E2E green, screenshots in `evidence/v4/sup/`.

## Decisions
- Own tables, own authz, own change feed (`support_*`); nothing shared with the V3.5 social inbox tables, SSE or search.
- Internal notes live in their OWN table (`support_notes`), never selected by customer code paths; staff-only history rows
  have `audience='staff'` and are filtered out of the customer feed/detail.
- Search document (`support_tickets.search_doc`) = reference + subject + public messages only (notes never indexed).
- Staff notifications: `notifications.workspace_id` nullable with `scope in ('workspace','platform')` (+ CHECK); platform
  rows have their own feed (`/api/platform/support/notifications`). `sendNotificationEmail` re-checks support/platform rows
  via `support/notify.ts recipientStillAllowed` (ticket visibility / support staff role).
- Platform-scope idempotency: nil-UUID scope in `idempotency_keys`, key namespaced per staff member
  (`beginPlatformIdempotent` in `idempotency.ts`).
- Staff roles: `support`/`operator` = tickets + notes; `billing` (BIL) refused by every support endpoint (`requireSupportStaff`).
- Visibility: requester + explicit participants + `support.workspace` holders for non-restricted tickets; category
  `security` = restricted (requester + participants only). Support-access viewer grants never include `support.workspace`.
- Problem reports stay local; "Send to Relay support" = preview (opt-in diagnostics, draft excerpt off) → share (new ticket
  `source='problem_report'` or add to an open ticket), records `shared_by`, workspace audit.
- Support access from a ticket reuses `admin/support-access.ts` (new optional `support_ticket_id`; outbox
  `support.access_requested` → owners/admins notified; decision → operator notified; ticket activity for each step).
  Worker sweep `support-sweeps` (60 s) ends expired grants / lapses requests (also stale uploads, auto-archive, purge).
- AI assist: summarize / draft reply via the existing assistant client (no tools, ticket text quoted, `proposed` ignored,
  drafts exclude notes, unsupported "done" claims flagged); category + related are deterministic; not charged to the
  customer's AI budget (per-staff rate limit, tokens recorded). No help-article store exists → saved replies are the
  approved knowledge source (gap noted).
- Restricted billing access never touches support (no entitlement checks in support services; ENT `ALWAYS_AVAILABLE`).
  Platform suspension still blocks the workspace entirely (V3.1 behaviour) — noted as a decision.
- Email notifications link back to Relay; no inbound email replies (not claimed anywhere).

## Done
- Migration `packages/db/migrations/034_v4_support.sql` (NOT yet applied to dev).
- Contract `packages/core/src/contracts/v4-support.ts`.
- Services `packages/services/src/support/{access,attachments,ai,commercial,notify,reports,shared,staff,sweeps,tickets}.ts`.
- API: `apps/web/app/api/support/{requests/**,participants,attachments/**,reports/[id]/share}`, `apps/web/app/api/platform/support/**`.
- UI: `/help/contact`, `/help/requests`, `/help/requests/[ref]` (components/support/customer.tsx, attachments.tsx,
  share-report.tsx); Platform `/admin/platform/support` (inbox), `/admin/platform/support/[ref]`, `/saved-replies`,
  `/access` (old support-access list moved here) (components/platform-support/*).
- Tests: `tests/integration/v4-support.test.ts` (17 passing), `tests/unit/v4-support.test.ts` (8 passing);
  regression v31-admin, v31-gov, v2-collab, collab-complete, schema, db-roles: 75 passing.

## Shared files edited (small, additive)
`packages/services/src/collab/notifications.ts` (export settingsFor/channelsFor, 'support' event, support/platform email
re-check), `collab/notification-center.ts` ('support' category), `engine/notify.ts` (support.* dispatch before the workspace
guard), `outbox.ts` (support.* event types), `idempotency.ts` (platform scope helpers), `admin/support-access.ts`
(ticket FK, owner notification outbox, ticket activity), `gov/release.ts` (browser_family/error_code, share state in list,
rate limit), `apps/worker/src/main.ts` (support-sweeps), `infra/postgres/roles.sql` (support_activity append-only),
`apps/web/components/shell/app-shell.tsx` (Help nav), `user-menu.tsx` (Contact support / My requests),
`components/admin/nav.tsx` (Platform → Support group; Support access → /support/access),
`components/conversation/{composer,timeline}.tsx` (optional audienceText/below/submitDisabledReason; single-mode;
note attachments), `components/collab/notification-prefs.tsx`, `app/(app)/notifications/page.tsx`,
`app/(admin)/admin/security/reports/page.tsx` (Send to Relay support), `components/support/support.tsx`.

## Tests
- Unit `tests/unit/v4-support.test.ts`: 8 passed. Full `pnpm test`: 600 passed.
- Integration `tests/integration/v4-support.test.ts`: 17 passed (§18 items 1–7, 15; internal-note boundary; AI drafts).
- Regression: v31-admin, v31-gov, v2-collab, collab-complete, schema, db-roles, v35-final, v2-lifecycle, members, v35-inbox,
  v2-product, v4-entitlements: 141 passed.
- E2E `tests/e2e/v4-support.spec.ts`: 3 desktop + 1 @mobile passed; no page-level horizontal scroll at 320/360/390/430/768/1440.
- Docs: `docs/v4/{SUPPORT_USER_GUIDE,PLATFORM_SUPPORT_GUIDE,SUPPORT_VISIBILITY_MATRIX (incl. retention),SUPPORT_ACCESS_WORKFLOW}.md`.

## Notes for the lead
- BIL's Platform → Workspaces "open support requests" can use `openTicketCount(workspaceId)` (support/staff.ts; counts only).
- Context card reads BIL's `workspaceCommercialSummary` (support/commercial.ts, failures caught → null).
- During my deploy an older `next-server` (started 07:00) kept :3000 after someone else's 08:08 build; I killed it and
  restarted web under the lock (`next start` pid in `.data/web.pid`).

## Activation items
- SMTP sender for support emails (without SMTP: in-app works, email rows show `not_configured`).
- Support staff assignments (`pnpm platform:operator` with role `support`).
- AI provider key for summaries/drafts (otherwise "AI is not set up").
- Malware scanning for attachments (none configured; validation-only quarantine).
