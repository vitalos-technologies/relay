# V3.5 data model and event flow (foundation, migration 028)

Additive migration `packages/db/migrations/028_v35_foundation.sql` (applied to dev 2026-11-07, frozen). Grants: the generic
DML grants in `infra/postgres/roles.sql` cover every table; `care_case_events` is append-only for app/worker roles.
Rollback: drop the 028 tables and restore the two widened CHECK constraints (`scoped_role_grants.role`,
`workload_samples.workload_class`).

## Entities
| Area | Table | Notes |
|---|---|---|
| Integrations | `integration_connections` | One installation per (workspace, connector, external account, brand scope). Credentials → existing `credentials` vault (envelope-encrypted, AAD = workspace). `is_simulated` only with `mock_` ids (DB check). Status shown: disconnected > paused > status. |
| | `integration_resources` | Explicit selection (project/board/pipeline/location/channel/audience…); nothing is imported by default. |
| | `integration_field_mappings` | Synchronization contract per field: source of truth, direction, conflict, deletion, revocation. DB check: protected fields never `two_way`. Service: protected fields (approval/publish state, owner, assignee, consent, subscription, customer email/phone) only Relay → external. |
| | `external_links` | Relay object ↔ external record. Partial unique indexes: one live link per external record and one external record per (Relay object, external type) ⇒ repeated delivery can't create duplicates. Revocation marks links `unavailable`; unlink is reversible + audited. |
| | `integration_events` | Verified inbound webhooks only. `UNIQUE(connector, dedupe_key)`; `origin='relay_echo'` (origin marker) ⇒ recorded, never processed. Raw body kept 7 days. |
| | `integration_sync_jobs` | Durable outbound jobs. `UNIQUE(workspace_id, idempotency_key)`; leased; `waiting_retry` with backoff honouring Retry-After; `unknown` ⇒ reconcile by origin marker, never automatic re-run. |
| | `integration_activity` | Error/retry/rate-limit history (safe messages; 30 days). |
| | `integration_cursors` | Polling/reconciliation cursors per integration or inbox channel. |
| Inbox | `inbox_channels` | Explicit opt-in per connected account; status + missing permissions re-evaluated from the stored grant. |
| | `inbox_contacts` | Provider identities (per channel). |
| | `inbox_customers`, `inbox_identity_links` | Internal customers; links only by explicit/verified action, with unlink history. Never by name/handle. |
| | `inbox_conversations` | Per (channel, kind, thread key). `version` bumps on every message, send, edit or deletion (collision detection). `unanswered_since`, reply-window inputs, `private_reply_used`, `case_id`. |
| | `inbox_messages` (+ `inbox_message_revisions`) | `UNIQUE(channel_id, external_id)`; provider timestamps order the thread; edits keep prior text; provider deletions null the body (and revisions). `delivery_state` only from provider receipts. `conv_version` = version this message produced. |
| | `inbox_notes` | Internal notes — separate table; no outbound path reads it. |
| | `inbox_drafts` | Server copy of an agent's unsent reply (one per conversation per user; mode kept). |
| | `inbox_reply_attempts` | Send-once: idempotency key, exact body + SHA-256, base version, lease, provider result, `unknown` reconciliation, person settlement. Partial unique index: one queued/sending attempt per conversation. |
| | `inbox_events`, `inbox_presence`, `inbox_saved_replies`, `inbox_saved_views` | Content-free activity/realtime feed (90 days); informational presence (purged after 10 min); saved replies; personal views. |
| Care | `care_sla_policies` | Time zone, weekly hours (null = 24/7), holidays, targets, `count_automated`. One default per workspace/brand. |
| | `care_cases` (+ `care_case_events`) | Clock start, pause accumulation (business ms), due dates, breaches, escalation, reopen count, `version` (409 on stale). Events append-only. |

## Event flow
```
Provider webhook ──verify raw body──▶ webhook_receipts (Meta) / integration_events (connectors) ──outbox──▶ pg-boss
   Meta 'page' events: events queue → processWebhookReceipt → ingestProviderPayload(facebook_page) → inbox rows
   connectors: 'integration-sync' queue → processIntegrationEvent → registered handler (stream C)
Inbox write (tx): message/conversation/case rows + inbox_events + outbox 'inbox.message_received' → 'inbox-events' → hooks (D/E/C)
Agent send: requestReply (tx, locked conversation) → inbox_reply_attempts(queued) + outbox 'inbox.reply_requested'
   → 'inbox-reply' queue (customer_reply class) → dispatchReply: lease → re-check sender/channel/window/outside replies
   → provider → sent | failed | queued(retry) | unknown → reconcileUnknownReplies (findSent) → sent | person decides
Integration write: enqueueSyncJob (idempotency key) → outbox 'integration.sync_requested' → 'integration-sync' (bulk pool)
   → executor → succeeded (+ external_links) | waiting_retry | failed | unknown → reconcileSyncJobs
Recovery loops (worker, every 5–60 s): due replies/jobs, expired leases → unknown, SLA breaches, snoozes, channel health.
```

## Workload isolation
| Class | Pool | Deferred under publishing pressure | Default cap (process / workspace) |
|---|---|---|---|
| publishing | main | never | claim slots |
| customer_reply | main | never | 4 / 2 |
| inbox_ingest | main | never | 2 / 2 |
| integration_sync | bulk | yes | 2 / 1 |
| listening_ingest | bulk | yes | 1 / 1 |
| ai_assist | bulk | no | 2 / 1 |

## Retention (foundation)
| Data | Kept | Mechanism |
|---|---|---|
| Raw verified webhook bodies (`integration_events.body`, `webhook_receipts.body`) | 7 days | worker retention |
| Integration activity | 30 days | worker retention |
| Inbox events (content-free) | 90 days | worker retention |
| Presence | 10 minutes | sweep |
| Messages deleted at the provider | body + revisions erased on the deletion event | ingest |
| Messages, notes, attempts, cases | workspace lifetime (policy-based purge = stream F) | — |
