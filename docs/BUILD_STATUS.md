# Build status

Relay, 2026-11-07. Branch `main` (pushed to GitHub; see `HANDOFF.md`). All providers are simulated: nothing has been verified live.

| Phase | State | Details |
|---|---|---|
| V1 + V1.1 | Done (`v1.1.0-local`) | [TEST_REPORT.md](TEST_REPORT.md), [FINAL_ACTIVATION_CHECKLIST.md](FINAL_ACTIVATION_CHECKLIST.md) |
| V2 security and multi-team | **Done** (`v2.0.0` = 4815af8) | [V2_TEST_REPORT.md](V2_TEST_REPORT.md) |
| V3 redesign, analytics, 10 networks, Content Hub, MCP | **Done** (`v3.0.0`) | [V3_BUILD_STATUS.md](V3_BUILD_STATUS.md), [V3_SECURITY_AND_TEST_REPORT.md](V3_SECURITY_AND_TEST_REPORT.md) |
| V3.1 performance, reliability, workflow resilience | **Done** locally (89286a7) | [V3_1_TEST_REPORT.md](V3_1_TEST_REPORT.md), [V3_1_REQUIREMENTS_MATRIX.md](V3_1_REQUIREMENTS_MATRIX.md), [V3_1_IMPLEMENTATION_GAPS.md](V3_1_IMPLEMENTATION_GAPS.md), [V3_1_FINAL_ACTIVATION_CHECKLIST.md](V3_1_FINAL_ACTIVATION_CHECKLIST.md) |
| V3.1 Admin application | Running | `docs/v3-1-progress/admin.md` |

Latest run (2026-11-07 16:50 UTC):
- unit + contracts 490/490;
- integration 375/375;
- full E2E 45/45 on a production build (16:46, UI stream).

Migrations 001–025 (no 018/023/024).

## Resume

```bash
./scripts/dev.sh --detach      # infra, migrations, seed, worker, web
pnpm test && set -a && . ./.env && set +a && npx vitest run --project integration
```
Read `HANDOFF.md` first. Container restarts: see `HANDOFF.md` (Docker recovery).

## Next

The queue is in `HANDOFF.md`:
1. V3.1 Admin.
2. Collaboration.
3. V3.5.
4. Copy cleanup.
5. Docs + Help Centre.

Alongside: close the V3/V3.1 gaps, then external activation (V3 and V3.1 checklists) and live canaries.
