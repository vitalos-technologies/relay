# Inbox — remaining networks and care features (stream B)

What stream B adds on top of the foundation inbox (`INBOX_AND_CARE.md`). Every network below is built against the
provider's documented API and exercised on its **simulated transport** in dev/test; real channels use the live transport
(allow-listed hosts) and need the approvals listed. Nothing here has been verified against a live provider account.
Migration `029_v35_inbox_more.sql` (applied to dev 2026-11-08, frozen).

## Networks
| Network | Channel source | Conversations | Inbound | Reply rules | Moderation | Live prerequisites |
|---|---|---|---|---|---|---|
| Instagram | Instagram connection (Page-linked professional account, Page token) | DMs, comments | Webhook `object=instagram` (`/api/webhooks/meta`) | DM: 24 h (Human Agent 7 d with `META_HUMAN_AGENT_APPROVED`); comment: public reply, or ONE private reply ≤ 7 days; DM text ≤ 1,000 bytes | Hide/unhide comments; delete own reply | App Review `instagram_manage_messages`, `instagram_manage_comments`; MESSAGE task on the Page |
| WhatsApp | Business integration `whatsapp` (WABA + system-user token); one channel per phone number | Messages | Verified connector ingress `/api/connectors/webhooks/whatsapp` (X-Hub-Signature-256) | Free-form only within 24 h of the customer's last message; otherwise an approved template | — | WABA, Business verification, payment method, approved templates |
| Google Business Profile | GBP integration (stream C) + a selected location; one channel per location | Reviews | Polling `reviews.list` with a checkpoint (Pub/Sub path = stream C) | Public owner reply only (create/update via `updateReply`) | Delete the OWNER reply (never the review) | Business Profile API approval; verified locations |
| YouTube | YouTube connection | Comments | Polling `commentThreads.list` (5 min) | Public replies (`comments.insert`, 50 quota units) | Hold for review / publish; delete own reply | `youtube.force-ssl` |
| Bluesky | Bluesky connection (app password) | Replies, mentions, DMs | Polling notifications (1 min) + `chat.bsky.convo.getLog` | Public replies; DMs in existing chats | Delete own reply | App password with DM access for DMs |
| Telegram | Telegram connection → the bot | Private chats, group messages | Relay-owned per-channel webhook (see ownership plan) | Private chats: private; groups: reply in the group | Delete the bot's own messages (≤ 48 h) | Bot token; Relay must own the bot's update stream |
| Threads | Threads connection | Replies to own posts | Polling (10 most recent posts, 5 min) | Public replies (container + publish) | Hide/unhide replies | App Review `threads_read_replies`, `threads_manage_replies` |
| X, LinkedIn, TikTok | — | — | — | — | — | Shown as **needs provider approval** (paid API / Community Management API / API for Business). No adapter. |

## Telegram webhook ownership plan
A bot has exactly one update consumer: a webhook **or** `getUpdates` polling. Relay never calls `getUpdates`.
1. **Check** (`inbox.manage`): `getWebhookInfo`. A URL that isn't Relay's ⇒ *another app* — Relay never overwrites it
   (only the host is shown). Empty ⇒ *no webhook*, but another app may still poll (Telegram can't tell us).
2. **Claim**: only from "no webhook", only with the explicit confirmation "no other app reads this bot's updates",
   only within 10 minutes of a check, and Relay re-checks `getWebhookInfo` immediately before `setWebhook`. It sets
   `/api/inbox/telegram/:channelId` with a random secret token (stored encrypted) and verifies the result. Audited.
3. **Release**: `deleteWebhook` only if the webhook is still Relay's.
Until claimed, the channel shows *Not receiving yet*. Updates are verified by the secret header, persisted
(`inbox_inbound_events`, unique per update id) before the 200, then processed by the worker (`inbox.inbound_received`).

## WhatsApp charges
Shown before sending, re-checked by the server: free-form replies inside the window are free; utility templates inside
an open window are free; other templates are charged by Meta per delivered message (category + recipient country). An
optional operator rate card per channel turns this into an estimate. A charged send needs `acknowledge_charge`. The
actual pricing Meta reports per message (status webhook `pricing`) is stored on the message and shown. Failures after
acceptance (`status=failed`) are shown on the message. A send whose response was lost is confirmed only by the status
webhook carrying `relay-attempt:<attempt id>` in `biz_opaque_callback_data` (WhatsApp has no lookup API).

## Reliability notes per network
- Unknown outcomes are reconciled through provider lookups (Instagram conversations/replies, YouTube `comments.list`,
  Bluesky `listRecords`/`getMessages`, Threads `conversation`, GBP `reviews.get`). Telegram and WhatsApp have no lookup:
  Telegram leaves it to a person; WhatsApp waits for the status webhook. Nothing is resent automatically.
- Polling cursors live in `integration_cursors` (`channel_id`, scope `inbox:poll`); the cursor advances only after the
  page is ingested; failures back off (Retry-After honoured, max 1 h); reconnect-type failures mark the channel.
- Polling ingests only into the polled channel (no cross-workspace fan-out).

## Care features
- **Moderation** — only actions the network permits on that message (`moderationActions`); synchronous, idempotent,
  recorded in `inbox_moderation_actions` with the real outcome, audited. Needs `inbox.reply`.
- **Attachments** — metadata only on ingest. On first open: provider reference → SSRF-safe fetch (https, provider media
  hosts only, public IPs, ≤ 20 MB, ≤ 30 s) → type allow-list + signature check → private object storage → served as a
  download (`attachment`, `nosniff`, sandbox CSP) with authorization on every request. Deleted messages lose their files.
- **Identity linking** — explicit only (`cases.manage`), with a reason; never by name. Reversible; history kept.
- **CSAT** — per channel switch (`inbox.manage`), private chats on Facebook, Instagram, Telegram, WhatsApp, Bluesky. A
  request is a normal send; only an explicit 1–5 answer within 7 days counts. Report: sent, responses, response rate,
  average, distribution (`GET /api/inbox/csat/report`).
- **Saved views** — personal filter sets (queue, type, priority, channel, search).
- **Mentions in notes** — `@` autocomplete of people with inbox access on the brand; mentioned people are notified.
- **Realtime** — `GET /api/inbox/stream` (SSE, content-free events, access re-checked every 15 s, `revoked` on loss of
  access); polling remains the fallback.

## Permissions used
`inbox.read` (view, attachments, saved views, notes), `inbox.reply` (reply, moderation, CSAT request), `inbox.manage`
(channels, Telegram ownership, templates refresh, rates, CSAT switch, simulate), `cases.manage` (identity linking),
`integrations.manage` (WhatsApp connect). No new permission strings.

## Retention
Raw inbound update bodies 7 days (rows 30 days); stored attachment files deleted when the message is deleted at the
provider; moderation actions, CSAT requests and identity links for the workspace lifetime (policy purge = stream F).
