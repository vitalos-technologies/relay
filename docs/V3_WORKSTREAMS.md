# V3 workstreams — contracts and ownership

Product name: **Relay** (`packages/core/src/brand.ts`). Brand kit: `docs/brand/relay-brand-kit.webp`, decisions D18–D19 in `docs/DECISIONS.md`. The V3 spec's lime accent is **replaced** by the Relay palette (orange `#FD6701` primary, red `#FE4114`, amber `#FDA602`, ink `#121416`, mist `#EBEDEE`), Inter, and outlined orange icons in dark rounded tiles.

Read first: V3 spec `/root/.claude/uploads/f609c563-89be-5dc6-9e00-6441979fd790/9becd5de-Social_Lite_V3_Autonomous_Upgrade_Prompt.md`, `docs/V2_WORKSTREAMS.md` (all V2 contracts still apply: `requireAction`/`authorizeCtx`/`assertBrand`, `v2Ctx` tests, policy versions + audit, no assurance/tenant from clients), `docs/PERMISSIONS_MATRIX.md`, `docs/PROGRESS.md`.

## Contracts

- **Authorization**: every new route, job, export, source import and MCP tool goes through V2 `authorize()` with workspace/brand/connection scope. Background jobs re-check current authority when they run (not just at creation). Never act on a tenant id taken from queue payload alone — reload the row and verify scope.
- **No external calls in page requests**: pages read stored data (observations, snapshots, connection summaries) with explicit freshness; refresh happens in worker jobs.
- **Jobs**: use the existing outbox → pg-boss pattern with deterministic ids; add new queues per workload class (`analytics-sync`, `source-import`, `report-export`, `writeback`) with per-workspace concurrency; publishing (`delivery-due`) keeps priority. Register worker handlers in `apps/worker/src/main.ts` with minimal insertions.
- **Secrets**: provider/source tokens envelope-encrypted (`services/crypto.ts`), never returned, never passed to MCP clients.
- **Simulation**: test transports clearly labelled; demo/synthetic data never mixed into live queries (flag rows `is_demo`/`synthetic`).
- **Migrations**: one file per stream (below). Never edit applied migrations.
- **Typed contracts** for UI: each backend stream exports response types from `packages/core/src/contracts/<area>.ts` so the redesign stream can build screens against them.
- Shared-file rule as in V2 (re-read before edit, small additive diffs). No git commits; dependencies only via the lead (state them in your report). Keep `docs/v3-progress/<stream>.md` updated (container restarts happen; see PROGRESS "Environment recovery").

## Streams

| Stream | Migration | Owns |
|---|---|---|
| P Providers (DONE) | 014 | six new adapters (see `docs/v3-progress/providers.md`) |
| AN Analytics | `015_v3_analytics.sql` | metric registry/dictionary, sync jobs (cursor/checkpoint/backfill/late corrections), raw observations → daily facts → aggregates, coverage/freshness states, query API (overview KPIs, trends w/ previous period, channels, content table, video, audience, workflow), reports (saved views, CSV/PDF, export via Content Hub exporters), synthetic demo fixtures isolated; `docs/V3_ANALYTICS_DICTIONARY.md` |
| CH Content Hub | `016_v3_content_hub.sql` | Google (Drive picker/import, Docs import, exports) + Notion (pages, data sources, mapping, row import, opt-in writeback, exports) connections, snapshots, imports, diffs/refresh, revocation semantics, worker jobs, Content Hub UI components (`components/content-hub/**`) + Settings connection pages content; `docs/V3_CONTENT_INTEGRATIONS.md` |
| MCP | `017_v3_mcp.sql` | `/mcp` Streamable HTTP endpoint (official TS SDK, pinned protocol), OAuth protected-resource with Keycloak as authorization server, scopes, client registry/revocation/audit, tools/resources via shared services, prepare/commit publication intents with server-side confirmation, Settings → Developer → MCP UI components (`components/mcp/**`); `docs/V3_MCP_GUIDE.md` |
| UX Redesign (starts after V2-A) | `018_v3_ux.sql` (if needed) | design system + tokens + shared components, app shell + primary nav, **left-sidebar grouped Settings with deep links** (mobile drawer), Overview, Planner, Composer (three-region, destination picker for 10 networks, per-provider required fields, Bluesky connect), Library/Content Hub layout, Campaigns, Approvals, Analytics views, Connections (capability states), Team, Settings; both themes, 1440/1024/768/390; `docs/V3_DESIGN_SYSTEM.md` |
| Lead | `019_v3_engine.sql` | integration, provider engine gaps (manual_handoff state ✅, YouTube early upload ✅), V3 docs (matrix, build status, gaps, activation, platform capabilities, security & test report), regression + E2E |
