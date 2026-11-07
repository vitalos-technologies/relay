# Resumable progress (read first after any context reset)

## Queue (user-ordered)

1. **V1 + V1.1** — DONE, tagged `v1.1.0-local`.
2. **V2 security & multi-team upgrade** — IN PROGRESS. Spec: `/root/.claude/uploads/f609c563-89be-5dc6-9e00-6441979fd790/053d4b00-Social_Lite_V2_Autonomous_Upgrade_Prompt.md`
3. **V3 modernisation, analytics, 6 new providers, Google Drive/Docs + Notion, first-party MCP server** — QUEUED, start immediately after V2 is verified. Spec: `/root/.claude/uploads/f609c563-89be-5dc6-9e00-6441979fd790/9becd5de-Social_Lite_V3_Autonomous_Upgrade_Prompt.md`. Required docs: V3_REQUIREMENTS_MATRIX, V3_BUILD_STATUS, V3_IMPLEMENTATION_GAPS, V3_FINAL_ACTIVATION_CHECKLIST. User preference: less text, clean interfaces, send screenshots as you go.

## V2 state

- Done: migration 009 (teams, scoped grants, restrictions, membership status, policy versions, session assurance, service accounts/API key tables, V1 backfill + review items); `core/authz.ts` (presets, precedence, delegation); `services/authz.ts` (`authorize()`); `tenancy.ts` enforcement (declared permissions re-checked per touched brand); `v2Ctx` test helper; docs V2_THREAT_MODEL, PERMISSIONS_MATRIX.
- Known failing: `tests/integration/members.test.ts` (2) — members/invitations still write V1 roles; fixed by tenancy workstream.
- Next: workstreams in `docs/V2_WORKSTREAMS.md`.

## Environment recovery

Docker stops on container restart: if `/var/run/docker.pid` points at a non-dockerd PID remove only that file, start `dockerd`, then `docker compose -f infra/compose.yaml up -d --wait`. App: `./scripts/dev.sh --detach`.
