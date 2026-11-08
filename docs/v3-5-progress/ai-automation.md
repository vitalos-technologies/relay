# V3.5 stream E — Relay AI assistant + rules/automation (resume point)

Brief: `docs/queue/03f_V3_5_PROMPT.md` §16–18 (+ §22 AT11–15 in scope). Contract: "E" row of `docs/V3_5_WORKSTREAMS.md`.
Migration: `packages/db/migrations/032_v35_ai_automation.sql`. Guide: `docs/v3-5/AI_AND_AUTOMATION.md`.
Evidence: `evidence/v3-5/ai-automation/`.

## Decisions
- **Provider:** reuses the existing AI setup (Setup → `ANTHROPIC_API_KEY`, `AI_MODEL`, the shared monthly `ai.tokens` meter +
  `ai_usage` ledger). The assistant has **no fixture mode**: without a key it reports "AI is not set up" and refuses runs
  (no row, no output). Tests inject a deterministic fake with `setAssistantModelClient` (tests only).
- **Runs are queued** (`ai.run_requested` → `ai-assist` queue, `ai_assist` class, bulk pool) and polled; pages never wait.
- **Requester's CURRENT access** is re-loaded at execution (membership, grants, brand scope) and again after generation;
  revoked ⇒ `blocked`, nothing retrieved/kept (AT12).
- **Retrieval** per context with that context's own permission (inbox.read / content.read / analytics.read /
  listening via D's services). Knowledge = items a brand manager approved for ONE brand (`ai_knowledge_sources`,
  `brands.manage`), read live from the Content Hub snapshot / saved reply — no shared knowledge store. Internal notes are
  never sent to the model.
- **Injection resistance (AT11):** system prompt is the only authority; sources are quoted DATA with trust labels and our
  delimiters neutralised; no tools; proposed actions are a fixed allow-list per task, built by Relay from Relay's own
  context ids; deterministic output checks (links must come from trusted sources; numbers grounded; commitments/policy
  need a current approved source; evidence quotes verified verbatim).
- **Evidence vs suggestion** are separate fields and separate UI blocks ("Suggestions · generated, review before use").
- **Automation** runs only under an ACTIVE policy (brands + channels, allowed actions, approved knowledge, reply
  categories, actions/hour, replies/day, monthly token budget, escalation, expiry ≤ 1 year, review date) with per-policy and
  workspace-wide emergency stop. Activating makes you the owner; the **service actor** = owner's current access narrowed
  to the policy brands (owner loses access ⇒ policy stops). Editing an active policy pauses it.
- **Classification before routing/replies:** deterministic classifier (no model) per inbound message → `ai_classifications`
  (signals only, never text). Refund/complaint/sensitive always escalate; uncertain, instruction-like, negative or
  keyword-matched messages never get automatic replies. Never authorised by model confidence.
- **Customer-facing sends** go through `requestReply` (automated flag) — a row in `automation_sends` is written first and
  the reply dispatcher re-checks the policy for every automated attempt (`registerAutomatedReplyGuard`).
- **Loop prevention:** `withOrigin({kind:'automation'})` (AsyncLocalStorage) + `writeOutbox` stamps `payload.origin`;
  automation ignores automation-origin events; `UNIQUE(rule_id, event_key)` (one run per event); rule/hour + per-conversation
  cooldown + policy limits; connector origin markers for external echoes (C).
- **Integration actions** use `enqueueSyncJob` (idempotency key per rule/event/action) and are available only when a
  stream C executor is registered for the kind (`slack.post_message`, `asana.create_task`, `monday.create_item`,
  `mailchimp.create_campaign_draft`, `hubspot.create_ticket`) — otherwise shown as "Not available yet".

## Status (2026-11-08)
- Done: contracts (`v35-ai.ts`, `v35-automation.ts`); migration 032 **applied to dev (only 032, via MIGRATIONS_DIR) + db:roles —
  frozen**; services `assistant/**` + `automation/**` (+ `automation/admin.ts` counts-only overview for F at
  `GET /api/automation/admin`); worker wiring; API routes (`/api/assistant/**`, `/api/automation/**`); UI: assistant drawer in
  Composer, Inbox (composer toolbar + classification chip in the context panel), Planner, Analytics, Content library,
  Listening search detail; `/assistant` (Ask / History / Knowledge); `/automation` (Rules + builder with Test, Policies,
  History, Emergency stop); nav item. Web rebuilt + restarted on :3000 (under `devserver-v2.lock`).
