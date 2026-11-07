# Build status

**Phase:** MVP complete locally (simulated providers); V1.1 partially done; awaiting external activation.
**Branch:** `main` (local repository; no remote configured).

## Resume

```bash
./scripts/dev.sh --detach      # infra, migrations, seed, worker, web
pnpm test && pnpm test:integration && pnpm test:e2e
```
If the container restarted: Docker may need `rm -f /var/run/docker.pid` (only if the PID is stale) and `dockerd &`.

## Done

- Core schema (4 migrations), tenant isolation via composite FKs, immutable revisions.
- Durable engine: outbox → pg-boss, claims/leases/fencing, gates, retries, Unknown + reconciliation, sweepers, pause, budgets, circuit breaker.
- Adapters: Instagram, Facebook (Graph v26.0), Telegram, X v2 + simulators + contract tests.
- Auth (OIDC), sessions/CSRF, invitations, roles, brands, media pipeline, setup, diagnostics, ops dashboard, notifications.
- UI: all MVP screens, simplified design pass, desktop + mobile.
- Worker, Dockerfile (web/worker images built), CI workflow, restore drill, load test.
- V1.1: CSV import (API + UI), TipSignal events → drafts with deterministic cards.

## Next

1. Activation items (checklist) → live canaries.
2. Gaps in IMPLEMENTATION_GAPS.md, starting with CSV import UI and X token revoke.
