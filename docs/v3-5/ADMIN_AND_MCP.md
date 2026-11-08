# V3.5 admin and MCP — operational runbooks

Stream F (2026-11-08). Brief §20. All admin pages read stored state (no provider calls) and show counts, states, ages
and safe error codes only.

## Admin → Inbox, listening and AI (workspace)

| Page | Route / API | Source service (owning stream) | Shows |
|---|---|---|---|
| Overview | `/admin/care` · `GET /api/admin/care` | `careAdminSummary` = each stream's own overview below + V3.5 audit counts | backlog, failed replies, SLA breaches, channels needing attention, sync problems + lag, listening sources, AI budget, automation problems, security events (24 h) |
| Inbox health | `/admin/inbox` · `GET /api/admin/inbox` | `inboxAdminOverview` (foundation) | waiting for a reply, unconfirmed/failed replies, SLA breaches + at risk, channels + permission state, inbound event queues, integration jobs |
| Integrations and sync | `/admin/integrations` · `GET /api/admin/integrations` | `integrationsAdminOverview` → `integrationHealth` per installation (foundation/C) | sync lag (oldest waiting write), waiting/running/failed/not-confirmed jobs, webhook events, last success, last error code; Slack deliveries; translation characters + estimated cost |
| Listening coverage | `/admin/listening` · `GET /api/listening/admin` | `listeningAdminOverview` (D) | sources + state, mentions, removed at source, ingestion cursor, re-match/re-process/backfill backlog, failures, alerts |
| AI and automation | `/admin/ai` · `GET /api/automation/admin` | `aiAutomationAdminOverview` (E) | AI set up?, monthly budget meter, runs by status, tokens + cost estimate (30 d), median latency, approved knowledge; emergency stop, policies, rules, runs by outcome, automatic replies, expiring policies |
| Audit | `/admin/security/audit?category=care` | activity centre (V3.1) with the new **Inbox and AI** category (`inbox.*`, `case.*`, `listening.*`, `ai.*`, `automation.*`; `mcp.*` is under Security) | every V3.5 domain action, CSV export for `audit.read` |

Permissions: `diagnostics.read` (owner/admin) for all pages except Listening coverage (`workspace.read`). Settings pages
(Inbox channels, Service levels, Listening sources) are linked from the same nav group.

## Admin → Platform → Inbox and AI pipeline

`/admin/platform/care` · `GET /api/platform/care` (support+). Installation-wide aggregates only: replies sent/failed/
unconfirmed/queued + oldest age, channels receiving/needing attention, SLA breaches, integration events waiting/dead, Meta
webhooks and channel updates waiting, sync jobs + oldest age, installations to reconnect, mentions + ingest failures,
listening alerts, AI runs + tokens, workspaces blocked by the AI budget, automation runs, active policies, emergency stops.
No workspace names, people or text.

## Runbooks

**Replies "not confirmed" grow.** Inbox health → Replies not confirmed. The worker reconciles Unknown sends by provider
lookup every minute (never resends). Remaining ones need a person: open the conversation → "Sent / Not sent". If many,
check the network's status and Integrations and sync → channel errors.

**Sync lag grows on an installation.** Integrations and sync → the row's last error code. `rate_limited` ⇒ waits for the
provider's reset (shown in the hub); `reconnect_required` ⇒ hub → Reconnect; `requester_lost_access` ⇒ the person who
asked for the write lost access — nothing was sent; re-request it as someone with access. Pausing an installation stops
its jobs; jobs resume on Resume.

**Webhook events "gave up".** Integration events that failed 8 times are dead-lettered. Fix the cause (usually a handler
error after a provider payload change), then retry from Admin → Operations → Queues and workers.

**Listening source needs attention.** Listening coverage → Sources. A connected source turns "Needs attention" when one of
its inbox channels stops receiving; fix the channel (Inbox channels). Broad sources stay "Awaiting activation" until a
licensed provider is added (activation checklist §3).

**AI budget used up.** AI and automation → Budget. Runs are refused with a clear message; AI automatic replies escalate
to a person. Raise `limits.ai_monthly_tokens` (Usage and limits) or wait for the next period.

**Automation misbehaves.** Automation → Emergency stop (workspace-wide; cancels queued automated replies at dispatch).
History shows each run's conditions and action results.

**Telegram bot removal.** Removing a Telegram channel releases Relay's webhook only if it is still Relay's; the audit row
records `telegram_webhook: released | not_relay | failed`. On `failed` (Telegram unreachable) run Check later from a new
channel or delete the webhook in BotFather/Bot API; Relay's receiver already rejects updates for the removed channel.

## MCP tools (V3.5)

Same domain services, scopes, idempotency and audit as the app (`packages/services/src/mcp/tools-v35.ts`;
contract `packages/core/src/contracts/mcp.ts`).

| Tool | Scope | Service | Notes |
|---|---|---|---|
| `list_conversations` | inbox.read | `listConversations` | queue/brand/channel/search; bounded page + cursor |
| `get_conversation` | inbox.read | `getConversation` | messages, reply attempts with the actual provider result, events, open reply modes, version; **no internal notes**, no presence |
| `draft_reply` | inbox.draft | `saveDraft` | the caller's own draft; `sent: false` always; the person sends in Relay (send-once path) |
| `assign_conversation` | inbox.assign | `assignConversation` | assignee must have inbox access to the brand |
| `list_cases`, `get_case` | inbox.read | `listCases`, `getCase` | |
| `create_case` | cases.manage | `createCase` | one case per conversation; idempotent |
| `update_case` | cases.manage | `updateCase` | expected version; resolve needs a reason |
| `list_listening_searches` | listening.read | `listSearches` | |
| `query_listening` | listening.read | `searchMentions` / `searchTimeline` / `searchSentiment` / `searchTopics` / `searchSummary` | every answer carries its coverage; live and simulated never mixed |
| `list_listening_alerts`, `get_listening_alert` | listening.read | `listAlerts`, `getAlert` | evidence = exact observations |
| `prepare_with_ai` | ai.prepare (+ inbox.read or listening.read) | `createRun` | queued; `not_configured` when AI is not set up; budget errors pass through |
| `get_ai_result` | ai.prepare | `getRun` | proposed actions listed, applied only in Relay |

`list_workspaces` accepts any granted scope so an inbox-only client can discover its workspace. Mutations need a user
sign-in (OAuth); API keys can read.
