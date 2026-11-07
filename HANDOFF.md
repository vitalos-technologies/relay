# Relay — handoff (read this first)

Last updated: 2026-11-07 07:25 UTC · Lead agent keeps this current after every milestone.

## Resume in a new session / another Claude account
1. Get the repo. **It has no git remote yet.** To continue outside this container, push it to a GitHub repo first (ask the lead to do it once a repo exists), then clone. Working dir used here: `/home/user/social-lite`.
2. Paste this to the new Claude session:
   > Continue building Relay. Read `HANDOFF.md`, then `docs/PROGRESS.md`, then the active brief. Work autonomously; follow the rules in HANDOFF.md.
3. Environment: `cp .env.example .env` (fill local values; never commit secrets), then `./scripts/dev.sh --detach`. Note: `dev.sh` runs `db:migrate`, which locks migration checksums. Only run it when no stream is still editing a migration (see "Uncommitted work").
4. Container restarted and Docker is down: if `/var/run/docker.pid` points at a dead PID, remove only that file, start `dockerd`, then run `docker compose -f infra/compose.yaml up -d --wait`.

## What Relay is
- Lightweight social publishing app (formerly "Social Lite").
- Tagline: "Create. Coordinate. Publish."
- Brand kit: `docs/brand/relay-brand-kit.webp`; decisions D18–D19 in `docs/DECISIONS.md`.
- Brand colours: orange `#FD6701`, red `#FE4114`, amber `#FDA602`, ink `#121416`, mist `#EBEDEE`. Font: Inter.
- pnpm monorepo:
  - `apps/web`: Next 16, webpack build.
  - `apps/worker`: esbuild bundle.
  - `packages/{core,db,providers,services}`.
- Infrastructure: Postgres 16, pg-boss, SeaweedFS S3, Keycloak 26.4 (OIDC + MFA), Mailpit.
- Tests:
  - `pnpm test`: unit + contracts.
  - `set -a; . ./.env; set +a; npx vitest run --project integration`: real Postgres, disposable DB per run.
  - `pnpm test:e2e`: Playwright.

## Specs (all in repo)
| Phase | Brief |
|---|---|
| V1 product spec + system design | `docs/specs/V1_PRODUCT_SPEC_AND_SYSTEM_DESIGN.md` |
| V2 security & multi-team | `docs/specs/V2_UPGRADE_PROMPT.md` |
| V3 redesign, analytics, 10 networks, Drive/Docs/Notion, MCP | `docs/specs/V3_UPGRADE_PROMPT.md` |
| V3 UX redesign (lead brief) | `docs/queue/018_UX_REDESIGN_BRIEF.md` |
| V3.1 performance & resilience | `docs/queue/03b_V3_1_PROMPT.md` |
| V3.1 Admin app | `docs/queue/03c_V3_1_ADMIN_PROMPT.md` |
| Collaboration completion | `docs/queue/03d_COLLABORATION_PROMPT.md` |
| V3.5 integrations, inbox, listening, AI | `docs/queue/03f_V3_5_PROMPT.md` |
| Copy cleanup | `docs/queue/03e_COPY_CLEANUP_PROMPT.md` |
| Docs + Help Centre (last) | `docs/queue/04_DOCUMENTATION_PROMPT.md` |

Older notes may cite `/root/.claude/uploads/.../*.md`; those are the same files as `docs/specs/*`.

## Queue (in order)
1. V1 + V1.1: **done** (tag `v1.1.0-local`).
2. V2: streams B/C/D done. **Stream A (identity/security) is finishing.** V2 docs are committed (`docs/V2_*`). Tag v2 after A lands and the full suite + E2E pass.
3. V3:
   - Providers: done.
   - Lead engine gaps: done.
   - **Running:** AN analytics (migration 015), CH content hub (016), MCP (017).
   - Next: UX redesign (018 brief), launched when V2-A finishes. Then the V3 docs.
