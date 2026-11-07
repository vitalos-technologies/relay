# V3 stream MCP — progress (check first after restart)

Owner files: packages/db/migrations/017_v3_mcp.sql, packages/services/src/mcp/**, packages/core/src/contracts/mcp.ts,
apps/web/app/mcp/route.ts, apps/web/app/.well-known/oauth-protected-resource/**, apps/web/app/api/mcp/**,
apps/web/app/(app)/mcp/{settings,connect/[clientId],confirm/[intentId]}/page.tsx, apps/web/components/mcp/**,
tests/integration/mcp.test.ts, tests/unit/mcp.test.ts, docs/V3_MCP_GUIDE.md. Shared edits: apps/worker/src/main.ts (one
`mcp-jobs` loop), infra/keycloak/social-lite-realm.json (additive: clientScopes incl. built-ins snapshot, relay-mcp client).

## Status
- [x] research — pinned 2025-11-25 (SDK 1.32.2 LATEST); spec "latest" = 2026-07-28 (sessionless) unsupported by the SDK
- [x] migration 017 written — lead applies 015–017 to dev (do NOT apply here)
- [x] auth, registry, principal intersection, audit, tools (23), resources (3 + static), prompts (2), intents, policy grants, jobs
- [x] /mcp route + well-known PRM (verified live on :3000: PRM JSON, 401 challenge, GET 405)
- [x] consent/confirm/settings pages + components
- [x] Keycloak realm (verified on scratch KC :5557: real auth-code+PKCE+OTP token aud=/mcp accepted; web login unaffected)
- [x] tests: integration 19/19, unit 5/5
- [x] docs/V3_MCP_GUIDE.md
- [x] final verify: tsc root+web clean, pnpm test 442/442, test:integration 305/305 (2026-11-07)
