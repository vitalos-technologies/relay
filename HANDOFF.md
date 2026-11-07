# Relay — handoff (read this first)

Last updated: 2026-11-07 07:25 UTC · Lead agent keeps this current after every milestone.

## Resume in a new session / another Claude account
1. Clone `https://github.com/vitalos-technologies/relay` (branch `main`; the lead pushes after each milestone). Working dir used here: `/home/user/social-lite`.
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

## Versions (git tags exist locally only; this environment can't push tags)
| Tag | Commit |
|---|---|
| v1.0.0-local | fa905db |
| v1.1.0-local | e2bc6ec |
| v2.0.0 | 4815af8 |

To recreate them on GitHub from any machine: `git tag v2.0.0 4815af8 && git push origin v2.0.0` (same for the others).

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
2. V2: **done** (all streams A–D). Final run on main: unit 104, contracts 351, integration 321, security E2E 8/8, rehearsal PASS (`docs/V2_TEST_REPORT.md`). Full browser E2E re-run is pending until the redesign lands (last run 33/38).
3. V3:
   - Providers: done.
   - Lead engine gaps: done.
   - MCP (017), CH content hub (016), AN analytics (015) **all done and integrated** (864cf18, 57e056b, 523c1dd; MCP source + analytics tools 18b5c53, ed9aa1f).
   - Next: UX redesign (018 brief), launched when V2-A finishes. Then the V3 docs.
4. V3.1 (backend streams running) → 5. V3.1 Admin → 6. Collaboration → 7. **V3.5** → 8. Copy cleanup → 9. Docs + Help Centre.

## Current state (keep updated)
- **V3.1 started early (backend only)** while UX owns screens: streams PERF (020), DATA (021), GOV (022); contract `docs/V3_1_WORKSTREAMS.md`, progress `docs/v3-1-progress/{perf,data,gov}.md`. Plus a V3 docs agent (V3_REQUIREMENTS_MATRIX, BUILD_STATUS, GAPS, ACTIVATION, PLATFORM_CAPABILITIES, SECURITY_AND_TEST_REPORT). V3.1 UI comes after UX lands.
- **V3.1 DATA + GOV: done and committed** (88d4fef) together with PERF's in-place backend edits (worker imports them). Migrations 020/021/022 applied to dev and frozen; follow-ups go in 023 (DATA), 024 (GOV), 025 (PERF). Worker rebuilt + restarted. V3 docs done (1dbc91c). V3.1 API contracts for the UI stream: `packages/core/src/contracts/v31-{data,gov,perf}.ts`, `docs/V3_1_DATA_API.md`, route table in `docs/v3-1-progress/gov.md`.
- **Brand-rule hold:** decided and done (46d6313): open mandatory review or 'will_edit' holds delivery; 'keep' releases.
- **V3.1 PERF: done** (277c2ff; docs/PERFORMANCE_{BASELINE,BUDGETS,RESULTS}.md). Follow-up running: analytics 365-day per-day summary (migration 025) + approval inbox Medium p95. Worker now uses up to 20 DB connections per instance (main 10 + bulk 6 + pg-boss 4): note for V3.1 activation (production max_connections / pooler sizing).
- **Open UI decision (PERF):** planner payload ~700–800 KB across all brands; needs paging or per-brand loading in the redesigned Planner.
- **Background agents** (a new session will NOT have them): UX redesign, PERF follow-up. Relaunch any missing one from its progress note + brief (started 07:5x; brief `docs/queue/018_UX_REDESIGN_BRIEF.md`, progress `docs/v3-progress/ux.md`; A has landed and UX was told it may now edit Settings).
- **CH follow-ups:** CH's edits to `apps/web/lib/csp.ts`, `apps/web/proxy.ts`, `tests/unit/security-headers.test.ts`, `apps/web/app/(app)/settings/page.tsx` are uncommitted (mixed with A's); commit with A. Live Google/Notion apps + browser Picker untested (activation).
- **MCP follow-ups:** recreate Keycloak (`docker compose -f infra/compose.yaml up -d --force-recreate oidc`) after A lands to load the `relay-mcp` client/scopes; place MCP settings in the redesigned Settings nav (now `/mcp/settings`). Real MCP clients need public HTTPS (activation checklist).
  - If they're gone, re-launch each from its progress note. Each note lists what is done and what's next:
    - `docs/v2-progress/A.md`
    - `docs/v3-progress/{analytics,content-hub,mcp}.md`
  - Stream contracts: `docs/V2_WORKSTREAMS.md`, `docs/V3_WORKSTREAMS.md`.
- **Dev DB:**
  - All migrations 001–019 + 021 + 022 applied (021/022 frozen early because their streams' live code broke the dev server; follow-ups go in 023/024). 020 (PERF) pending. Worker rebuilt and restarted on the new code.
  - Because of that, `/api/ready` reports `not_ready`.
- **Lead work in progress:**
  - G7 + G14: committed incl. worker wiring.
  - AN gap: no adapter fetches follower/audience numbers (live shows "not fetched").
- **Done:** all streams integrated, Keycloak recreated (MCP client loaded), dev DB reset + re-seeded (`pnpm db:reset` then `npx tsx scripts/analytics-demo.ts`), v2.0.0 tagged.
- **Lead next:** integrate UX when it reports; full browser E2E + fixes; V3 docs (requirements matrix, build status, gaps, activation, platform capabilities, security & test report); then V3.1.
- **Known gaps:** `docs/V2_IMPLEMENTATION_GAPS.md`. G3/G4/G5/G6/G8 sent to stream A. Done by lead: G7, G14, G19 (update that doc at integration).

## Uncommitted work (who owns what)
Backup: branch `wip/streams` on GitHub is a snapshot of all uncommitted stream work (refreshed by the lead at each stop). In a new session, `git checkout origin/wip/streams -- .` restores it on top of `main`. Then re-launch the streams from their progress notes.
`git status` shows files from the running streams. **Never commit or revert another stream's files mid-flight.** Commit only files you changed, by explicit path.
- A: `apps/web/lib/csp.ts`, `infra/keycloak/*`, `tests/e2e/security.spec.ts`, `tests/integration/{auth,keycloak}*`, `scripts/{dev.sh,demo-totp.ts}`, `docs/{DECISIONS,DEPLOYMENT,OPERATIONS}.md`, `evidence/v2/security-*`.
- CH: committed (see CH follow-ups for the 4 shared files).
- MCP: committed; its `infra/keycloak/social-lite-realm.json` edit is uncommitted (shared with A).

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
