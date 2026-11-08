# Relay

_Formerly Social Lite (internal package, database and realm names keep the old identifier)._

Lightweight publishing for Instagram, Facebook Pages, Telegram channels and X. Write once, tailor per channel, schedule, and see exactly which destinations published.

## Run locally

Prerequisites: Docker, Node 22, pnpm 10.

```bash
cp .env.example .env          # then set SESSION_SECRET and KEY_ENCRYPTION_KEYS (commands are in the file)
pnpm install
./scripts/dev.sh              # infra + migrations + demo seed + worker + web
```

Open http://localhost:3000 → **Sign in** → the local Keycloak realm (http://localhost:5556/realms/social-lite).
All demo users share the password `socialite-demo`:

| Demo user (`@demo.social-lite.test`) | Second step |
|---|---|
| `owner@`, `admin@`, `publisher@` (and `owner@other.social-lite.test`) | Authenticator code (TOTP) — required for privileged roles |
| `editor@`, `approver@`, `analyst@`, `viewer@`, `teammanager@`, `guest@` | None (can enrol one on **Security**) |

Get the current code with `npx tsx scripts/demo-totp.ts owner` (`admin`, `publisher`, `other-owner`), or add the local-only secret to an authenticator app (SHA-1, 6 digits, 30 s): owner `ONXWG2LBNRUXIZJNMRSW23ZNORXXI4BNN53W4ZLS`, admin `ONXWG2LBNRUXIZJNMRSW23ZNORXXI4BNMFSG22LO`, publisher `ONXWG2LBNRUXIZJNMRSW23ZNORXXI4BNOB2WE3DJONUGK4Q`.
Keycloak admin console (local only): http://localhost:5556/admin — `admin` / `socialite-kc-admin-local-only`. Email capture: http://localhost:8025.

Demo app users are pre-provisioned as *pending* and bind to their Keycloak subject on first verified sign-in. If sign-in reports an account conflict after the identity provider changed, reset the local database (`pnpm db:reset`); the app never re-binds an account by email.

The demo workspace uses **simulated destinations** only (`mock_…` IDs, labelled "Simulated"). Nothing is posted to real networks.

`./scripts/dev.sh --detach` runs in the background; `./scripts/stop.sh` stops it (`--infra` also stops Docker services).

## Test

```bash
pnpm test               # unit + provider contract tests (no network)
pnpm test:integration   # real PostgreSQL + S3 + Keycloak (needs infra running)
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
| `infra` | Local Compose stack (PostgreSQL, SeaweedFS, Keycloak, Mailpit), realm export, DB roles, Dockerfile |
| `docs` | Architecture, API, operations, deployment, status |

## Key docs

[Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Provider capabilities](docs/PROVIDER_CAPABILITIES.md) · [Deployment](docs/DEPLOYMENT.md) · [Operations](docs/OPERATIONS.md) · [Requirements matrix](docs/REQUIREMENTS_MATRIX.md) · [Test report](docs/TEST_REPORT.md) · [Activation checklist](docs/FINAL_ACTIVATION_CHECKLIST.md) · [Implementation gaps](docs/IMPLEMENTATION_GAPS.md) · [Build status](docs/BUILD_STATUS.md)
