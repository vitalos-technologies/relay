# V3.5 workstreams — contracts and ownership

Brief: `docs/queue/03f_V3_5_PROMPT.md` (read all of it). The foundation stream (§23 steps 1–3) is done: capability matrix,
shared connector + event infrastructure, the Facebook Page inbox adapter and the customer-care workflow. Read first:
`docs/v3-5/CAPABILITY_MATRIX.md`, `docs/v3-5/DATA_MODEL_AND_EVENTS.md`, `docs/v3-5-progress/foundation.md`.

All earlier contracts still apply (`docs/V2_WORKSTREAMS.md`, `docs/V3_WORKSTREAMS.md`, `docs/V3_1_WORKSTREAMS.md`):
`requireAction`/`authorizeCtx`/brand checks on every route, job and MCP tool; `v2Ctx` tests; audit; no tenant id from
payloads; no provider calls in page requests; outbox → pg-boss with deterministic ids; secrets envelope-encrypted; simulated
data never mixed into live data; real connections never fall back to mock; missing credentials never become success.

## Rules for every V3.5 stream
- **Use the shared services, don't fork them.** Connectors: `packages/services/src/connectors/*` (contract
  `packages/core/src/contracts/v35-connectors.ts`). Inbox + cases: `packages/services/src/inbox/*` (contract
  `v35-inbox.ts`, SLA maths `v35-sla.ts`). Events/queues/workload classes: `v35-events.ts`.
- **Permissions are reserved** (core/authz.ts, done): `inbox.read|reply|assign|manage`, `cases.manage`,
  `integrations.read|manage`, `listening.read|manage`, `ai.use`, `automation.manage` + preset `care_agent`. Do not add new
  permission strings without the lead; if you must, put them in your migration notes and ask.
- **Customer-facing sends** go through `requestReply` (send-once, collision check, reply rules) — automation and AI included
  (service actor), never a direct provider call.
- **Business writes** go through `enqueueSyncJob` (idempotency key = one external record per logical request) with an
  executor registered via `registerSyncExecutor`; webhooks through `/api/connectors/webhooks/:connector` with a verifier
  (`registerVerifier`) and handler (`registerInboundHandler`). Every external record carries the origin marker
  (`relay:<job id>`) so echoes are dropped. Protected fields (`PROTECTED_RELAY_FIELDS`) never sync two-way and external
  status never approves/publishes.
- **Workload isolation:** customer replies (`customer_reply`) and publishing keep main-pool capacity; integration sync,
  listening and AI run on the bulk pool (`integration_sync`, `listening_ingest`, `ai_assist`). New queues: add to
  `QUEUE_CLASS` (workload/policy.ts) and consume in your own worker module registered from
  `packages/services/src/inbox/worker.ts` style — one call in `apps/worker/src/main.ts`.
- **Migrations:** one file per stream (below), additive. Apply to dev when stable (`pnpm db:migrate`, then `pnpm db:roles`),
  then treat as frozen; follow-ups go in a new file the lead allocates. 028 is applied and frozen.
- **Shared files** (re-read before editing; small additive diffs; note them in your progress file):
  `apps/worker/src/main.ts`, `packages/services/src/outbox.ts`, `engine/outbox-dispatcher.ts`, `workload/policy.ts`,
  `packages/core/src/contracts/v31-perf.ts`, `packages/core/src/authz.ts`, `packages/services/src/settings.ts` (setting keys),
  `packages/providers/src/transport/http.ts` (allow-listed hosts), `packages/providers/src/inbox-registry.ts`,
  `apps/web/components/shell/app-shell.tsx` (nav), `apps/web/components/settings-shell/registry.tsx`,
  `apps/web/components/admin/nav.tsx`, `infra/postgres/roles.sql`, `packages/services/src/webhooks.ts`.
  `packages/core/src/contracts/v35-events.ts`: add event names only (append to the arrays).
- **UI:** Relay design system, concise copy, settings in the left settings nav, no page-level horizontal scroll at
  320–768 px. Reuse `apps/web/components/conversation/*` (generic timeline + composer; no inbox types) — V4 support tickets
  will reuse them too, so keep them generic.
- **Git:** no commits/stash/checkout; the lead commits. No new dependencies without a reason in your report.
- **Honesty:** no invented connections, messages, listening results, AI outputs or receipts. Simulated rows are flagged
  (`is_simulated`) and labelled. Record blockers for the final activation checklist.
- **Progress note:** `docs/v3-5-progress/<stream>.md` (decisions, status, done, next, files new vs edited-shared).
  Checkpoints `evidence/v3-5/<stream>/checkpoints/<n>-<area>-<theme>.png` (1440, DSF 2, light + dark).

## Streams

