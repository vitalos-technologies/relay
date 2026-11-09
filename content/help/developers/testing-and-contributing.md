---
title: Testing and contributing
summary: The test layers (unit, provider contracts, integration on real PostgreSQL, end-to-end), how to run them, what CI checks, and the conventions a change must follow.
section: developers
audience: developer
status: available
related: [local-development-setup, provider-adapters, data-model-and-migrations, api-conventions]
product_version: "2026-11"
reviewed: 2026-11-09
order: 70
keywords: [tests, testing, vitest, playwright, ci, contributing, pull request, conventions]
---

## Test layers

| Layer | Location | Runs against | Command |
|---|---|---|---|
| Unit | `tests/unit/*.test.ts` (30 files) | Pure code, no IO | `pnpm test:unit` |
| Provider contracts | `tests/contracts/*.test.ts` (16 files) | Adapters against recorded or simulated network responses | `pnpm test:contracts` |
| Integration | `tests/integration/*.test.ts` (67 files) | A **real** PostgreSQL database created per run from all migrations, plus local storage, Keycloak and Mailpit where a test needs them | `set -a; . ./.env; set +a; pnpm test:integration` |
| End-to-end | `tests/e2e/*.spec.ts` (18 files) | A running web app and worker, Playwright 1.63, desktop (1440×900) and a `@mobile` project | `pnpm test:e2e` |

`pnpm test` runs unit and contract tests (630 tests, about 15 seconds on the verification machine). Vitest 3.2 projects are defined in `vitest.config.ts`; workspace imports such as `@social-lite/services/x` resolve straight to `packages/*/src`.

### Integration tests

- Each run creates `socialite_test_<pid>_<time>` with the admin account (`TEST_ADMIN_DATABASE_URL`, default: the local compose database), applies every migration and drops it afterwards, so runs never touch your development data and can run in parallel. Set `TEST_DATABASE_URL` to pin one database (it is reset first).
- Tests run in one forked process with a 30-second timeout. Run a single file with `npx vitest run --project integration tests/integration/mcp.test.ts`.
- Never substitute SQLite or an in-memory fake for PostgreSQL: locking, constraints and triggers are part of what is tested.

### End-to-end tests

- Global setup seeds an isolated "E2E Workspace" (`scripts/seed-e2e.ts`) so test data never lands in the demo workspace; `E2E_SKIP_SEED=1` skips seeding.
- `tests/e2e/helpers.ts` signs in through the real Keycloak flow (`signIn`) and calls the API from inside the signed-in page with the session's CSRF token (`api`).
- Point the suite at another server with `E2E_BASE_URL`. One worker at a time (`workers: 1`) because the tests share seeded data.
- Each spec sets up, and afterwards removes, the state it depends on (for example `integrations.spec.ts` disconnects
  leftover simulated installations and switches translation off before and after it runs), so it passes alone, in the
  full suite and on repeated runs.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests: secret scan of tracked files (`scripts/secret-scan.sh`), production dependency audit, typecheck (root and web app), unit and contract tests, integration tests on real PostgreSQL with S3, Keycloak and Mailpit, the migration check (fresh database, applied twice), production builds, the fail-closed production configuration test, and then (second job) the web and worker Docker images. End-to-end tests are not part of CI; run them against a local stack before merging.

Documentation checks:

- `node scripts/docs-api-check.mjs` fails when the generated [API route reference](/help/developers/api-route-reference), [MCP tool reference](/help/developers/mcp-tool-reference), `docs/api/openapi.json`, `docs/api/routes.md` or `docs/api/mcp.json` no longer match the code, or when the code reads an environment variable that [Environment variables](/help/developers/environment-variables) does not mention. Fix it with `node scripts/docs-api-check.mjs --write` and commit the regenerated files.
- `node scripts/docs-check.mjs` validates Help Centre articles (front matter, links, images, contextual help links, secret patterns).

## Conventions for changes

- **Routes are thin.** Start every `route.ts` with a one-line header comment (`// METHOD /api/path — purpose`); it becomes the route's description in the generated reference. Parse input with a strict zod schema and call one service function.
- **Authorization in services.** Every service checks permissions with the central policy and scopes every query by workspace and brand. Return `not_found` for anything outside the caller's scope.
- **Writes are idempotent and atomic.** Actions that must not repeat take an `Idempotency-Key`; follow-up work is written to the outbox in the same transaction; job handlers take ids only and re-check authority.
- **Never resend on doubt.** Anything that may have reached a network is `unknown` and reconciled read-only.
- **Live is never simulated.** Simulated transports are only for `mock_` destinations outside production; missing credentials fail with `provider_not_configured`, never with fake success.
- **No secrets in code, logs, fixtures or docs.** Use placeholders; the secret scan fails on known credential formats.
- **Migrations are additive and never edited after they are applied.** Use the next free number.
- **Provider rules come from the networks' current official documentation**, recorded with the date they were checked, and kept separate from Relay's own limits.

## Before you open a pull request

1. `pnpm -s typecheck`
2. `pnpm test`
3. The integration tests for the areas you touched (or the whole suite)
4. The end-to-end spec for the screens you touched, on desktop and `@mobile`
5. `node scripts/docs-api-check.mjs` (regenerate with `--write` if you changed routes, MCP tools or configuration)
6. Update the Help Centre articles that describe the behaviour you changed
