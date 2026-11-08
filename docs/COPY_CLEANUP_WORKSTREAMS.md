# Copy cleanup workstreams (queue item 8)

Brief: `docs/queue/03e_COPY_CLEANUP_PROMPT.md` (read all of it — it is short). Presentation and copy only: no workflow,
route, validation, authorization, event, data-contract or persisted-value changes. Documentation (`docs/**`), the Help
Centre content and the public marketing page's legal text are excluded. Rules in `HANDOFF.md` apply; how to work on the
shared host: `docs/v5-progress/STREAM_BRIEFING.md` (locks, rebuilds, tests — same conventions, progress notes go in
`docs/copy-progress/<stream>.md`, screenshots in `evidence/copy/<stream>/`).

## Standard (from the brief, applied consistently)
- Titles: short nouns ("Accounts", "Notifications"). No subtitle that repeats the title. No "Here you can…" intros.
- Actions: verb-first, specific ("New post", "Reconnect", "Save"). Success: "Saved", "Sent", "Scheduled".
- Empty states: "No scheduled posts" + one action when useful. Errors: problem + next action ("Couldn't reconnect. Try
  again.").
- Keep everything the brief lists as essential (permissions, approvals, destructive consequences, billing amounts and
  consent, privacy/security, timezones, failed/partial/unknown publishing outcomes, connection limits, analytics
  definitions/freshness/missing data, demo vs live, unsaved changes/conflicts). Shorten, never drop meaning; never hide a
  consequence only in a tooltip.
- Progressive disclosure only where the explanation is genuinely useful (existing Details/disclosure components); usually
  just delete.
- Consistent terms across the app (use the existing product terms: post, draft, Planner, Content library, Connections,
  Integrations, Inbox, Listening, Assistant, Automation, workspace, brand). Product name from `packages/core/src/brand.ts`.
- Accessible names may get shorter but must stay unique and meaningful; keep `aria-describedby`/error associations.
- When an E2E/integration test asserts changed text, update that assertion (text only) — never weaken what it checks.

## Streams

| Stream | Owns (screens + their components) |
|---|---|
| **CA** Main app — create & publish | Overview (`/overview`), Planner, Create/composer, Content library, Campaigns, Approvals, posts + deliveries, History, Queue, Trash, Tasks, Notifications, Onboarding, Team, Connections/accounts + health, Setup, signup/invite/login screens, review portal. Files: `apps/web/app/(app)/{page-like routes above}/**`, `apps/web/app/{onboarding,invite,login,signup,review}/**`, `apps/web/components/{composer,planner,library,campaigns,approvals,posts,deliveries,history,queue,tasks,collab,onboarding,team,connections,accounts,setup,notifications}/**` (whichever exist). |
| **CB** Main app — engage, insights, business | Inbox (+ channels/SLA settings), Listening, Assistant / AI workspace, Automation, Analytics, Integrations hub + connector pages, Help (Contact support, My requests, tickets), Settings → Plan and billing + usage prompts, entitlement banners, support widget, MCP pages. Files: `apps/web/app/(app)/{inbox,listening,assistant,automation,analytics,integrations,help,mcp}/**`, `apps/web/components/{inbox,conversation,listening,assistant,ai-workspace,automation,analytics,integrations,integrations-hub,support,support-widget,billing,entitlements}/**`. |
| **CC** Admin, Platform, settings shell, shared UI | Admin app (Workspace + Platform: every page under `apps/web/app/(admin)/**`), `apps/web/components/{admin,platform-support,settings-shell,settings}/**`, the app shell (`components/shell/**`: nav labels, banners, user menu), **shared UI** (`components/ui/**`, `components/ui-v5/**`: default empty/error/loading strings, toasts, dialogs) and client-side error copy in `apps/web/lib/client/**`, plus server error messages users see (`packages/core/src/errors.ts` and service `AppError` messages) — only the message text, never codes. Light pass on the marketing page for consistency (it was written in V5; keep its pricing/legal/claims text). |

Other streams don't edit CC's shared files; if a shared string bothers you, note it in your progress file and tell the lead.

## Deliver
Progress note (areas done, before → after examples, files), screenshots of representative screens after editing (1440 and
390, light + dark), `pnpm -s typecheck`, `pnpm test`, the integration files and E2E specs touching your areas green, no
page-level horizontal scroll at 320/360/390/430. Final report: areas cleaned, 5–8 before/after examples, verification
results; list any screen you did NOT inspect rendered.
