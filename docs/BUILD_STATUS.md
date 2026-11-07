# Build status

Relay, 2026-11-07. Branch `main` (pushed to GitHub; see `HANDOFF.md`). All providers are simulated: nothing has been verified live.

| Phase | State | Details |
|---|---|---|
| V1 + V1.1 | Done (`v1.1.0-local`) | [TEST_REPORT.md](TEST_REPORT.md), [FINAL_ACTIVATION_CHECKLIST.md](FINAL_ACTIVATION_CHECKLIST.md) |
| V2 security and multi-team | **Done** (`v2.0.0` = 4815af8) | [V2_TEST_REPORT.md](V2_TEST_REPORT.md) |
| V3 | Backend done; **UX redesign in progress** | [V3_BUILD_STATUS.md](V3_BUILD_STATUS.md) |
| V3.1 | Backend streams started | [V3_1_WORKSTREAMS.md](V3_1_WORKSTREAMS.md) |

Latest run (2026-11-07): unit 104, contracts 351, integration 321. All passed.

## Resume

```bash
./scripts/dev.sh --detach      # infra, migrations, seed, worker, web
pnpm test && set -a && . ./.env && set +a && npx vitest run --project integration
```
Read `HANDOFF.md` first. Container restarts: see `HANDOFF.md` (Docker recovery).

## Next

The queue is in `HANDOFF.md`:
1. Land the UX redesign.
2. Re-run E2E.
3. Close the V3 gaps.
4. External activation ([V3_FINAL_ACTIVATION_CHECKLIST.md](V3_FINAL_ACTIVATION_CHECKLIST.md)), then live canaries.
