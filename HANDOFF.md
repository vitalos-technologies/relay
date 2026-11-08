# Relay — handoff (read this first)

Last updated: 2026-11-08 11:30 UTC

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
| v3.1.0 | 78bd026 |
| v3.0.0 | 95f8e34 |
| v2.0.0 | 4815af8 |

To recreate them on GitHub from any machine: `git tag v2.0.0 4815af8 && git push origin v2.0.0` (same for the others).

## User reminder (do this when the whole queue is complete)
The user asked to be reminded, after the full build (through Docs + Help Centre) is finished, of the things only they can do:
1. Network approvals (Meta incl. insights, TikTok, YouTube/Google, LinkedIn, Threads, Pinterest, X credits): needed before real customers connect accounts.
2. Publish the version tags from their own machine (table above).
3. Choose hosting (offer: ARM build + setup for their shared Oracle VM).
4. Supply the master SVG logo for the final brand assets.
Include these at the top of the final consolidated activation checklist and in the final message.

## Specs (all in repo)
| Phase | Brief |
|---|---|
| V1 product spec + system design | `docs/specs/V1_PRODUCT_SPEC_AND_SYSTEM_DESIGN.md` |
| V2 security & multi-team | `docs/specs/V2_UPGRADE_PROMPT.md` |
| V3 redesign, analytics, 10 networks, Drive/Docs/Notion, MCP | `docs/specs/V3_UPGRADE_PROMPT.md` |
| V3 UX redesign (lead brief) | `docs/queue/018_UX_REDESIGN_BRIEF.md` |
| V3.1 performance & resilience | `docs/queue/03b_V3_1_PROMPT.md` |
| V3.1 Admin app | `docs/queue/03c_V3_1_ADMIN_PROMPT.md` |
| Collaboration | `docs/queue/03d_COLLABORATION_PROMPT.md` |
| V3.5 | `docs/queue/03f_V3_5_PROMPT.md` |
| V4 commercial + support | `docs/queue/03g_V4_PROMPT.md` |
| V5 marketing site, 2 plans + trial, support widget, AI workspace | `docs/queue/03h_V5_PROMPT.md` (mockup: `docs/brand/V5_MARKETING_MOCKUP_NOTES.md`) |
| Collaboration completion | `docs/queue/03d_COLLABORATION_PROMPT.md` |
| V3.5 integrations, inbox, listening, AI | `docs/queue/03f_V3_5_PROMPT.md` |
| Copy cleanup | `docs/queue/03e_COPY_CLEANUP_PROMPT.md` |
| Docs + Help Centre (last) | `docs/queue/04_DOCUMENTATION_PROMPT.md` |

Older notes may cite `/root/.claude/uploads/.../*.md`; those are the same files as `docs/specs/*`.

