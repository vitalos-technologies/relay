# V3.5 security, permissions and retention

Final version (stream F, 2026-11-08). Covers brief §20 ("scoped permissions", "platform operators do not automatically
gain access to private customer conversations", "enforce revocation across …", "document retention and deletion …").
Earlier contracts still apply: `requireAction`/`authorizeCtx`/brand checks on every route, job and MCP tool; tenant id
never taken from payloads; secrets envelope-encrypted; simulated data never mixed with live data.

## Permissions (reserved by the foundation, `packages/core/src/authz.ts`)

| Permission | Allows | Presets that hold it |
|---|---|---|
| `inbox.read` | Read conversations, messages, notes, cases (brand-scoped) | owner, admin, brand_manager, care_agent |
| `inbox.reply` | Draft + send replies (send-once path), labels/priority/status | owner, admin, brand_manager, care_agent |
| `inbox.assign` | Assign conversations | owner, admin, brand_manager, care_agent |
| `inbox.manage` | Channels (opt-in, Telegram claim/release, polling, templates), saved replies | owner, admin |
| `cases.manage` | Create/update cases, identity linking | owner, admin, brand_manager, care_agent |
| `integrations.read` / `integrations.manage` | Use / connect, configure, disconnect integrations | read: owner, admin, brand_manager, care_agent; manage: owner, admin |
| `listening.read` / `listening.manage` | Read results / definitions, rules, corrections, sources | read: owner, admin, brand_manager, editor, analyst; manage: owner, admin |
| `ai.use` | Assistant runs | owner, admin, brand_manager, editor, care_agent |
| `automation.manage` | Policies, rules, emergency stop (sensitive ⇒ MFA where the workspace requires it) | owner, admin |
| `diagnostics.read` (V1 action → `workspace.manage`) | Admin health pages (counts only) | owner, admin |
| `exports.create` | Exports (existing) | per V2 presets |

No new permission strings were added by streams B–F.

## Platform operators and the admin app

- **Workspace admin pages** (Admin → Inbox, listening and AI: Overview, Inbox health, Integrations and sync, Listening
  coverage, AI and automation) show **counts, states, ages and safe error codes only**. Message, mention, prompt and AI
  output text never appear in the admin app (asserted in `tests/integration/v35-final.test.ts`).
- **Platform view** (Admin → Platform → Inbox and AI pipeline, `/api/platform/care`) is installation-wide aggregates:
  no workspace names, no conversation content, no people. Platform operators reach a workspace's conversations only the
  same way as for posts: a time-boxed support-access grant approved inside the workspace (V3.1), which is audited.
- Integration **setup details** (missing setting names, redirect and webhook URLs) are returned only to the instance owner
  (setup.manage in the primary workspace in production) and platform operators; everyone else gets the state and
  "Ask your Relay admin to set up …" (redacted server-side, `setup.canSeeInstanceSetup`).

## MCP (stream F)

New scopes, never in the default challenge (`MCP_DEFAULT_SCOPES` stays `social.read drafts.write`):

| Scope | Permissions it can unlock | Tools |
|---|---|---|
| `inbox.read` | workspace.read, brands.read, inbox.read | list_conversations, get_conversation (internal notes excluded), list_cases, get_case |
| `inbox.draft` | inbox.read, inbox.reply | draft_reply — saves the caller's own draft; **never sends** |
| `inbox.assign` | inbox.read, inbox.assign | assign_conversation (only the new assignee is notified, as in the app) |
| `cases.manage` | inbox.read, cases.manage | create_case, update_case (version-checked) |
| `listening.read` | workspace.read, brands.read, listening.read | list_listening_searches, query_listening, list_listening_alerts, get_listening_alert |
| `ai.prepare` | ai.use only | prepare_with_ai, get_ai_result — retrieval still needs inbox.read / listening.read on the same client |

Effective authority per call = the person's current grants ∩ the client's scopes ∩ consented brands (reloaded on every
call). Every mutation takes an idempotency key (a retry returns the stored result; different arguments ⇒
`idempotency_conflict`), is rate-limited and is audited twice (`mcp_audit` ids/result/latency + the domain audit row in the
person's name). There is no send, notification, mass-mention or "apply AI action" tool. Customer text is returned as data
with an untrusted-content notice.

## Revocation (verified)

| Surface | How revocation takes effect | Evidence |
|---|---|---|
| Web sessions / API | Access (membership, grants, brand scope) reloaded on every request | V2 suites; `v35-inbox` AT12 |
| SSE (`/api/inbox/stream`, collab stream) | Session + membership + `inbox.read` re-checked every 15 s; `event: revoked` ends the stream | B route; collab tests |
| Queued replies | `dispatchReply` re-checks the sender's `inbox.reply` (automated: the policy guard) before the provider call | `v35-inbox` |
| Queued integration jobs | **New (F):** `runSyncJob` re-checks the requester (or the automation policy owner) for `integrations.read`; otherwise `requester_lost_access`, nothing sent | `v35-final` |
| Automation | Policy actor = owner's current access, reloaded per run; owner losing access stops the policy | `v35-ai-automation` |
| AI retrieval | Requester's current access reloaded at execution and after generation; revoked ⇒ `blocked`, nothing kept (AT12) | `v35-ai-automation` |
| Listening notifications / Slack | `listening.read` re-checked at delivery; Slack routes check the route creator's access at delivery; revoked Slack-linked members refused (AT7) | D, C suites |
| Search indexes | Inbox search, listening search and global search are SQL over the live tables with the caller's filters — no per-user index to go stale; provider deletions erase the listening index row in the same transaction (031 trigger) | D suite |
| Exports | Export jobs rebuild the requester's context at run time (`access_revoked` / forbidden) | V3 / V3.1 suites |
| MCP | Client revocation rejects the next request; membership revocation fails `callScope`; queued MCP jobs cancelled | `v35-final`, `mcp` |

## Webhook and inbound authenticity

All business webhooks enter through `/api/connectors/webhooks/:connector` with a per-connector verifier (Slack signing
secret, HubSpot v3, Asana handshake + HMAC, monday JWT, Mailchimp URL key or signature, WhatsApp X-Hub-Signature-256,
GBP Pub/Sub Google-signed OIDC). Unverified requests store nothing. Telegram updates authenticate with a per-channel
secret token. **Echo detection (F):** an inbound event is Relay's own echo only when a Relay-written provider field
(Asana `external`, the monday update Relay posts, Slack message metadata) carries `relay:<job id>` of a sync job Relay
really ran for that installation; markers quoted in customer or user free text are ordinary events. Two-way task sync
additionally compares the pushed-state hash (`pullTask`).

## Retention and deletion

| Data | Kept | Mechanism |
|---|---|---|
| Customer messages (body, revisions) | Workspace lifetime; erased immediately when deleted at the provider (body + revisions + listening observation, same transaction) | ingest + 031 trigger |
| Attachments | Metadata on the message; files are stored only when a person opens them; stored files deleted when the message is deleted at the provider | B worker (hourly) |
| Internal notes, reply attempts, cases, SLA events | Workspace lifetime (care_case_events append-only) | — |
| Raw inbound bodies: verified webhooks, Telegram updates | Body 7 days; Telegram rows 30 days | worker retention |
| Integration activity (provider logs, safe messages only) | 30 days | worker retention |
| Inbox events feed (content-free) | 90 days; presence 10 min | worker retention |
| Slack deliveries / translations | Workspace lifetime (translations are the cost record) | — |
| Listening observations / alerts | Follow the inbox message (deletion propagates); ingest failure log 30 days | 031 trigger + worker |
| AI run outputs (summaries, drafts) + the person's request text | 30 days; proposed actions expire after 7 days; prompts are not stored | E worker |
| Embeddings | None exist — Relay has no vector store; retrieval reads live rows with the requester's permissions | — |
| Drafts (`inbox_drafts`) | Until sent/cleared by their author | — |
| Audit (`audit_events`, `mcp_audit`) | Append-only; workspace lifetime | roles.sql |
| Workspace deletion | Cascades every V3.5 table (`ON DELETE CASCADE` on `workspace_id`) | 028–032 |
| Backups | Managed PostgreSQL PITR (RPO ≤ 1 h, `docs/OPERATIONS.md`). Erasure in production reaches backups when they age out of the PITR window; restored copies must be re-erased (run the provider-deletion reconciliation after a restore). | operator |

**Not implemented (gap):** a configurable per-workspace retention period for customer message text (e.g. "erase message
bodies after N days"). It needs a setting column (migration) and a product decision on defaults; until then, message text
is kept for the workspace's lifetime unless deleted at the provider. Recorded in `IMPLEMENTATION_GAPS.md`.
