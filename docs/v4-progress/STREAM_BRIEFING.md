# V4 parallel streams — common briefing (lead)

Read in order: `HANDOFF.md` (rules), `docs/queue/03g_V4_PROMPT.md` (the user's full V4 brief), `docs/V4_WORKSTREAMS.md`
(contract: your scope, migration number, owned files, shared-file rules, interfaces), `docs/v4/BASELINE.md` (what exists),
`packages/core/src/contracts/v4-plans.ts` + `v4-billing.ts` (lead contracts), and V5 §5–10 of `docs/queue/03h_V5_PROMPT.md`
(so V4 doesn't block it). Then inspect the code you will extend before writing anything.

## Running in parallel with the other streams (SUP support, BIL billing, ENT entitlements)
- Repository: `/home/user/relay` (one working tree shared by all streams). Local env: `.env` (gitignored; never print it).
  Load it with `set -a; . ./.env; set +a`.
- One shared dev host. The web app on :3000 is a production build (`next start`); the worker is
  `apps/worker/dist/main.mjs` (pid in `.data/worker.pid`, web pid in `.data/web.pid`). **Any rebuild/restart of web or
  worker, any migration apply, and any Playwright run must hold the lock**:
  `flock -o /home/user/relay/.data/devserver-v2.lock <command>`. Always `-o`; when backgrounding a server inside the
  command add `3>&- 9>&-`. Rebuild web: `pnpm --filter @social-lite/web build`, then restart
  `cd apps/web && nohup npx next start --port 3000 > ../../.data/logs/web.log 2>&1 3>&- 9>&- &` (kill the old one first;
  check nothing else holds :3000). Worker: `cd apps/worker && node build.mjs`, restart with
  `DATABASE_URL=$WORKER_DATABASE_URL nohup node apps/worker/dist/main.mjs > .data/logs/worker.log 2>&1 3>&- 9>&- &`.
  Readiness: `curl -s localhost:3000/api/ready`, `curl -s localhost:3001/health`.
- Keep rebuilds rare (batch your UI work). Run only YOUR E2E spec during development; the lead runs the full suite.
  Integration tests use disposable per-run databases (`set -a; . ./.env; set +a; npx vitest run --project integration
  tests/integration/<yours>`), safe in parallel. Unit: `pnpm test`. Typecheck: `pnpm -s typecheck`.
- Migrations: only your allocated file. Apply to dev (`pnpm db:migrate` then `pnpm db:roles`) under the lock, then it is
  frozen; ask the lead for a new number for follow-ups.
- Shared files: re-read immediately before editing, keep diffs small and additive, list them in your progress note. Another
  stream may have edited them since you last looked. `packages/core/src/authz.ts` is lead-only (permissions are reserved).
- **No git state changes** (no commit, stash, checkout, reset, restore). The lead commits each stream when it reports.
- E2E sign-in: `tests/e2e/helpers.ts` (`signIn`, `api`); `owner@demo.social-lite.test` is the E2E workspace owner and a
  seeded platform operator; `owner@other.social-lite.test` has no platform role. TOTP via `npx tsx scripts/demo-totp.ts`.

## Always
Do not print/commit/send secrets; never ask for credentials; missing credentials never become success; no paid services,
no live billing, no real customer messages, no live publishing; only this project's resources; don't describe simulated
or test-mode behaviour as live; no model names in code or docs. Check current official provider docs before relying on an
API detail (Stripe: Checkout Sessions, Billing subscriptions + quantity, Customer Portal, webhook signatures, event
ordering). No new dependencies without a reason in your report (prefer `fetch` + HMAC over an SDK if it keeps the bundle
lean; justify either way).

## Deliver
- Progress note `docs/v4-progress/<stream>.md` (decisions, status, done, next, files new vs edited-shared, activation
  items) — keep it current; it is your resume point if you are interrupted.
- Checkpoint screenshots `evidence/v4/<stream>/` (1440 and 390 px, deviceScaleFactor 2, light + dark) of your key screens.
- Tests: unit, integration (cover the brief §18 items you own), your E2E spec (desktop + `@mobile`), no page-level
  horizontal scroll at 320/360/390/430/768/1440.
- Your docs in `docs/v4/` (see `docs/V4_WORKSTREAMS.md` "Docs each stream writes").
- Final report (compact): built, tests with numbers, §18 acceptance items covered, best 4–6 screenshot paths, edited shared
  files, activation items, blockers/decisions.
