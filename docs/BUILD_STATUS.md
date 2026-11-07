# Build status

Relay, 2026-11-07. Branch `main` (pushed to GitHub; see `HANDOFF.md`). All providers are simulated: nothing has been verified live.

| Phase | State | Details |
|---|---|---|
| V1 + V1.1 | Done (`v1.1.0-local`) | [TEST_REPORT.md](TEST_REPORT.md), [FINAL_ACTIVATION_CHECKLIST.md](FINAL_ACTIVATION_CHECKLIST.md) |
| V2 security and multi-team | **Done** (`v2.0.0` = 4815af8) | [V2_TEST_REPORT.md](V2_TEST_REPORT.md) |
| V3 redesign, analytics, 10 networks, Content Hub, MCP | **Done** (`v3.0.0`) | [V3_BUILD_STATUS.md](V3_BUILD_STATUS.md), [V3_SECURITY_AND_TEST_REPORT.md](V3_SECURITY_AND_TEST_REPORT.md) |
| V3.1 | Backend integrated; UI stream started | [V3_1_WORKSTREAMS.md](V3_1_WORKSTREAMS.md) |

Latest run (2026-11-07):
- unit + contracts 490/490;
- integration 373/374 (one flaky handoff test that passes alone);
- E2E 39/39 on a production build.

## Resume

```bash
./scripts/dev.sh --detach      # infra, migrations, seed, worker, web
pnpm test && set -a && . ./.env && set +a && npx vitest run --project integration
```
Read `HANDOFF.md` first. Container restarts: see `HANDOFF.md` (Docker recovery).

## Next

The queue is in `HANDOFF.md`:
1. V3.1 UI.
2. Close the open V3 gaps ([V3_IMPLEMENTATION_GAPS.md](V3_IMPLEMENTATION_GAPS.md)).
3. External activation ([V3_FINAL_ACTIVATION_CHECKLIST.md](V3_FINAL_ACTIVATION_CHECKLIST.md)), then live canaries.
