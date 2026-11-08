# V3 UX redesign — progress (stream UX)

Brief: `docs/queue/018_UX_REDESIGN_BRIEF.md`. Resume point for this stream.

## Status
- 2026-11-07: started. V2-A landed (e09ff58): settings files unlocked (not csp.ts/proxy.ts/keycloak/auth/security.spec).
- Final evidence (after lead reset with E2E Workspace): 104 shots `evidence/v3/ux/<screen>-<1440|390>-<light|dark>.png` via `scripts/ux-shots.mjs`. Checkpoints in `evidence/v3/ux/checkpoints/`.
- Verification (post-commit 3e5e3f2): full E2E on a production build (`next build --webpack` + `next start`) **39/39**. Fixes: Zod `jitless` in the browser (`packages/core/src/schemas.ts`) so the strict CSP sees no `script-src eval` probe; publishing.spec pinned to seeded destinations (E2E workspace persists between runs). Root + web tsc clean; `pnpm test` 488/490 — the 2 failures (v3-linkedin / v3-pinterest `timeout_after_send ⇒ reconciled`) fail identically without UX changes (pre-existing).

## Done
- 1 Tokens + shell/nav (rail 72 / 240 expanded, top bar scope, Admin group, new labels): `evidence/v3/ux/checkpoints/1-shell-light.png`, `evidence/v3/ux/checkpoints/1-shell-dark.png`
- 2 Overview (4 tiles, upcoming + post drawer, attention w/ Manual handoff, channel health, performance from AN contract): `evidence/v3/ux/checkpoints/2-overview-light.png`, `evidence/v3/ux/checkpoints/2-overview-dark.png`
- 3 Settings left nav (grouped, deep links `/settings/<group>/<item>`, search, mobile drawer, `?tab=` server redirects keep other params, `/mcp/settings` → Developer → MCP, `/security` inside the shell): `evidence/v3/ux/checkpoints/3-settings-light.png`, `evidence/v3/ux/checkpoints/3-settings-dark.png`
- 4 Composer (three regions ≥1280, steps on mobile, content switcher + searchable grouped destinations, provider fields TikTok/YouTube/Pinterest/LinkedIn/Bluesky, previews for all 10 networks, published = read only + Duplicate/Edit): `evidence/v3/ux/checkpoints/4-composer-light.png`, `evidence/v3/ux/checkpoints/4-composer-dark.png`
- 5 Planner (week/month/list, thumbnails, platform tiles, campaign/team/status filters, conflicts/expired/other-zone markers, post drawer, History link): `evidence/v3/ux/checkpoints/5-planner-week-light.png`, `evidence/v3/ux/checkpoints/5-planner-week-dark.png`, `evidence/v3/ux/checkpoints/5-planner-drawer-light.png`, `evidence/v3/ux/checkpoints/5-planner-drawer-dark.png`

- 6 Connections (capability states, publishes/analytics independent, all-10 network picker, Bluesky handle + app password + self-hosted, Google/Notion via CH component): `evidence/v3/ux/checkpoints/6-connections-{light,dark}.png`, `evidence/v3/ux/checkpoints/6-connections-bluesky-{light,dark}.png`
- 7 Analytics on AN contracts (Overview KPIs/trend/channels/top content/insights; Content table + drawer + refresh; Channels; Video; Audience; Workflow; URL filters; Export CSV/PDF; coverage once in footer): `evidence/v3/ux/checkpoints/7-analytics-{light,dark}.png`, `evidence/v3/ux/checkpoints/7-analytics-content-{light,dark}.png`
- Library ("Content library", accent tabs), Campaigns (new `/campaigns`: per-brand cards, create/edit/archive, opens Planner filtered), Create page (Recent posts, honest Simulated labels), History (compact filter bar), Team/Approvals inherit tokens.
- Lead notes applied: LinkedIn glyph, grouped readiness issues, no ↗ on in-app settings links, drawer meta/"Scheduled in", clickable conflict filter, connection cards (one chip, Simulation outcome in ⋯, no repeated unknown sentence), Bluesky disclosure.
- `docs/V3_DESIGN_SYSTEM.md` written.
- E2E isolation (V3 §2.7): `scripts/seed-agency.ts` (shared agency seed), `scripts/seed.ts` now also seeds "E2E Workspace" (after Demo Workspace, so sign-in still defaults to Demo), `scripts/seed-e2e.ts` + `pnpm db:seed:e2e` (idempotent, for existing DBs), Playwright `globalSetup` (`tests/e2e/global-setup.ts`) runs it, `helpers.signIn`/`signInHere` switch to the E2E workspace via `POST /api/session/workspace` (`useE2EWorkspace`). security.spec.ts untouched (uses helpers.signIn).
- Lead notes: Planner `limit` + "Showing the first N" banner (route passes `limit`), Overview tiles show N+ when truncated; month view dims outside days; composer title wraps to 2 lines; phones get one full-width primary action + ⋯ (Save draft, Submit, Add to queue, Publish now); Google and Notion are separate Settings pages (`source` prop); Create shows "Drafts" again.
## Service changes (UI needs)
- `packages/services/src/readmodels.ts` planner(): additive `thumb_url` (signed 5 min, first base asset, same workspace+brand) and `media_kind` per item.

## Evidence
- `scripts/ux-shots.mjs` regenerates `evidence/v3/ux/*` (dev only; inserts a short-lived owner session; ensures draft "Autumn menu launch (UX showcase)" on Relay Coffee).

## Next
2. Approvals list/detail polish; Settings sub-pages without content (Retention, Guests, Webhooks, Recovery, AI usage) need backend first.
3. Keyboard/screen-reader pass on composer + planner drag alternative (menu → Reschedule exists).

## Open issues for the lead
- (resolved by lead 8e774ba: providers config, drafts filter, CH `source` prop)
- Legacy `/settings?tab=sources&connected=…` (CH OAuth return) now lands on the Google page; a Notion callback banner would show there too — CH could return to `/settings/connections/<source>`.
