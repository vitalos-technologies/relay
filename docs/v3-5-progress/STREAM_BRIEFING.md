# V3.5 parallel streams — common briefing (lead)

Read in order: `docs/queue/03f_V3_5_PROMPT.md` (the user's full brief), `docs/V3_5_WORKSTREAMS.md` (contract: your scope,
migration number, owned files, shared-file rules, interfaces), `docs/v3-5/CAPABILITY_MATRIX.md`,
`docs/v3-5/DATA_MODEL_AND_EVENTS.md`, `docs/v3-5/INBOX_AND_CARE.md`, `docs/v3-5-progress/foundation.md`, `HANDOFF.md` (rules).

Lead decisions already taken: `care_agent` includes `integrations.read`; editors get `listening.read` + `ai.use`, analysts
`listening.read`. Mailchimp: URL-key mode is the baseline; signature mode only once its signed-string format is confirmed
from official docs.

## Running in parallel with other streams (B inbox, C integrations, D listening, E AI/automation)
- One shared dev host. The web app on :3000 is a production build. **Any rebuild/restart of web or worker, and any
  Playwright run, must hold the lock**: `flock /home/user/social-lite/.data/devserver.lock <command>` (it serialises with
  the other streams). Rebuild web: `pnpm --filter web build` then restart `next start --port 3000` (check no stale
  `next dev` holds :3000). Worker: `pnpm --filter worker build` and restart (see `.data/worker.pid`).
- Run only YOUR E2E spec(s) during development; stream F runs the full suite at the end. Integration tests use disposable
  per-run DBs, so they are safe in parallel.
- Migrations: only your allocated file. Apply to dev (`pnpm db:migrate` then `pnpm db:roles`) under the lock, then frozen.
- Shared files: re-read immediately before editing, keep diffs small and additive, list them in your progress note.
  Another stream may have edited them since you last looked.
- No git state changes. The lead commits each stream when it reports.

## Always
Do not print/commit/send secrets; never ask for credentials; missing credentials never become success; real connections never
fall back to mock; no invented connections/messages/listening results/AI outputs/receipts; no paid services, no real customer
messages, no live publishing; only this project's resources; don't describe simulated behaviour as implemented; no model
names in code or docs. Check current official provider docs before relying on an API detail.

## Deliver
Progress note `docs/v3-5-progress/<stream>.md` (resume point). Checkpoints `evidence/v3-5/<stream>/checkpoints/` (1440,
DSF 2, light + dark) as screens land, plus 390 px shots of your key screens. Tests (unit, integration, your E2E, mobile at
320/360/390/430/768). Your section of the docs in `docs/v3-5/`. Activation items for the final checklist in your progress
note. Final report (compact): built, tests with numbers, acceptance tests covered (brief §22), best 4–6 screenshots, edited
shared files, blockers/decisions.
