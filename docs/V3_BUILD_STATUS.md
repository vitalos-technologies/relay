# V3 build status

**2026-11-07, `main` @ c6a8c0a. V3 is done locally: tag `v3.0.0`.**
- Backend: providers, engine gaps, analytics, Content Hub, MCP.
- UX redesign: landed in 3e5e3f2 and 95f8e34.
- Nothing is verified live; all external paths run against labelled fakes.

Tests:

| Suite | Result |
|---|---|
| Unit + contracts | **490/490** |
| Integration | **373/374** (1 flaky, passes alone) |
| E2E on a production build | **39/39** (18.3 min) |

Details:
- [V3_REQUIREMENTS_MATRIX.md](V3_REQUIREMENTS_MATRIX.md) (154 rows: 81 Done (tested), 44 Done (untested), 22 Partial, 2 Not started, 5 Blocked (external))
- [V3_SECURITY_AND_TEST_REPORT.md](V3_SECURITY_AND_TEST_REPORT.md)
- [V3_IMPLEMENTATION_GAPS.md](V3_IMPLEMENTATION_GAPS.md)
- [V3_FINAL_ACTIVATION_CHECKLIST.md](V3_FINAL_ACTIVATION_CHECKLIST.md)
- [V3_DESIGN_SYSTEM.md](V3_DESIGN_SYSTEM.md)

## By area

| Area | State | Migration | V3 tests | Commits |
|---|---|---|---|---|
| Six new providers: TikTok, YouTube, LinkedIn, Threads, Pinterest, Bluesky | Done vs fakes; live: none | 014 | contracts 164; integration `v3-connections` 4, `v3-remote-schedule` 3 | ab628ff, 20ff7b0 |
| Bluesky connect/reconnect routes, self-hosted allow-list, connect form | Done | – | `v3-connections` | b8abe47, b0fcc70, 3e5e3f2 |
| Engine: `handoff` state, YouTube early upload / provider-held release, overdue label | Done | 019 | `engine-handoff` 2, `v3-youtube-early-upload` 3, `overdue` 1 | 0c57bae, db2a023 |
| Analytics: registry (70 metrics), pipeline, coverage, query API, saved views (API), CSV/HTML/PDF, demo isolation | Done | 015 | unit 12; integration 21 | 523c1dd, 6dba857 |
| Content Hub: Google Drive/Docs (+ Picker), Notion, snapshots, refresh, writeback, exports, webhooks | Done vs fakes; Picker browser flow untested | 016 | unit 9; integration 20 | 57e056b, fff2d4b, 11e215f |
| MCP: `/mcp`, Keycloak `relay-mcp`, consent, intents, policies, audit; 27 V3 tools (+ 6 V3.1 read-only tools) | Done vs SDK client; no real client | 017 | unit 5; integration 21 | 864cf18, 0438b3e, 18b5c53, ed9aa1f |
| **UX redesign:** tokens/design system, shell + nav, left grouped Settings with deep links, Overview, Planner, Composer (10-network picker, provider fields, previews), Connections (capability states), Library, Campaigns, Analytics views | Done | – (018 not needed) | E2E 39/39 (production build); 104 captures in `evidence/v3/ux/` | 3e5e3f2, 95f8e34 |
| Strict-CSP fix (browser Zod `jitless`); E2E in its own "E2E Workspace" | Done | – | E2E `security.spec` CSP | 95f8e34, 3e5e3f2 |
| Lead fixes: Meta insights opt-in (`META_REQUEST_INSIGHTS`) | Done | – | `contracts/meta` | 9dc2ad7, de9ba33 |
| Lead fixes: provider status keys, posts draft filter, Google/Notion split Settings | Done | – | `api-fixes-v3` 2 | 8e774ba |
| Lead fixes: brand-rule hold | Done | – | `v31-brand-rule-hold` 1 | 46d6313 |
| Hardening: runtime DB-role guard (G14), grant-expiry sweep (G7) | Done | – | `db-roles` 5, `grant-expiry` 1 | 0c09ab3, 6ce87d7 |
| Migration rehearsal 001–019 | PASS | – | 10 checks | 9d0a0aa |

## Still partial (main items)

- **UX:**
  - Settings pages waiting on backend: Retention, Guests, Webhooks, Recovery, AI usage;
  - Approvals polish;
  - keyboard/screen-reader pass;
  - saved-views UI and snippets.
- **Product:**
  - no follower/audience fetchers;
  - TikTok handoff download action;
  - connectors not behind workspace flags;
  - MCP exports download-only.
- **Verification:** no live provider, Google, Notion or real MCP client; no V3 rollback runbook; no browser performance metrics.

## Running in parallel

V3.1 backend streams (PERF, DATA, GOV) are integrated (88d4fef, 277c2ff, 0eb6163). The V3.1 UI stream has started. See [V3_1_WORKSTREAMS.md](V3_1_WORKSTREAMS.md).

## Next

1. Close the open V3 gaps above.
2. External activation (checklist).
3. Live canaries per network, Google, Notion and one real MCP client.
4. Then update the "Blocked (external)" rows.
