# V5 parallel streams — common briefing (lead)

Read in order: `HANDOFF.md` (rules), `docs/queue/03h_V5_PROMPT.md` (the user's full V5 brief), `docs/V5_WORKSTREAMS.md`
(contract: your scope, migration number, owned files, shared-file rules, lead decisions), `docs/DECISIONS.md` D21–D25,
`docs/brand/V5_MARKETING_MOCKUP_NOTES.md` (visual direction), the V4 docs your stream builds on (`docs/v4/*`), and
`packages/core/src/contracts/v4-plans.ts`. Then inspect the code you will extend before writing anything.

## Running in parallel with the other streams (MKT marketing, WID support widget, AIW AI workspace)
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
- Lessons from V4: kill only the server you started (`kill $(cat .data/web.pid)`; check `ss -ltnp | grep :3000`), never
  leave a background loop holding the lock, and never write a lock-holder whose own command line matches what it waits
  for. A stale `next-server` on :3000 serving a rebuilt `.next` makes sign-in hang.
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
no live billing, no real campaigns, no real customer messages, no live publishing; only this project's resources; don't describe simulated
or test-mode behaviour as live; no model names in code or docs. Check current official provider docs before relying on an
API detail (ordering — no billing changes are expected in V5). Dependencies: only the lead-approved UI stack (D25) plus anything you
justify in your report; check current official docs (shadcn/ui, Base UI, Motion for React, Next 16) before using an API.
Respect `prefers-reduced-motion`; content must stay visible with animation disabled.

## Deliver
- Progress note `docs/v5-progress/<stream>.md` (decisions, status, done, next, files new vs edited-shared, activation
  items) — keep it current; it is your resume point if you are interrupted.
- Checkpoint screenshots `evidence/v5/<stream>/` (1440 and 390 px, deviceScaleFactor 2, light + dark) of your key screens.
- Tests: unit, integration (cover the brief §18 items you own), your E2E spec (desktop + `@mobile`), no page-level
  horizontal scroll at 320/360/390/430/768/1024/1440; keyboard, focus, screen-reader names, reduced motion, 200 % zoom.
- Your docs in `docs/v5/` (see `docs/V5_WORKSTREAMS.md` "Docs").
- Final report (compact): built, tests with numbers, §18 acceptance items covered, best 4–6 screenshot paths, edited shared
  files, activation items, blockers/decisions.
