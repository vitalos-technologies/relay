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
7. **V3.5** (`docs/queue/03f_V3_5_PROMPT.md`) — foundation **done** (102498a; migration 028; `docs/V3_5_WORKSTREAMS.md`, `docs/v3-5/*`). **Running in parallel:** B inbox-more (029), C integrations (030), D listening (031), E AI + automation (032, **done** — awaiting joint commit; lead notes `docs/v3-5-progress/lead-notes.md`); common rules `docs/v3-5-progress/STREAM_BRIEFING.md` (dev-server lock: `flock .data/devserver.lock`); progress `docs/v3-5-progress/{inbox-more,integrations,listening,ai-automation}.md`. Then F (admin + MCP + full verification, 033). Lead decisions: care_agent gets integrations.read; editors listening.read + ai.use; analysts listening.read. Open for user: Inbox in phone bottom bar? Activation: Meta App Review (pages_messaging, pages_manage_engagement, pages_read_user_content) + Human Agent, then META_REQUEST_INBOX / META_HUMAN_AGENT_APPROVED; Meta webhook fields messages, message_echoes, message_edits, message_deliveries, message_reads, feed → 7b. **V4** commercial + customer support (`docs/queue/03g_V4_PROMPT.md`: Relay support tickets, Platform → Support, plans/trials/subscriptions/billing via Stripe test mode behind a billing service, entitlements, tenant lifecycle; no Stripe keys in this environment → build against a provider interface with a test double + locally signed webhook fixtures; never request keys in chat) → 8. Copy cleanup (03e) → 9. Docs + Help Centre (04) → 10. One consolidated activation checklist + user reminder.

## Current state (keep updated)
- **V3.1 Admin: done and committed.** `/admin` app (Workspace ↔ Platform scope), platform operators (migration 026, applied to dev, frozen; next migration is **027**), support access (owner-approved, time-boxed, step-up), suspension gate in the engine, change-feed sync (10 s poll, ≤ 60 s backoff). Bootstrap an operator: `pnpm platform:operator` (dev seed makes owner@demo one).
  - Verified: tsc clean; unit 495/495; integration 400/401 (`v31-analytics-summary` timing flake under load, passes alone); **full E2E 51/51 on a production build** (covers lead fixes 89286a7); mobile 30 routes × 8 widths no overflow; perf within budget; secret scan clean.
  - Docs: `docs/admin/*` (12). Open decisions: G-A1 (Instance setup still owner-gated), G-A5 (optional pg-boss read grant for the web role). Left: large-dataset admin benchmark, screen-reader pass, real-device/RUM.
- **Dev environment:** all migrations 001–017, 019–022, 025, 026 applied. Web runs as a production build on :3000 (`next build --webpack` + `next start`); a stale `next dev` on :3000 makes `next start` fail — check the process. Worker rebuilt with the worker DB role. E2E uses its own seeded workspaces (`pnpm db:seed:e2e`).
- **Background agents** (a new session will NOT have them): V3.5 streams B, C, D, E (since 00:35 UTC Nov 8). Relaunch any missing one with: read `docs/v3-5-progress/STREAM_BRIEFING.md`, then your row in `docs/V3_5_WORKSTREAMS.md`, resume from your progress note.
- **Known gaps carried forward:** `docs/V2_IMPLEMENTATION_GAPS.md`, `docs/V3_IMPLEMENTATION_GAPS.md`, `docs/V3_1_IMPLEMENTATION_GAPS.md`, `docs/admin/IMPLEMENTATION_GAPS.md` (planner payload, Zod in browser bundles, flags gate UI only, storage orphans, no follower data, TikTok handoff download, lint).

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
