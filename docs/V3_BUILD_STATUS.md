# V3 build status

**2026-11-07, `main` @ e3d0e17.**
- V3 backend is complete and integrated: providers, engine gaps, analytics, Content Hub, MCP.
- The **UX redesign is in progress** (uncommitted).
- Nothing is verified live; all external paths run against labelled fakes.

Tests (this run): unit **104/104**, contracts **351/351**, integration **321/321**. E2E not re-run.

Details:
- [V3_REQUIREMENTS_MATRIX.md](V3_REQUIREMENTS_MATRIX.md)
- [V3_SECURITY_AND_TEST_REPORT.md](V3_SECURITY_AND_TEST_REPORT.md)
- [V3_IMPLEMENTATION_GAPS.md](V3_IMPLEMENTATION_GAPS.md)
- [V3_FINAL_ACTIVATION_CHECKLIST.md](V3_FINAL_ACTIVATION_CHECKLIST.md)

## By area

| Area | State | Migration | V3 tests | Commits |
|---|---|---|---|---|
| Six new providers: TikTok, YouTube, LinkedIn, Threads, Pinterest, Bluesky (adapters, OAuth, fakes, metrics) | Done vs fakes; live: none | 014 | contracts 164; integration 4 (`v3-connections`) + 3 (`v3-remote-schedule`) | ab628ff, 20ff7b0 |
| Bluesky connect/reconnect API; self-hosted allow-list | Done (UI form in the UX stream) | – | in `v3-connections` | b8abe47, b0fcc70 |
| Engine: `handoff` state, YouTube early upload / provider-held release, overdue label | Done | 019 | `engine-handoff` 2, `v3-youtube-early-upload` 3, `overdue` 1 | 0c57bae, db2a023 |
| Analytics: registry (70 metrics), pipeline, facts/rollups, coverage, query API (overview/content/channels/video/audience/workflow/best time), saved views, CSV/HTML/PDF, demo isolation | Backend done; UI waits for the UX stream | 015 | unit 12; integration 21 (`v3-analytics` 13, `v3-analytics-pipeline` 8) | 523c1dd, 6dba857 |
| Content Hub: Google Drive/Docs (+ Picker), Notion pages/data sources, snapshots, refresh/diff, writeback, exports, webhooks | Done vs fakes; Picker browser flow untested | 016 | unit 9; integration 20 | 57e056b, fff2d4b |
| MCP: `/mcp` (SDK 1.32.2, protocol 2025-11-25), Keycloak `relay-mcp`, consent, 27 tools, resources, intents, policies, audit | Done vs SDK client; no real client | 017 | unit 5; integration 21 | 864cf18, 0438b3e, 18b5c53, ed9aa1f |
| Hardening carried into V3: runtime DB-role guard (G14), grant-expiry sweep (G7) | Done | – | `db-roles` 5, `grant-expiry` 1 | 0c09ab3, 6ce87d7 |
| Brand: Relay name, palette, Inter, R mark | Done | – | – | 7be08a7 |
| UX redesign (spec §2–5): tokens/shell, Overview, Settings left nav done; Planner, Composer, Connections, Library, Analytics, design-system doc pending | **In progress** (uncommitted) | 018 (not created) | – | – |
| Migration rehearsal 001–019 | PASS | – | 10 checks | 9d0a0aa |

Stream notes:
- contracts: [V3_WORKSTREAMS.md](V3_WORKSTREAMS.md);
- progress: `docs/v3-progress/{providers,analytics,content-hub,mcp,ux}.md`.

## Running in parallel

The V3.1 backend streams have started early: PERF (020), DATA (021), GOV (022). See [V3_1_WORKSTREAMS.md](V3_1_WORKSTREAMS.md) (e3d0e17).

## Next

1. Land the UX redesign. Then update the §2–5 rows of the matrix and write `V3_DESIGN_SYSTEM.md`.
2. Full browser E2E on the redesign.
3. Close the code gaps:
   - P1: Meta insights scopes;
   - S1: Picker CSP default;
   - M1: MCP `query_analytics` on V3 data;
   - P4: TikTok handoff action.
4. V3 migration/rollback runbook.
5. External activation (checklist), then live canaries.
