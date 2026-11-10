---
title: Set up a local development environment
summary: Install dependencies, start the local services, migrate and seed a database, then run the web app and worker — verified on a clean copy of the repository.
section: developers
audience: developer
status: available
related: [environment-variables, architecture-and-modules, testing-and-contributing, data-model-and-migrations]
product_version: "2026-11"
reviewed: 2026-11-10
order: 11
keywords: [setup, install, local, docker, dev, quick start, getting started]
---

## Before you start

| Requirement | Version used in this repository |
|---|---|
| Node.js | 22.12 or later (`engines` in `package.json`; verified with 22.23) |
| pnpm | 10.28.0 (`packageManager` in `package.json`) |
| Docker with Compose | Any recent version; runs PostgreSQL 16, SeaweedFS, Keycloak 26.4 and Mailpit |
| ffmpeg / ffprobe | Only for video uploads (the worker looks in `/usr/bin` unless `FFMPEG_PATH` / `FFPROBE_PATH` are set) |

Everything below runs against disposable local services with synthetic data. No real social accounts, payment provider or email delivery are involved.

## Quick start (one command)

1. Copy the example configuration: `cp .env.example .env`.
2. Generate the two local secrets and paste them into `.env`:
   - `SESSION_SECRET`: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   - `KEY_ENCRYPTION_KEYS`: `local-dev-1:` followed by the output of the same command.
3. Run `./scripts/dev.sh --detach`.

The script checks that Docker is running, installs dependencies if needed, starts the local services, creates the database roles, applies migrations, seeds demo data, builds the worker and starts the worker and the web app (development server on port 3000). Logs go to `.data/logs/`; stop everything with `./scripts/stop.sh`.

**Expected outcome:** the script prints "Relay is running at http://localhost:3000" with the demo sign-in details. `curl -s localhost:3000/api/ready` returns `{"status":"ready",…}` and `curl -s localhost:3001/health` returns `{"status":"ok",…}`.

> **Important:** `dev.sh` runs the migrations, which records each migration's checksum. If you are editing a migration file that has not been merged yet, apply it only when you are done editing; an applied migration that changes afterwards stops the migrator with "checksum mismatch".

## Step by step

Use these steps when you want control over each stage, for example to use a second database next to an existing one.

1. **Install dependencies:** `pnpm install --frozen-lockfile`.
2. **Start the local services:** `docker compose -f infra/compose.yaml up -d --wait` (or `pnpm infra:up`).
3. **Load the configuration into your shell:** `set -a; . ./.env; set +a`.
4. **Create the database roles:** `pnpm db:roles`. This connects with `DATABASE_ADMIN_URL`, creates the migrator, app and worker login roles from the passwords in your role URLs and applies `infra/postgres/roles.sql` to the database named in `DATABASE_URL`.
5. **Apply migrations:** `pnpm db:migrate` (runs as `MIGRATOR_DATABASE_URL`), then `pnpm db:roles` again so new tables get the app and worker grants.
6. **Seed synthetic data:** `pnpm db:seed` (demo workspace with two demo brands, simulated destinations, sample posts) and, for end-to-end tests, `pnpm db:seed:e2e`. Seeding needs `ENABLE_MOCK_PROVIDERS=true` and refuses to run in production.
7. **Build and start the worker:** `(cd apps/worker && node build.mjs)`, then `DATABASE_URL="$WORKER_DATABASE_URL" node apps/worker/dist/main.mjs`. The worker refuses to start on an unmigrated database.
8. **Start the web app:** link the configuration (`ln -sf ../../.env apps/web/.env.local`), then `cd apps/web && npx next dev --webpack --port 3000`. For a production build use `pnpm --filter @social-lite/web build` and `npx next start --port 3000`.

### Using a separate database

