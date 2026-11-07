# Resumable progress (read first after any context reset)

## Queue (user-ordered)

1. **V1 + V1.1** — DONE, tagged `v1.1.0-local`.
2. **V2 security & multi-team upgrade** — streams B/C/D DONE, A finishing; rehearsal 004–014 PASS; 418 unit/contract + 242/244 integration (2 = A's Keycloak tests). Spec: `/root/.claude/uploads/f609c563-89be-5dc6-9e00-6441979fd790/053d4b00-Social_Lite_V2_Autonomous_Upgrade_Prompt.md`
3. **V3 modernisation, analytics, 6 new providers, Google Drive/Docs + Notion, first-party MCP server** — QUEUED, start immediately after V2 is verified. Spec: `/root/.claude/uploads/f609c563-89be-5dc6-9e00-6441979fd790/9becd5de-Social_Lite_V3_Autonomous_Upgrade_Prompt.md`. Required docs: V3_REQUIREMENTS_MATRIX, V3_BUILD_STATUS, V3_IMPLEMENTATION_GAPS, V3_FINAL_ACTIVATION_CHECKLIST. User preference: less text, clean interfaces, send screenshots as you go.

4. **Relay V3.1 performance, reliability & workflow resilience** — QUEUED after V3. Full brief: `docs/queue/03b_V3_1_PROMPT.md`.
5. **Relay V3.1 Admin application** (platform + workspace administration, fully wired, mobile-first QA) — QUEUED after V3.1 core. Full brief: `docs/queue/03c_V3_1_ADMIN_PROMPT.md`.
6. **Team collaboration completion** (threads, mentions, tasks, reviewer notifications, presence, conflict resolution, revision compare/restore, admin wiring) — QUEUED after V3.1 Admin. Full brief: `docs/queue/03d_COLLABORATION_PROMPT.md`.
7. **User-facing copy cleanup** (concise text across all screens; docs/Help Centre excluded) — QUEUED after collaboration completion. Full brief: `docs/queue/03e_COPY_CLEANUP_PROMPT.md`.
8. **Complete documentation + in-app Help Centre** — QUEUED LAST (after copy cleanup so docs match final wording) (user asked "after V3"; placed after V3.1 so docs describe the final product — told the user). Full brief: `docs/queue/04_DOCUMENTATION_PROMPT.md`.

## Brand (2026-11-07)

Product is now **Relay** (brand kit: docs/brand/relay-brand-kit.webp; decisions D18–D19). Tokens/mark/Inter applied. V3 design system MUST use the Relay palette (orange/red/amber on ink) instead of the V3 spec's lime, plus the kit's icon style (outlined orange icons in dark rounded tiles). Docs/Help Centre use the name Relay.

## V2 state

- Done: migration 009 (teams, scoped grants, restrictions, membership status, policy versions, session assurance, service accounts/API key tables, V1 backfill + review items); `core/authz.ts` (presets, precedence, delegation); `services/authz.ts` (`authorize()`); `tenancy.ts` enforcement (declared permissions re-checked per touched brand); `v2Ctx` test helper; docs V2_THREAT_MODEL, PERMISSIONS_MATRIX.
- Known failing: `tests/integration/members.test.ts` (2) — members/invitations still write V1 roles; fixed by tenancy workstream.
- Running (agents): A identity/security, B tenancy/lifecycle, C collaboration, D product/fairness — each keeps `docs/v2-progress/<A-D>.md`.
- Lead done: adversarial tests (tests/integration/v2-adversarial.test.ts), V1→V2 migration rehearsal (scripts/migration-rehearsal.sh, PASS).
- Lead next: integrate stream results, finish adversarial §12 cases as features land, V2 docs (CHANGELOG, USER_LIFECYCLE, MIGRATION_RUNBOOK, TEST_REPORT, REQUIREMENTS_MATRIX, GAPS, ACTIVATION), E2E with Keycloak, tag v2.

## V3 early start

- V3-P providers DONE (adapters, connectors, fakes, metrics, 164 contract tests, docs; migration 014 applied to dev). Gaps for V3 streams: Bluesky connect route/UI; composer per-provider required fields (TikTok privacy+consent, YouTube title/privacy/madeForKids, Pinterest board, LinkedIn org); YouTube native scheduling needs early upload dispatch before publishAt; dedicated `manual_handoff` delivery state (TikTok inbox drafts currently Unknown + handoff text); self-hosted Bluesky PDS allow-list.
- V3 streams RUNNING (contracts: docs/V3_WORKSTREAMS.md): AN analytics (015), CH content hub (016), MCP (017). Progress notes docs/v3-progress/{analytics,content-hub,mcp}.md.
- UX redesign stream (018) starts when V2-A finishes (A relaunched to finish CSP/scans/security UI/Keycloak test fixes; docs/v2-progress/A.md).
- Lead V3 engine gaps DONE (commit 0c57bae): `handoff` delivery state (migration 019; TikTok inbox), YouTube early upload (engine/provider-scheduling.ts; 180 min early, publishAt = due time, <15 min lead → app-owned at due time). Tests: engine-handoff, v3-youtube-early-upload. Migration 019 applied to dev on its own (Home queries the handoff state); 015–017 still pending on dev — apply once AN/CH/MCP land (migrator locks checksums). Web /api/ready reports not_ready until then.
- Lead V3 next: V3 docs (matrix, build status, gaps, activation).
- V3-P gaps closed by lead: Bluesky connect/reconnect routes (b8abe47), self-hosted Bluesky allow-list BLUESKY_SELF_HOSTED_HOSTS (b0fcc70), handoff state + YouTube early upload (0c57bae). Remaining P gap → UX stream: composer per-provider required fields + Bluesky connect UI.
- UX redesign brief ready: `docs/queue/018_UX_REDESIGN_BRIEF.md` — launch as an agent when V2-A lands.

## Environment recovery

Docker stops on container restart: if `/var/run/docker.pid` points at a non-dockerd PID remove only that file, start `dockerd`, then `docker compose -f infra/compose.yaml up -d --wait`. App: `./scripts/dev.sh --detach`.

## V2 integration checklist (lead, when streams finish)

- Reset dev DB + re-seed: stream test fixtures leaked into the demo workspace ("Health FB e63a", "Affected launch e63a"); tests must use per-run test DBs only.
- Demo identities: Keycloak issuer replaced Dex → existing dev users are bound to the Dex issuer (`account_conflict` on sign-in). Fresh seed with `oidc_issuer='pending'` users fixes dev; document for real deployments (no re-binding by email).
- ✅ Overdue label (commit db2a023): deliveries >2 min past dispatch show Overdue; Home banner with publisher state (evidence/v2/home-overdue-*.png).
- V2 docs set delegated to a docs agent (V2_REQUIREMENTS_MATRIX, CHANGELOG, USER_LIFECYCLE, MIGRATION_RUNBOOK, GAPS, ACTIVATION, TEST_REPORT) — lead reviews + commits.
- Sweep remaining user-facing "Social Lite" strings (e.g. scripts/dev.sh banner) → Relay (V3.1 also requires this).
- tests/integration/setup.test.ts still expects the Dex issuer (stream A to fix).
- Run full suite + E2E (Keycloak TOTP sign-in) + migration rehearsal with migrations 010–014.