4. V3.1 → 5. V3.1 Admin → 6. Collaboration → 7. **V3.5** → 8. Copy cleanup → 9. Docs + Help Centre.

## Current state (keep updated)
- **Background agents** (a new session will NOT have them): V2-A, AN, CH, MCP.
  - If they're gone, re-launch each from its progress note. Each note lists what is done and what's next:
    - `docs/v2-progress/A.md`
    - `docs/v3-progress/{analytics,content-hub,mcp}.md`
  - Stream contracts: `docs/V2_WORKSTREAMS.md`, `docs/V3_WORKSTREAMS.md`.
- **Dev DB:**
  - Migrations through 014, plus 019, are applied.
  - 015–017 are NOT applied; apply them together once their streams land.
  - Because of that, `/api/ready` reports `not_ready`.
- **Lead work in progress (uncommitted):**
  - G14 runtime DB-role guard: `packages/db/src/runtime-role.ts`, wired into `apps/worker/src/main.ts` and `apps/web/instrumentation.ts`. Tested in `tests/integration/db-roles.test.ts`.
  - G7 expired-grant sweep: `packages/services/src/grant-expiry.ts`. Still needs a worker `every()` line + a test.
- **Lead checklist after streams land:**
  1. Integrate and commit each stream's files.
  2. Apply 015–017 to dev.
  3. Reset + re-seed the dev DB (E2E fixtures leaked into the demo workspace).
  4. Fix Keycloak demo identities.
  5. Run full tests + E2E.
  6. Tag v2.
  7. Launch UX.
  8. Write the V3 docs.
- **Known gaps:** `docs/V2_IMPLEMENTATION_GAPS.md`. G3/G4/G5/G6/G8 were sent to stream A. G19 is done.

## Uncommitted work (who owns what)
`git status` shows files from the running streams. **Never commit or revert another stream's files mid-flight.** Commit only files you changed, by explicit path.
- A: `apps/web/lib/csp.ts`, `infra/keycloak/*`, `tests/e2e/security.spec.ts`, `tests/integration/{auth,keycloak}*`, `scripts/{dev.sh,demo-totp.ts}`, `docs/{DECISIONS,DEPLOYMENT,OPERATIONS}.md`, `evidence/v2/security-*`.
- AN: `packages/services/src/analytics/**`, `packages/core/src/contracts/analytics.ts`, migration 015.
- CH: `packages/services/src/content-hub/**`, `apps/web/components/content-hub/**`, migration 016, `services/{settings,setup}.ts`.
- MCP: `packages/services/src/mcp/**`, `apps/web/components/mcp/**`, migration 017.

## Rules (from the user; always apply)
- **Credentials and secrets:**
  - Never print, commit or send secrets.
  - Never ask for credentials in chat; use the app's protected setup or the deployment secret manager.
  - Missing credentials never become fake success.
  - Real connections never fall back to mock publishing. Mock transports are only for `mock_` connections, and never in production.
- **External resources:**
  - Don't provision billable resources, buy services or enable paid APIs.
  - Don't publish to live business channels or send real customer messages.
  - Never overwrite an existing Telegram webhook.
  - Use only this project's resources. Don't touch other Vitalos/TipSignal production projects, even if credentials are visible.
- **Honesty:** don't describe planned or simulated behaviour as implemented. Record external blockers in the final activation checklist.
- **Working style:**
  - Autonomous: no routine questions.
  - Send screenshots as you go (deviceScaleFactor 2, both themes).
  - Less text; clean interfaces; concise UI copy.
  - When asked for design directions, give 2–3 options and a recommendation.
- **Git:**
  - Author: `Relay Build <design@vitalos.co.uk>`.
  - End each commit message with:
    ```
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: <current session URL>
    ```
  - No model names elsewhere.
- **Final deliverable:** one consolidated activation checklist (including the master SVG logo from the user's designer).
