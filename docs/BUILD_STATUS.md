# Build status

**Phase:** V1 + V1.1 complete locally (simulated providers); awaiting external activation. **Next: V2 (security and multi-team upgrade) — queued.**
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
- V1.1: CSV import, TipSignal → drafts with deterministic cards, AI caption assistance (Claude, draft-only, capped), carousels/albums/video/Reels, posting slots + queue, image crops, native analytics with quotas, Integrations + Budgets settings.
- Hardening: Meta deauthorize/data-deletion callbacks, forward-only webhook application, shared Postgres rate limiting, Cloud KMS key custody, X token revoke on disconnect.

## Next

1. V2 upgrade (queued).
2. Activation items (checklist) → live canaries.
