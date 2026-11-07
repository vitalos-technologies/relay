# Resumable progress (read first after any context reset)

## Queue (user-ordered)

1. **V1 + V1.1** — DONE, tagged `v1.1.0-local`.
2. **V2 security & multi-team upgrade** — IN PROGRESS. Spec: `/root/.claude/uploads/f609c563-89be-5dc6-9e00-6441979fd790/053d4b00-Social_Lite_V2_Autonomous_Upgrade_Prompt.md`
3. **V3 modernisation, analytics, 6 new providers, Google Drive/Docs + Notion, first-party MCP server** — QUEUED, start immediately after V2 is verified. Spec: `/root/.claude/uploads/f609c563-89be-5dc6-9e00-6441979fd790/9becd5de-Social_Lite_V3_Autonomous_Upgrade_Prompt.md`. Required docs: V3_REQUIREMENTS_MATRIX, V3_BUILD_STATUS, V3_IMPLEMENTATION_GAPS, V3_FINAL_ACTIVATION_CHECKLIST. User preference: less text, clean interfaces, send screenshots as you go.

4. **Complete documentation + in-app Help Centre** — QUEUED after V3. Full brief: `docs/queue/04_DOCUMENTATION_PROMPT.md`.

## Brand (2026-11-07)

Product is now **Relay** (brand kit: docs/brand/relay-brand-kit.webp; decisions D18–D19). Tokens/mark/Inter applied. V3 design system MUST use the Relay palette (orange/red/amber on ink) instead of the V3 spec's lime, plus the kit's icon style (outlined orange icons in dark rounded tiles). Docs/Help Centre use the name Relay.

## V2 state

- Done: migration 009 (teams, scoped grants, restrictions, membership status, policy versions, session assurance, service accounts/API key tables, V1 backfill + review items); `core/authz.ts` (presets, precedence, delegation); `services/authz.ts` (`authorize()`); `tenancy.ts` enforcement (declared permissions re-checked per touched brand); `v2Ctx` test helper; docs V2_THREAT_MODEL, PERMISSIONS_MATRIX.
- Known failing: `tests/integration/members.test.ts` (2) — members/invitations still write V1 roles; fixed by tenancy workstream.
- Running (agents): A identity/security, B tenancy/lifecycle, C collaboration, D product/fairness — each keeps `docs/v2-progress/<A-D>.md`.
- Lead done: adversarial tests (tests/integration/v2-adversarial.test.ts), V1→V2 migration rehearsal (scripts/migration-rehearsal.sh, PASS).
- Lead next: integrate stream results, finish adversarial §12 cases as features land, V2 docs (CHANGELOG, USER_LIFECYCLE, MIGRATION_RUNBOOK, TEST_REPORT, REQUIREMENTS_MATRIX, GAPS, ACTIVATION), E2E with Keycloak, tag v2.

## V3 early start

- V3-P providers (TikTok, YouTube, LinkedIn, Threads, Pinterest, Bluesky) running in parallel — `docs/v3-progress/providers.md`, migration 014.
- Remaining V3 streams start after V2: design system + shell/left Settings nav; analytics pipeline; Drive/Docs/Notion Content Hub; MCP server (auth via Keycloak AS).

## Environment recovery

Docker stops on container restart: if `/var/run/docker.pid` points at a non-dockerd PID remove only that file, start `dockerd`, then `docker compose -f infra/compose.yaml up -d --wait`. App: `./scripts/dev.sh --detach`.