| Stream | Migration | Owns (brief §) | Must use | Owned files/dirs |
|---|---|---|---|---|
| **FOUNDATION** (done) | `028_v35_foundation.sql` | §23.1–3: capability matrix, connector/event infra, Facebook Page inbox adapter, cases + SLAs, inbox UI | — | `packages/services/src/{connectors,inbox}/**`, `packages/providers/src/meta/inbox*.ts`, `packages/providers/src/inbox-registry.ts`, `packages/core/src/contracts/v35-*.ts`, `apps/web/components/{inbox,conversation}/**`, `apps/web/app/(app)/inbox`, `apps/web/app/api/{inbox,connectors,admin/inbox}/**`, `apps/web/app/(admin)/admin/inbox` |
| **B** Remaining inbox capabilities | `029_v35_inbox_more.sql` | §10–13 for every other network: Instagram DMs/comments, Telegram bot chats (explicit webhook-ownership plan: only when no webhook/polling consumer exists, owner confirms, then `setWebhook` to Relay; never overwrite), WhatsApp (templates, 24 h window, charges shown), Google reviews as inbox items (+ owner reply update/delete — not the customer's review), YouTube comments, Bluesky, Threads, X/LinkedIn/TikTok where access exists (otherwise "needs approval" in UI). Also: moderation (hide/delete own reply), attachments (metadata + safe fetch), saved views UI, identity linking UI (explicit link/unlink + history), CSAT where supported, inbox realtime (SSE like collab), mention autocomplete in notes, polling reconciliation cursors (`integration_cursors.channel_id`). | `InboxAdapter` + `getInboxAdapter`, `ingestItems`, `requestReply`, `integration_cursors`, verifiers (`whatsapp`) | `packages/providers/src/<network>/inbox*.ts`, `packages/services/src/inbox/channels-<network>.ts`, `apps/web/components/inbox/<feature>-*.tsx` (new files); edits to inbox core files only with a note |
| **C** Seven business integrations | `030_v35_integrations.sql` | §3–9: Asana, monday.com, HubSpot, Google Business Profile (posts via scheduling/approval; reviews via B's inbox), Cloud Translation (inbox/drafts/variants/listening; originals kept; usage + cost estimate; workspace control), Slack (alerts, approvals bound to revision, signed interactivity, actor mapping, quiet hours, delivery history), Mailchimp (drafts only by default; no auto-subscribe; send = separate privileged action). Integrations hub UI (connect/configure/diagnose/reconnect/disconnect, resources, mappings, history, pause). | `upsertIntegrationConnection`, `selectResources`, `setFieldMapping`, `enqueueSyncJob` + executors, `registerVerifier`/`registerInboundHandler`, `upsertExternalLink`, `recordActivity` | `packages/services/src/integrations-v35/<connector>/**` (new), `packages/providers/src/<connector>/**`, `apps/web/app/(app)/integrations/**`, `apps/web/components/integrations-hub/**`, `apps/web/app/api/connectors/<connector>/**` (OAuth callbacks) |
| **D** Listening | `031_v35_listening.sql` | §14–15: connected-source monitoring from inbox public data (DMs excluded), provider interface + coverage registry (licensed/approved sources marked "awaiting activation"), saved searches + Boolean, timelines, topics, sentiment with uncertainty + correction, spike alerts (min sample, baseline, cooldown, dedupe), share of voice within observed data, dashboards, create task/case/draft from insight, deletion propagation. | `listening_ingest` class + `listening-ingest` queue, `onInboxEvent('inbox.message_received')`, `createCase`, `enqueueSyncJob` | `packages/services/src/listening/**`, `packages/core/src/contracts/v35-listening.ts`, `apps/web/app/(app)/listening/**`, `apps/web/components/listening/**` |
| **E** Relay AI + rules/automation | `032_v35_ai_automation.sql` | §16–18: contextual assistant (composer, inbox, listening, analytics, planner, content hub), scoped retrieval preserving source permissions, evidence vs suggestion, prompt-injection resistance, AI runs + proposed actions (preview), bounded automation policies (brands/channels, actions, sources, categories, limits, escalation, expiry, emergency stop), rule builder (trigger/conditions/actions/scope/schedule/limits/test preview/history), loop prevention. Classification + routing before auto-replies. | existing `services/ai/*` (budgets/usage), `onInboxEvent`, `requestReply`/`assignConversation`/`updateConversation` with a service actor, `enqueueSyncJob`, `ai_assist` class | `packages/services/src/{assistant,automation}/**`, `packages/core/src/contracts/v35-{ai,automation}.ts`, `apps/web/components/{assistant,automation}/**`, `apps/web/app/(app)/automation/**` |
| **F** Admin + MCP + final verification | `033_v35_admin.sql` (only if needed) | §20–22: admin wiring for all modules (connector health, sync lag, backlog, failed replies, SLA breaches, listening coverage, AI usage, automation runs, audit), platform view without conversation access, MCP tools (reads, draft replies, assignment, cases, listening queries, AI prep — same services/idempotency), revocation across sessions/subscriptions/jobs/indexes/exports/AI retrieval, retention docs, mobile/perf/security verification, all §23 docs, final activation checklist. | `inboxAdminOverview`, `integrationHealth`, every stream's services | `apps/web/app/(admin)/admin/{inbox,integrations,listening,ai}/**` (extends foundation's page), `packages/services/src/mcp/tools-v35*.ts`, `docs/v3-5/*` (final versions), `scripts/v35-*.mjs` |

Order: B and C can start immediately in parallel; D after B has Instagram/Google reviews flowing (it can start on the
provider interface right away); E after C's Slack/Asana executors exist for automation actions (classification/routing can
start now); F last (admin pieces can be added by each stream to `/admin/inbox` with a note).

## Interfaces at a glance
```ts
// inbox (services/inbox)
ingestItems(kind, items: InboundItem[], { simulated })           // after webhook verification
requestReply(ctx, conversationId, { mode, body, base_version, idempotency_key, acknowledge_version? })
addNote(ctx, id, { body, mentions })      assignConversation(ctx, id, { assignee_id, team_id })
createCase / updateCase / sweepSla / careReport                  onInboxEvent(event, name, fn)
// connectors (services/connectors)
upsertIntegrationConnection(tx, args)   enqueueSyncJob(ctx, { integrationId, kind, relayType, relayId, payload, idempotencyKey? })
registerSyncExecutor({ kind, run, reconcile? })   registerVerifier(connector, fn)   registerInboundHandler({ connector, handle })
upsertExternalLink(tx, …)   setFieldMapping(ctx, id, mapping)   recordActivity(db, …)   integrationHealth(ctx, id)
```

## Open decisions for the lead
See `docs/v3-5-progress/foundation.md` → "Decisions needed".
