# Social Lite

Lightweight publishing for Instagram, Facebook Pages, Telegram channels and X. Write once, tailor per channel, schedule, and see exactly which destinations published.

## Run locally

Prerequisites: Docker, Node 22, pnpm 10.

```bash
cp .env.example .env          # then set SESSION_SECRET and KEY_ENCRYPTION_KEYS (commands are in the file)
pnpm install
./scripts/dev.sh              # infra + migrations + demo seed + worker + web
```

Open http://localhost:3000 and sign in with `owner@demo.social-lite.test` / `socialite-demo`.
Other demo users: `admin@`, `editor@`, `approver@`, `viewer@demo.social-lite.test` (same password). Email capture: http://localhost:8025.

The demo workspace uses **simulated destinations** only (`mock_…` IDs, labelled "Simulated"). Nothing is posted to real networks.

`./scripts/dev.sh --detach` runs in the background; `./scripts/stop.sh` stops it (`--infra` also stops Docker services).

## Test

```bash
pnpm test               # unit + provider contract tests (no network)
pnpm test:integration   # real PostgreSQL + S3 (needs infra running)
pnpm test:e2e           # browser tests (needs the app running: ./scripts/dev.sh --detach)
```

## Layout

| Path | Contents |
|---|---|
| `apps/web` | Next.js UI and authenticated JSON API |
| `apps/worker` | Background worker: outbox dispatch, publishing, reconciliation |
| `packages/core` | Pure domain: types, state machine, DST time, validation, permissions |
| `packages/db` | PostgreSQL pool, migrations |
| `packages/providers` | Instagram, Facebook, Telegram, X adapters + simulators |
| `packages/services` | Application services shared by web and worker |
| `infra` | Local Compose stack, Dockerfile |
| `docs` | Architecture, API, operations, deployment, status |

## Key docs

[Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Provider capabilities](docs/PROVIDER_CAPABILITIES.md) · [Deployment](docs/DEPLOYMENT.md) · [Operations](docs/OPERATIONS.md) · [Requirements matrix](docs/REQUIREMENTS_MATRIX.md) · [Test report](docs/TEST_REPORT.md) · [Activation checklist](docs/FINAL_ACTIVATION_CHECKLIST.md) · [Implementation gaps](docs/IMPLEMENTATION_GAPS.md) · [Build status](docs/BUILD_STATUS.md)
