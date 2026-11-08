# V3.5 stream D — Listening — progress (resume point)

Brief §14–15 (+ §22 AT10, AT12, AT13, AT15 in this area). Contract row "D" of `docs/V3_5_WORKSTREAMS.md`.
Migration: `031_v35_listening.sql` — **applied to dev 2026-11-08 (alone, via a one-file migrate; 029/030/032 untouched), frozen**,
`pnpm db:roles` re-run. Follow-ups need a new migration number from the lead.
Behaviour + metric definitions: `docs/v3-5/LISTENING.md`. Evidence: `evidence/v3-5/listening/`.

## Decisions
- **Connected-source monitoring = inbox public items.** Any network whose inbox capability has a public type is a connected
  source (derived from `CHANNEL_CAPABILITIES`), so stream B's networks flow in without listening changes. DMs never reach
  listening (DB CHECK + ingest filter + tests).
- **Two ingest paths**: `onInboxEvent('inbox.message_received')` hook → outbox `listening.ingest_requested` → `listening-ingest`
  (bulk pool) — plus a cursor sweep over `inbox_messages` (≥ 1 min old) that catches anything missed, whatever the network's
  event path.
- **Deletion propagation by trigger** on `inbox_messages` (031): provider deletions / retention erasure / edits update the
  observation in the same transaction (search index + matches + counts). Edits re-classify/re-match in the worker.
- **Broad listening**: `ListeningProvider` interface + registry; no provider implemented/activated → every broad source is
  "Awaiting activation" with its requirements. Nothing is scraped or faked.
- **Sentiment/topics: transparent lexicon baseline** (`lexicon_v1`), not AI: Relay's AI service only exposes post-copy
  suggestions today. Sentiment carries confidence, the words that produced it, "uncertain" < 50 %, English only (others
  "Not scored"); managers correct (audited; edits clear it).
- **Honest metrics**: every response has a `ListeningCoverage` (sources, monitoring start, incomplete channels, retrieval time,
  query version, sample/denominators, state matches / no_matches / incomplete / not_collected). Periods before monitoring
  are gaps, never zeros. Live and simulated data are never mixed (dataset per request; simulated banner).
- **Spike alerts**: epoch-aligned windows, baseline only over monitored windows, min sample, ×multiplier AND mean+3σ,
  min baseline windows, unique dedupe key per rule+dataset+window, cooldown; evidence = exact observations; coverage
  snapshot. Notifications use the *Account health* preference (no new notification event type) and re-check
  `listening.read` at delivery.
- **Permissions**: reads `listening.read` (owner/admin/brand_manager/editor/analyst per lead decision); definitions, rules,
  corrections, exclusions, source settings `listening.manage` (owner/admin). No new permission strings.
- **Insight → task/case/draft** through the normal services (collab tasks, `createCase`, `createPost`) with the caller's own
  permissions; idempotent; only a link is copied (no customer text).
- New outbox events (appended): `listening.ingest_requested`, `listening.rematch_requested` (→ `listening-ingest`),
  `listening.alert_fired` (→ `inbox-events`, so C/E subscribe with `onInboxEvent`).

## Status
- Done: contract, migration 031 (applied), services (`classify`, `spike`, `sources`, `ingest`, `searches`, `query`, `alerts`,
  `actions`, `dashboards`, `admin`, `worker`), 21 API routes, UI (`/listening`, search detail, alert detail, mention detail,
  compare, dashboards; Settings → Listening → Sources; nav item), worker wiring; web + worker rebuilt and started after the container restart (2026-11-08 03:14 UTC, `flock -o …devserver-v2.lock`, `3>&- 9>&-`),
  demo seed script, unit + integration tests, E2E spec, docs.
- Demo data: `scripts/seed-listening-demo.ts` (Demo Workspace, simulated Facebook Page; 84 observations, one fired alert,
  3 searches, 1 dashboard). Stream B's simulated Instagram/Telegram/Google reviews channels flow in automatically.
- Lead review fixes done: short sentence-case source lines, "Not connected" + Connect link, inline coverage icon, saved
  searches card sized to content, "Neutral · unsure" chip.

## Verification (2026-11-08)
- Root + web typecheck clean for listening files; ESLint clean on listening web files.
- Unit `pnpm test` 559/559 (listening 7). Integration listening 10/10 (+ v35-inbox 8/8 alongside the 031 trigger).
- E2E `tests/e2e/listening.spec.ts`: desktop 2 passed, mobile 1 passed (desktop skips the @mobile test).
- Mobile QA: 10 screens × 7 widths (320–1440) — 0 page-level horizontal scroll (after a grid fix).
- Load: 20k mentions in one search — timeline/sentiment/topics/mentions 40–300 ms (`evidence/v3-5/listening/verification.json`).
- Screens: `evidence/v3-5/listening/checkpoints/*` (1440, DPR 2, light + dark), `evidence/v3-5/listening/*-390-*.png`.

## Next / open
- Stream F: admin screen for `listeningAdminOverview` (`GET /api/listening/admin`), MCP listening query tools (use
  `searchMentions/searchTimeline/listAlerts` — same checks).
- **Alert hook for C (Slack) and E (automation `listening.alert` trigger) — chosen: outbox event, no separate registry.**
  Every fired alert writes ONE outbox row `listening.alert_fired` (appended to `v35-events.ts`), routed to the `inbox-events`
  queue, so subscribers bind with `onInboxEvent('listening.alert_fired', '<name>', fn)`. Event: `workspaceId`,
  `aggregateId` = `listening_alerts.id`, `payload` = `{ ruleId, searchId, brandId, simulated, origin: { kind: 'system' } }`
  (ids only; load the alert with `getAlert(ctx, id)` for evidence + coverage; respect `simulated`).
- Stream E: "summarise listening results with evidence" can read `searchSummary` (deterministic, source-linked).

## Activation checklist items (listening)
1. Live connected-source data needs the inbox channels to be live: Meta App Review (`pages_read_user_content`,
   `pages_manage_engagement`) for Facebook Page comments; other networks per `docs/v3-5/CAPABILITY_MATRIX.md`.
2. Broader listening (each needs a provider adapter + credentials/licence; re-verify docs before building): X API
   pay-per-use credits + owner budget approval; YouTube Data API key (search = 100 quota units); Bluesky app password;
   Reddit Data API commercial agreement; a licensed news/web/forums provider contract.
3. Optional: AI sentiment/topic classification (budget-gated) once the AI service exposes a classification task.

## Files
- new: `packages/db/migrations/031_v35_listening.sql`; `packages/core/src/contracts/v35-listening.ts`;
  `packages/services/src/listening/{index,shared,classify,spike,sources,ingest,searches,query,alerts,actions,dashboards,admin,worker}.ts`;
  `apps/web/app/api/listening/**` (21 routes); `apps/web/app/(app)/listening/**`; `apps/web/components/listening/**`;
  `scripts/{seed-listening-demo.ts,listening-shots.mjs}`; `tests/unit/v35-listening.test.ts`; `tests/integration/v35-listening.test.ts`;
  `tests/e2e/listening.spec.ts`; `docs/v3-5/LISTENING.md`; this file.
- edited (shared, small/additive): `packages/core/src/contracts/v35-events.ts` (3 event names + queue routes appended),
  `apps/worker/src/main.ts` (one `registerListeningWorkers` call before the inbox consumers + timers),
  `apps/web/components/shell/app-shell.tsx` (Listening nav item), `apps/web/components/settings-shell/registry.tsx`
  (Listening → Sources group). No edits to inbox/connectors code; the 031 trigger is attached to `inbox_messages` (DB only).