To run a second copy next to an existing database, change only the database name in the four database URLs (`DATABASE_URL`, `WORKER_DATABASE_URL`, `MIGRATOR_DATABASE_URL`, `DATABASE_ADMIN_URL`), create that database once with the admin account (`CREATE DATABASE <name>`), then follow steps 4–8. Use a different `S3_BUCKET` (the worker creates it outside production), `APP_BASE_URL` with a spare port, and `WORKER_HEALTH_PORT` for the worker. The local identity provider accepts sign-in callbacks on ports 3000 and 3100 only (`infra/keycloak/social-lite-realm.json`).

## Sign in locally

1. Open the app and choose **Sign in**. You are sent to the local Keycloak realm.
2. Use one of the seeded demo identities (`owner@demo.social-lite.test`, `admin@…`, `editor@…`, `publisher@…`, `analyst@…` and others in the realm file). There are no passwords: enter the email and read the link or 6-digit code from Mailpit (http://localhost:8025).
3. Privileged demo identities (owner, admin, publisher) ask for a one-time code. Print the current code with `npx tsx scripts/demo-totp.ts owner` (also `admin`, `publisher`, `other-owner`).

Other local tools: Keycloak admin console on port 5556, captured email on port 8025, worker health on port 3001.

## Verification record

This page was verified on 2026-11-09 on a clean copy of the working tree (tracked and untracked files, no `node_modules`, no `.env`) using a separate database and bucket next to the shared development services:

| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile` | 606 packages from the local store in 4 s; one ignored build script (`core-js`) |
| New `.env` with freshly generated `SESSION_SECRET` and `KEY_ENCRYPTION_KEYS` | Accepted |
| `pnpm db:roles` → `pnpm db:migrate` → `pnpm db:roles` | 34 migrations (001–038; numbers 018, 023, 024 and 033 are unused) applied in 2.7 s |
| `pnpm db:seed` / `pnpm db:seed:e2e` | Demo, Other and E2E workspaces created; bucket created |
| Worker build + start | Built in under 1 s; `/health` and `/ready` OK; 16 simulated deliveries processed; no warnings or errors in the log |
| Web (`next dev`) | `/api/ready` reported `34 applied` after the first compile |
| Sign-in through Keycloak (editor identity, authorization code + PKCE) | Landed on `/overview`; `GET /api/session` returned the user, two workspaces and a CSRF token |
| API smoke checks | Error envelope, CSRF refusal (403 `csrf_failed`), wrong Origin (403), workspace mismatch (409), signed-out (401) all as documented |
| MCP over Streamable HTTP with a service-account key | `initialize` negotiated 2025-11-25; 47 tools listed; idempotent replay and revocation behaved as documented |
| Worker `SIGTERM` | Drained (`worker_draining` → `worker_stopped`, 0 in flight) |
| `pnpm test` | 46 files, 630 tests passed |

Not verified in that run: a production build (`next build`), the Docker images, and real provider connections.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| "Docker is not running" from `dev.sh` | Docker daemon stopped | Start Docker. In a container where Docker was stopped uncleanly, see the note below. |
| `Invalid configuration: SESSION_SECRET` (or another name) | A value in `.env` fails validation (`packages/services/src/config.ts`), e.g. a secret shorter than 32 characters | Fix the named variable. |
| `migration NNN_x.sql was modified after being applied (checksum mismatch)` | A migration file changed after it was applied to this database | Restore the original file; put the change in a new migration. |
| Worker exits with "Database is not migrated" | Migrations not applied to the database in `WORKER_DATABASE_URL` | Run step 5. |
| Sign-in returns to the login page with `error=…` | `APP_BASE_URL` port is not an allowed redirect URI in the local realm | Use port 3000 or 3100, or add the URI in Keycloak. |
| Sign-in hangs after a rebuild | An old `next-server` process still serves the previous build | Stop the old process, then start the server again. |

> **Note:** If Docker was stopped uncleanly (for example after a container restart) and refuses to start because its pid file points at a process that no longer exists, remove only that stale pid file, start the Docker daemon, then run `docker compose -f infra/compose.yaml up -d --wait`.

## Limitations

- The local identity provider, storage and email are for development only; production refuses to start with them.
- Simulated destinations behave like the networks' happy and failure paths but never contact a real network.
