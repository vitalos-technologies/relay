# V3 stream UX — Relay redesign brief (lead → agent)

Launch after V2-A (identity/security) lands. Runs alongside AN (analytics), CH (content hub), MCP.

## Read first
- V3 spec `/root/.claude/uploads/f609c563-89be-5dc6-9e00-6441979fd790/9becd5de-Social_Lite_V3_Autonomous_Upgrade_Prompt.md` §2–5 (lines 37–110), §6 connection states (lines 129–131), §15 "Visual/product" gates (lines 310–318).
- `docs/V3_WORKSTREAMS.md` (contracts, ownership), `docs/V2_WORKSTREAMS.md` (authz contracts), `docs/PERMISSIONS_MATRIX.md`, `docs/DECISIONS.md` D18–D19, brand kit `docs/brand/relay-brand-kit.webp`.
- Current UI: `apps/web/app/globals.css` (tokens), `apps/web/components/ui/**`, `apps/web/components/shell/**`, every page under `apps/web/app/(app)/**`.
- Typed contracts for new data: `packages/core/src/contracts/*.ts` (analytics, content hub, MCP).

## Brand and tokens (replace the spec's lime)
- Relay palette: orange `#FD6701` primary (ink `#121416` text on orange), red `#FE4114`, amber `#FDA602`, ink `#121416`, mist `#EBEDEE`, gradient `#FD8221→#F13E1F` for the mark only. Inter. Outlined icons; orange icons in dark rounded tiles for integration/feature tiles.
- Dark (default-equal): near-black ink surfaces with subtle tonal steps; light: mist/white surfaces. Small orange text on light needs a darker accessible orange (verify ≥ 4.5:1). Status colours distinct from brand orange (success, warn, danger, info) and never colour-only.
- Spec sizing: body 14–16px, meta ≥ 12px, headings 28–32px, 4/8 rhythm, 12–16px radius, nav ~240px expanded / ~72px rail, motion 120–220ms with reduced-motion respected. No glow, no decorative gradients, no animated fake numbers.

## Scope
1. **Design system first**: tokens for both themes; shared components PageHeader, FilterBar, MetricCard, ChartPanel (with table alternative + keyboard summary), ContentCard (thumbnail), DataTable, StatusBadge, EmptyState, ErrorState, DetailDrawer, IntegrationCard, SettingsShell. Document in `docs/V3_DESIGN_SYSTEM.md`.
2. **Primary nav**: Overview, Planner, Create, Content Library, Campaigns, Approvals, Analytics, Connections, Team, Settings. Admin area visibly separate and permission-gated: Setup, Operations, Activity. Keep the emergency pause control and shell banners (offline, paused, demo-once).
3. **Settings on the left** (mandatory): grouped nested nav with a real deep-link URL per sub-setting, per the spec table (Personal / Workspace / People and access / Publishing / Connections / AI and automation / Developer / Operations). Map existing settings content into these pages; redirect old `?tab=` URLs. Permission-aware groups (server still authorizes). Mobile: left drawer + back/breadcrumb. No horizontal settings tabs. Settings search must not reveal inaccessible pages.
4. **Overview**: ≤ 4 summary tiles (scheduled this week, awaiting review, published this period, unresolved delivery issues), upcoming timeline with thumbnails, severity-ranked attention queue (keep Overdue banner + Manual handoff group), channel health (collapse healthy noise), performance summary from the analytics contract — if no data, show coverage/freshness state, never sample curves. Marketing performance separate from operational success.
5. **Planner**: week / month / list, thumbnail cards, platform icons, campaign/team filters, side drawer (variants, owner, review, delivery), drag-to-reschedule through the existing reschedule API (generation check, approval rules), conflicts/timezones/expired shown. Mobile defaults to agenda.
6. **Composer (Create)**: three-region desktop (destinations/format · editor/media · live preview labelled approximate), collapsing to steps on mobile. Searchable grouped destination selector for 10 networks with a clear active variant (no truncated tab strip). Per-provider required fields from `capabilities.requiredOptions` (TikTok privacy + consent, YouTube title / privacy / made-for-kids / "Let YouTube release it" scheduling owner, Pinterest board, LinkedIn organisation). Media thumbnails, reorder, alt text, crops, poster frame, upload progress, visible autosave/conflict status. Buttons by role/policy: Save draft, Submit for review, Schedule, Publish now. Published posts open read-only with Duplicate.
7. **Connections**: capability states — Available to connect, Connected, Missing permission, Awaiting platform approval, Unsupported for this account, Reconnect required, Manual handoff; formats vs analytics shown independently. **Bluesky connect UI** (handle + app password, labelled "App password", optional self-hosted service; API `POST /api/brands/:id/connections/bluesky`, reconnect `POST /api/connections/:id/reconnect { app_password }`; never echo the password). Google/Notion cards use CH components (`components/content-hub/**`), MCP settings use `components/mcp/**` — consume, don't rewrite them; ask the lead for changes.
8. **Library, Campaigns, Approvals, Analytics views, Team, History**: apply the system; Analytics views built on the AN contracts (coverage explained once, not per-row "unavailable").
9. Responsive at 1440 / 1024 / 768 / 390, both themes, keyboard + screen-reader passes on the key flows.

## Rules
- Preserve every working flow and all V2 authorization. No API/behaviour changes beyond what the UI needs; state any service change you need in the report.
- Copy: short, plain, no explanations users don't need (user preference: less text, clean interfaces). The product is Relay.
- Demo status shown once per workspace; never mix demo/simulated data into live charts.
- Keep first loads fast (lazy charts/previews, thumbnails not videos, paginate).
- Don't edit `components/content-hub/**`, `components/mcp/**`, or any backend stream's services. No git commits; the lead commits. Keep `docs/v3-progress/ux.md` updated.
- Update E2E selectors as needed and run `pnpm test:e2e`; unit/contracts must stay green.
- Evidence: screenshots of every redesigned screen, light + dark, desktop + 390px, at deviceScaleFactor 2 into `evidence/v3/ux/`.
