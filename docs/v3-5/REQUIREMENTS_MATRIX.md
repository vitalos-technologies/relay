# V3.5 requirements and implementation matrix (final)

Brief: `docs/queue/03f_V3_5_PROMPT.md`. Stream F, 2026-11-08. Status vocabulary (brief §23 "Final reporting"):

- **Local** = implemented and locally tested (simulated transports, signed fixtures, real Postgres, production build).
- **Live** = verified against a live provider — **none yet**.
- **Awaiting review** = awaiting credentials or provider review · **Awaiting licence** = awaiting licensed data access ·
  **Unsupported** = not offered by the provider · **Not implemented** = see `IMPLEMENTATION_GAPS.md`.

Test files: integration `tests/integration/v35-{connectors,inbox,inbox-more,integrations,listening,ai-automation,final}.test.ts`
(+ `mcp.test.ts`), unit `tests/unit/v35-*.test.ts` + `mcp.test.ts`, E2E `tests/e2e/{inbox,inbox-more,integrations,listening,ai-automation,admin}.spec.ts`.

| § | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 2 | Primary areas: Inbox, Integrations, Listening, Assistant (+ Automation), admin | Local | `app/(app)/{inbox,integrations,listening,assistant,automation}`, Admin → Inbox, listening and AI | E2E per area |
| 3 | Integration hub: connect/configure/diagnose/reconnect/disconnect, resources, mappings, history, pause, honest states | Local; Awaiting review (app registrations) | `integrations-v35/core/hub.ts`, `components/integrations-hub/**` | `v35-integrations`, `integrations.spec` |
| 3 | Sync contract: idempotent jobs, origin markers, echo drop, protected fields, external status never approves | Local | `connectors/jobs.ts` (F: Relay-written-field echo detection), `work/tasks.ts` | `v35-connectors`, `v35-integrations` (AT6) |
| 4 | Asana + monday.com tasks, two-way mapped fields, conflicts ⇒ review | Local; Awaiting review | `integrations-v35/work/**` | AT6 |
| 5 | HubSpot: one ticket per case, CRM context | Local; Awaiting review | `integrations-v35/hubspot/**` | AT5 |
| 6 | Google Business Profile: posts via schedule/approval; reviews in the inbox; Pub/Sub | Local; Awaiting review | C `gbp/**`, B `google-business/inbox*`, F `inbox/channels-gbp-notify.ts` | AT4, `v35-final` (Pub/Sub → poll) |
| 7 | Cloud Translation: originals kept, never auto-sent, usage + cost estimate, workspace switch | Local; Awaiting review (billing) | `integrations-v35/translate/**` | AT9 |
| 8 | Slack: alerts, approvals bound to revision, signed interactivity, actor mapping, quiet hours, history | Local; Awaiting review | `integrations-v35/slack/**` (F: listening alerts bound, simulated routing) | AT7, `v35-final` |
| 9 | Mailchimp: drafts only, no auto-subscribe, send separate | Local; Awaiting review | `integrations-v35/mailchimp/**` | AT8 |
| 10 | Unified inbox per network (capability matrix) | Local for FB Page, Instagram, WhatsApp, GBP reviews, YouTube, Bluesky, Telegram, Threads; Awaiting review for live; X/LinkedIn/TikTok Awaiting review (no adapter) | `providers/src/*/inbox*.ts`, `inbox-registry.ts` | `v35-inbox`, `v35-inbox-more` |
| 11 | Inbox experience: queues, saved views, composer, notes, mentions, realtime, attachments, moderation, templates | Local | `components/inbox/**`, `components/conversation/**` | `inbox.spec`, `inbox-more.spec` |
| 12 | Cases + service levels (business hours, pause, breaches, reports) | Local | `inbox/cases.ts`, `contracts/v35-sla.ts` | `v35-inbox` |
| 13 | Reliability: send-once, collision check, unknown outcomes reconciled, ordering, reply windows | Local | `inbox/replies.ts` | AT1, AT2, AT13 |
| 14 | Connected-source listening | Local | `listening/**` | `v35-listening`, `listening.spec` |
| 14 | Broader listening providers | Awaiting licence (interface + "Awaiting activation" states built) | `listening/sources.ts` | `v35-listening` |
| 15 | Honest metrics: coverage, gaps not zeros, sample sizes, uncertainty, spike alerts with evidence | Local | `listening/query.ts`, `spike.ts`, `alerts.ts` | AT10 |
| 16 | Relay AI assistant on every surface, authorized retrieval, evidence vs suggestion | Local (no AI output without a key: honest "not set up"); Awaiting credentials | `assistant/**`, `components/assistant/**` | AT11, AT12 |
| 17 | AI actions + automation boundaries (policies, budgets, emergency stop, escalation) | Local | `automation/**` | `v35-ai-automation` |
| 18 | Rules: triggers (incl. listening.alert, content.approved — F), conditions, actions, test preview, history, loop prevention | Local | `automation/{rules,engine,install}.ts`, `engine/notify.ts` bridge | `v35-ai-automation`, `v35-final` |
| 19 | Data model on existing tenancy/queues; provider vs customer identity, explicit merge history; workload isolation | Local | migrations 028–032, `DATA_MODEL_AND_EVENTS.md` | integration suites; `v35-inbox-more` (identity) |
| 20 | Admin wiring: connector health, sync lag, backlog, failed replies, SLA breaches, listening coverage, AI usage, automation runs, audit | Local | `admin/v35.ts`, `/admin/{care,inbox,integrations,listening,ai}`, audit category "Inbox and AI" | `v35-final`, `admin.spec` |
| 20 | Platform view without conversation access | Local | `/admin/platform/care` (counts only) | `v35-final` |
| 20 | Scoped permissions (inbox read/reply/assign, cases, listening, exports, AI, integrations) | Local | `core/authz.ts` | all suites |
| 20 | MCP: reads, draft replies, assignment, cases, listening queries, AI prep; same services + idempotency; no send/mass-notify | Local | `mcp/tools-v35.ts`, `contracts/mcp.ts` | `mcp.test` (unit), `v35-final`, `mcp` |
| 20 | Revocation across sessions, SSE, jobs, indexes, exports, AI retrieval | Local (F closed the queued-sync-job gap) | `SECURITY_AND_RETENTION.md` → Revocation | `v35-final`, AT12 |
| 20 | Retention + deletion documentation | Local (documented); configurable message retention Not implemented | `SECURITY_AND_RETENTION.md` | `v35-listening` (deletion propagation) |
| 21 | Design system, concise copy, settings in the left nav | Local | — | screenshots `evidence/v3-5/**` |
| 21 | Widths 320–1440, essential phone workflows | Local | — | mobile QA (`TEST_REPORT.md`), @mobile E2E |
| 21 | Performance budgets; pages from stored data; usable without AI/providers | Local | — | `TEST_REPORT.md` → Performance |
| 22 | Acceptance tests 1–15 | Local | — | `TEST_REPORT.md` → §22 table |
| 23 | Documentation set | Local | `docs/v3-5/*` | — |

## Documentation set (brief §23)

| Document | File |
|---|---|
| Requirements and implementation matrix | this file |
| Connector capability and permissions matrix | `CAPABILITY_MATRIX.md` (final status section), `SECURITY_AND_RETENTION.md` (permissions) |
| Inbox and customer-care guide | `INBOX_AND_CARE.md`, `INBOX_NETWORKS.md` |
| Integrations guide | `INTEGRATIONS.md` |
| Listening coverage and metric definitions | `LISTENING.md` |
| AI behaviour and automation guide | `AI_AND_AUTOMATION.md` |
| Data model and event flow | `DATA_MODEL_AND_EVENTS.md` |
| Security and retention | `SECURITY_AND_RETENTION.md` |
| Admin and operational runbooks; MCP | `ADMIN_AND_MCP.md` |
| Mobile and performance reports; test evidence | `TEST_REPORT.md`, `evidence/v3-5/**` |
| Implementation gaps | `IMPLEMENTATION_GAPS.md` |
| Final activation checklist | `FINAL_ACTIVATION_CHECKLIST.md` |
