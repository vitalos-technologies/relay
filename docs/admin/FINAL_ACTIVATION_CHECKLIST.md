# Final activation checklist (admin)

> **Superseded (2026-11-09):** the consolidated list is [../FINAL_ACTIVATION_CHECKLIST.md](../FINAL_ACTIVATION_CHECKLIST.md). This per-phase file is kept for history; any "§n" reference to the V1 checklist points at its pre-consolidation version in git history.

## Only the user can do (from HANDOFF — repeat in the final consolidated list)
1. Network approvals (Meta incl. insights, TikTok, YouTube/Google, LinkedIn, Threads, Pinterest, X credits) before real customers connect.
2. Publish the version tags from your own machine.
3. Choose hosting (offer: ARM build + setup for the shared Oracle VM).
4. Supply the master SVG logo.

## Admin-specific
- [ ] Apply migration `026_v31_admin.sql` and `pnpm db:roles` in each environment (dev: done 2026-11-07).
- [ ] Name the first platform operator on the server: `pnpm platform:operator grant <email> operator` (the dev/E2E seed
      grants `owner@demo.social-lite.test`; never run seeds in production).
- [ ] Rebuild and restart the worker (dispatch gate holds suspended workspaces). Start it with the **worker** DB role.
- [ ] Decide G-A1: make Instance setup platform-operator-only for multi-workspace installs.
- [ ] Optional G-A5: `GRANT USAGE ON SCHEMA pgboss TO socialite_app; GRANT SELECT ON pgboss.job TO socialite_app;` for
      full queue gauges in Operations/Platform health.
- [ ] Production SMTP (invitations from admin use it); MCP public HTTPS; Google/Notion apps (see Platform → Integrations).
- [ ] Real-user performance data (RUM) needs a deployment; lab results in PERFORMANCE_REPORT.md.
- [ ] Optional external immutable audit sink (G-A8).