## Queue (in order)
1. V1 + V1.1 **done** (v1.1.0-local) → 2. V2 **done** (v2.0.0) → 3. V3 **done** (v3.0.0) → 4. V3.1 **done** (v3.1.0)
5. V3.1 Admin **done** (see below; tag v3.1.1 suggested on the admin commit)
6. Collaboration completion **done** (0f0bcd9; migration 027; docs/collaboration/*). Full E2E 56 passed / 1 skipped; unit 505; integration 413. Open: security.spec back-channel logout test needs its own user isolation; decisions taken by lead: email never includes post titles, clients can comment on shared reviews (on), change feed 7 d / presence 10 min retention, demo collab data kept.
6b. (Support inbox proposal → superseded by V4.) Platform host restriction (ops.<domain>, office/VPN IPs) is an activation item.
7. **V3.5** (`docs/queue/03f_V3_5_PROMPT.md`) **done** — foundation (102498a), streams B–E (33f3e12), stream F (admin + MCP + wiring + final docs; `docs/v3-5/*`). Open for user: Inbox in phone bottom bar; main nav grouping (copy-cleanup pass). → 7b. **V4 done** commercial + customer support (`docs/queue/03g_V4_PROMPT.md`: Relay support tickets, Platform → Support, plans/trials/subscriptions/billing via Stripe test mode behind a billing service, entitlements, tenant lifecycle; no Stripe keys in this environment → build against a provider interface with a test double + locally signed webhook fixtures; never request keys in chat) → 7c. **V5 (running: MKT/WID/AIW)** (`docs/queue/03h_V5_PROMPT.md`, queued by the user 2026-11-08: one-page marketing site, Standard £10 / Professional £25 per user per month + 14-day trial on V4's billing, marketing support widget → Platform → Support, AI workspace with real workflows) → 8. Copy cleanup (03e) → 9. Docs + Help Centre (04) → 10. One consolidated activation checklist + user reminder.

## Current state (keep updated) — 2026-11-08 11:30 UTC
- Working branch for this session: **`claude/dazzling-pasteur-8yny50`** (pushed after each milestone; merge to `main` via PR
  when the user asks). Working dir `/home/user/relay`.
- **V3.5 complete** (stream F committed: 8eb8d35): tsc clean, unit 564, integration 489/489,
  v35-final E2E 3/3, server perf within budget at 5k conversations / 20k messages / 7.5k observations, secret scan clean.
  Full E2E on the production build ran 2026-11-08: 2 failures were test-state issues (seeded display name; a revoked
  simulated Asana install left by v35-final) — both specs fixed in 74f3e89; re-run of those specs pending in the lead's
  notes, results go into `docs/v3-5/TEST_REPORT.md`.
- **V4 complete** (be6e8a6 streams + a437bd5/31729c0 final): support (034), billing/trials/seats (035), entitlements
  (036). Full E2E 93 passed / 0 failed / 7 skipped; unit 600; integration 551/552 (known flaky v31-analytics-summary);
  mobile QA 98 checks 0 overflow. Docs `docs/v4/*` incl. `TEST_REPORT.md`, `IMPLEMENTATION_GAPS.md`,
  `FINAL_ACTIVATION_CHECKLIST.md`.
- **V5 running** as three parallel streams (contract `docs/V5_WORKSTREAMS.md`, briefing `docs/v5-progress/STREAM_BRIEFING.md`,
  decisions D21–D25): **MKT** marketing site at `/` (app home → `/overview`), pricing presentation, signup flow (039 if
  needed); **WID** support widget → Platform → Support (037); **AIW** AI workspace + agent execution (038). Progress notes
  `docs/v5-progress/{mkt,wid,aiw}.md`. After they report: lead F5 (full E2E, mobile/a11y, perf, docs, activation), then
  copy cleanup (03e) → Docs + Help Centre (04) → consolidated activation checklist + user reminder.
- **If this session is gone:** uncommitted stream files are on disk only — the lead snapshots them to `wip/streams` at
  stops. Restore with `git cherry-pick --no-commit origin/wip/streams` on a clean tree, then relaunch each stream with
  its progress note + the briefing.
- **Dev environment:** `.env` from `.env.example` with generated `SESSION_SECRET` / `KEY_ENCRYPTION_KEYS` (never commit);
  `dockerd` + `docker compose -f infra/compose.yaml up -d --wait`; `pnpm db:roles && pnpm db:migrate && pnpm db:roles &&
  pnpm db:seed && pnpm db:seed:e2e`. Migrations 001–036 applied (033 unused); V5 owns 037 (WID), 038 (AIW), 039 (MKT, optional); next free **040**. Web = production
  build on :3000 (`next start`), worker = `apps/worker/dist/main.mjs`; rebuild/restart/Playwright only under
  `flock -o .data/devserver-v2.lock …`, servers started with `3>&- 9>&-`.
- **Open user decisions:** Inbox in the phone bottom bar for inbox users (lead recommends replacing Planner for them);
  main nav grouping (proposal in `docs/v3-5-progress/final.md`) — decide in the copy-cleanup pass; V3.1 Admin G-A1 / G-A5;
  marketing palette (V5 mockup is purple; app brand is orange) — record in DECISIONS when V5 starts.
- **Activation items collected so far** (final consolidated list after Docs + Help Centre): see
  `docs/v3-5/FINAL_ACTIVATION_CHECKLIST.md` (V3.5) — plus V4/V5: Stripe live keys + products/prices for Standard and
  Professional + webhook endpoint, final allowances and grace policy, support staff assignments, email sender, billing/
  customer policy text.
- **Known gaps carried forward:** `docs/V2_IMPLEMENTATION_GAPS.md`, `docs/V3_IMPLEMENTATION_GAPS.md`,
  `docs/V3_1_IMPLEMENTATION_GAPS.md`, `docs/admin/IMPLEMENTATION_GAPS.md`, `docs/collaboration/IMPLEMENTATION_GAPS.md`,
  `docs/v3-5/IMPLEMENTATION_GAPS.md`.

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