- Tests: unit 16 (`tests/unit/v35-ai-automation.test.ts`); integration 15 (`tests/integration/v35-ai-automation.test.ts`,
  incl. worker paths via the registered consumer + sweeps); full unit 548/548; full integration 474/476 (the 2 failures were
  other streams mid-edit and pass on re-run); E2E `tests/e2e/ai-automation.spec.ts` **3 passed, 1 skipped** (desktop-only skip
  of the @mobile test) after the container restart — incl. live routing by the rebuilt worker (classified → labelled →
  History) and emergency stop/resume. Mobile QA 10 screens × 320–1440: 0 horizontal scroll (history action results now wrap).
- Demo data: `scripts/seed-ai-automation-demo.ts` (Demo Workspace, simulated page; ran once). Shots:
  `scripts/ai-automation-shots.mjs` → `evidence/v3-5/ai-automation/checkpoints/*` (1440, DPR 2, light + dark), 390 px shots,
  MOBILE_QA (320–1440).
- Not possible here: real AI output (no provider key ⇒ assistant screens show the honest "AI is not set up" state).

## Next
1. `listening.alert` trigger once D exposes an alert hook; `content.approved` needs a collaboration event bridge.
2. Integration actions light up when stream C registers executors for the kinds listed above in BOTH web and worker
   processes (the builder reads `syncExecutor(kind)` in the web process).
3. MCP tools for AI prep (stream F) can call `createRun`/`getRun` (same checks).

## Files
- new: `packages/core/src/contracts/v35-{ai,automation}.ts`; `packages/db/migrations/032_v35_ai_automation.sql`;
  `packages/services/src/assistant/{index,classify,classification,guard,client,prompt,retrieval,listening-source,runs,actions,knowledge}.ts`;
  `packages/services/src/automation/{index,origin,conditions,policies,actor,engine,rules,install,worker}.ts`;
  `apps/web/app/api/assistant/**`, `apps/web/app/api/automation/**`; `apps/web/app/(app)/{assistant,automation}/page.tsx`;
  `apps/web/components/assistant/{assistant-panel,assistant-app,run-view,classification-chip}.tsx`; `packages/services/src/automation/admin.ts`;
  `scripts/{seed-ai-automation-demo.ts,ai-automation-shots.mjs}`; `tests/e2e/ai-automation.spec.ts`; `apps/web/components/automation/{automation-app,rule-builder,policy-editor,labels}.tsx`;
  `tests/unit/v35-ai-automation.test.ts`, `tests/integration/v35-ai-automation.test.ts`; `docs/v3-5/AI_AND_AUTOMATION.md`; this file.
- edited (shared, small/additive):
  - `packages/core/src/contracts/v35-events.ts` — appended `ai.run_requested` (→ `ai-assist`).
  - `packages/services/src/outbox.ts` — stamps `payload.origin` from the automation origin context (loop prevention).
  - `packages/services/src/inbox/replies.ts` — `automated` set from the origin context on insert; dispatch-time guard hook
    `registerAutomatedReplyGuard` for automated attempts (no guard ⇒ refused).
  - `apps/worker/src/main.ts` — one `registerAiAutomationWorkers` call, BEFORE the inbox consumers (hooks registered first).
  - `apps/web/components/shell/app-shell.tsx` — "Assistant" nav item (ai.use or automation.manage; `/automation` under it).
  - `apps/web/components/inbox/thread.tsx` — Assistant button in the composer toolbar (fills the reply box; agent sends).
  - `apps/web/components/composer/composer.tsx`, `apps/web/app/(app)/planner/page.tsx`, `apps/web/app/(app)/library/page.tsx`,
    `apps/web/components/analytics/v3/analytics-shell.tsx`, `apps/web/components/listening/search-detail.tsx` (D) — one Assistant button each.
  - `apps/web/components/inbox/context-panel.tsx` — classification chip (one line).

## Activation checklist items
- AI provider key (Setup → Anthropic API key) — without it the assistant and AI replies stay off (classification, routing
  and saved-reply automation work without AI).
- Set the workspace AI monthly token cap (`limits.ai_monthly_tokens`) and per-policy token budgets before enabling AI replies.
- Approve knowledge per brand (Assistant → Knowledge) with review dates before any AI answer about policy/prices/refunds.
- Integration automation actions need stream C executors + connected integrations (Slack/Asana/monday/Mailchimp/HubSpot).
