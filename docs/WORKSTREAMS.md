# Build workstreams, ownership and conventions

Read `docs/API.md`, `packages/core/src/*` and `packages/db/migrations/001_core.sql` before writing code.

## Ownership (do not edit files owned by another stream; ask the lead via your final report)

| Stream | Owns |
|---|---|
| Lead / engine | `packages/core/**`, `packages/db/**` (all migrations), `packages/services/src/{config,log,context,outbox,audit,tenancy,idempotency,crypto}.ts`, `packages/services/src/{posts,scheduling,approvals,engine,history,planner,dashboard,ops,notifications,webhooks,reconcile}/**`, `apps/worker/**`, `apps/web/lib/api.ts`, `apps/web/app/api/{posts,schedules,approvals,deliveries,history,planner,dashboard,ops,webhooks}/**`, `packages/providers/src/{registry.ts,index.ts,transport/**}`, root config, `vitest.config.ts` |
| Foundation | `packages/services/src/auth/{oidc,invitations,users}.ts`, `packages/services/src/{members,workspaces,brands,templates,storage,email,ssrf,ratelimit,settings,setup,diagnostics,audit-read}.ts`, `packages/services/src/media/**`, `apps/web/app/api/{auth,session,workspace,members,invitations,brands/route.ts,brands/[id]/route.ts,brands/[id]/pause,brands/[id]/assets,brands/[id]/templates,assets,templates,notifications,audit,setup,diagnostics,ready}/**`, `tests/integration/{auth,tenancy,media,crypto,members,setup}*.test.ts` |
| Meta providers | `packages/providers/src/meta/**`, `tests/contracts/meta*.test.ts`, `docs/providers/meta.md` |
| Telegram/X + connections | `packages/providers/src/{telegram,x}/**`, `packages/services/src/connections/**`, `apps/web/app/api/{providers,oauth,connection-flows,connections}/**`, `apps/web/app/api/brands/[id]/connections/**`, `tests/contracts/{telegram,x}*.test.ts`, `tests/integration/connections*.test.ts`, `docs/providers/{telegram,x}.md` |
| Product UI | `apps/web/app/**` pages/layouts (NOT `app/api/**`), `apps/web/components/**`, `apps/web/lib/client/**`, `apps/web/app/globals.css`, `apps/web/public/**` |
| QA / release | `tests/e2e/**`, `playwright.config.ts`, `infra/docker/**`, `.github/**`, `docs/{OPERATIONS,DEPLOYMENT}.md`, `scripts/**` (except `scripts/seed.ts` which lead owns) |

## Rules

- **Never run `pnpm add`/`pnpm install`** — dependency changes go through the lead (lockfile contention). Already installed:
  core: zod, twitter-text · db: pg · services: pg-boss, openid-client, sharp, file-type, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/s3-presigned-post, nodemailer, uuid, papaparse, zod ·
  web: next 16, react 19, tailwind 4, lucide-react, simple-icons, geist, clsx, @radix-ui/{dialog,dropdown-menu,tabs,tooltip,popover,switch}, zod.
- **Never edit migrations.** Need a column/table? Write the SQL you need in your report; the lead adds it in a new migration.
- TypeScript strict; ESM imports with `.js` suffix inside `packages/*` (e.g. `import { x } from './y.js'`). Route files in `apps/web` import packages as `@social-lite/services` etc.
- Services take `Ctx` (packages/services/src/context.ts) and enforce authorization themselves via `requireAction`, `assertBrand`, `brandFilter`. Every tenant query filters by `workspace_id = ctx.access.workspaceId`. Cross-tenant ⇒ `notFound()`.
- Route handlers: `export const POST = route(async ({ req, ctx, params }) => ...)` from `@/lib/api`. Use `parseJson(req, schema)`. Next 16: `params` is already awaited by the wrapper. Add `export const dynamic = 'force-dynamic'` and `export const runtime = 'nodejs'`.
- Never log secrets, tokens, token-bearing URLs or post bodies. Use `log` from services (it redacts).
- Credentials: `encryptSecret(value, credentialAad(workspaceId))` / `decryptSecret` from `services/crypto.ts`. Never return them to clients.
- External network calls never happen inside a DB transaction.
- Mock destinations: `is_mock = true`, `provider_account_id` begins with `mock_`, only when `mockProvidersEnabled()`. Never fall back from a live connection to mock.
- Tests: unit (`tests/unit`), contracts (`tests/contracts`, no network), integration (`tests/integration`, real Postgres via `tests/integration/helpers.ts`). Run: `pnpm vitest run --project <name> <file>`.
- Typecheck: `npx tsc -p tsconfig.json --noEmit` (packages, worker, tests) and `cd apps/web && npx tsc --noEmit`.
- Local infra is already running (`docker compose -f infra/compose.yaml ps`). Env: `.env` at repo root (dev DB `socialite_dev`, test DB `socialite_test`). Do not stop or reset the dev database; tests use `socialite_test`.
- Do not `git commit`; the lead commits integrated milestones.
