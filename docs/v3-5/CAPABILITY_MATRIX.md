# V3.5 capability matrix — what Relay can really do

Baseline audit for V3.5 (brief `docs/queue/03f_V3_5_PROMPT.md` §10, §23 step 1). Checked on **2026-11-07** against official
documentation where it was reachable; rows marked *secondary* rely on third-party/community sources and must be re-verified
by the owning stream before building. Publishing access never implies messaging access.

Legend: **Supported** = official API, no special approval beyond normal OAuth · **Needs approval** = official API exists but
needs provider review, allow-listing, a paid tier or commercial setup · **Not available** = no official API for third parties ·
**Built** = implemented in Relay (V3.5 foundation) · **Planned (stream)** = not implemented yet.

Machine-readable copy: `packages/services/src/inbox/capabilities.ts` (served at `GET /api/inbox/capabilities`, shown in
Settings → Inbox → Channels) and `packages/services/src/connectors/registry.ts` (`GET /api/connectors/registry`).

## Headline

| Area | Supported today | Needs provider approval / money | Not available |
|---|---|---|---|
| Inbox | Telegram bot chats; YouTube comments; Bluesky mentions/replies/DMs (**built, simulated transport** — stream B) | Facebook Messenger + Page comments (**built, on the simulated transport**), Instagram DMs/comments, WhatsApp (per-message charges), Google reviews, X DMs/mentions (paid), LinkedIn org comments, Threads replies, TikTok business comments | Threads DMs, TikTok DMs, LinkedIn page messaging, Pinterest comments/DMs, Google Business Profile chat (shut down July 2024) |
| Integrations | Slack, Asana, monday.com, HubSpot, Mailchimp (each needs an operator-registered OAuth app; no review for internal use) | Google Business Profile API (access approval, quota 0 until granted), Cloud Translation (billing), WhatsApp (Business verification + charges), HubSpot marketplace listing for public distribution | — |
| Listening | Connected-source monitoring (comments/mentions/reviews from connected channels) | X search (paid credits), Reddit Data API (commercial terms), licensed news/web providers | Logged-in scraping (refused by policy), "all of social" coverage |

## Inbox — per network

| Network | Conversation types (read / reply) | Inbound | History | Reply window | Receipts | Requires | Relay |
|---|---|---|---|---|---|---|---|
| **Facebook Page** | Messenger DMs, Page post comments (needs approval / needs approval); mentions not built | Webhook (`messages`, `message_echoes`, `message_edits`, `message_deliveries`, `message_reads`, `feed`) + Graph polling for reconciliation | Conversations API (recent threads) | 24 h after the customer's last message; Human Agent tag 7 days (feature approval); private reply to a comment: once, ≤ 7 days | Delivered + read (Messenger) | App Review: `pages_messaging`, `pages_manage_engagement`, `pages_read_user_content` (Advanced Access for Pages you don't own); Page role with the MESSAGING task | **Built** (simulated transport; live behind `META_REQUEST_INBOX=true` after review) |
| Instagram | DMs, comments, mentions (needs approval) | Webhook + polling | Conversations API, media comments | 24 h; Human Agent 7 days | Read | `instagram_business_manage_messages` (IG Login) or `instagram_manage_messages` (FB Login), comment permissions; professional account; escalation path to a human required | **Built (B)** — DMs, comments, private reply once, hide/unhide, delete own reply (mentions not built); simulated transport; live after App Review |
| Telegram bot | Private chats with the bot; group/discussion messages the bot can see (supported) | Webhook **or** getUpdates — one consumer per bot | None (updates kept 24 h, not re-fetchable) | None | None | Bot token; privacy mode limits group messages | Planned (B) — needs an explicit ownership plan: Relay never overwrites an existing webhook nor steals `getUpdates` — **Built (B)**: check → explicit confirmation → `setWebhook` to a per-channel URL + secret; release removes only Relay's webhook |
| WhatsApp Business Platform | DMs (needs approval) | Webhook (X-Hub-Signature-256) | None | Free-form only inside the 24 h customer service window; otherwise approved templates | Delivered + read | WABA + registered number + Business verification; **per-message pricing since 2025-07-01**, 1,000 free service messages/month per number, payment method required (from 2026-09-30) | **Built (B)** — 24 h window, approved templates (cached), charge shown + acknowledged before a charged send, pricing/failed statuses, unknown sends confirmed via `biz_opaque_callback_data`; simulated transport; live needs a WABA |
| Google Business Profile | Reviews: read + owner reply update/delete (needs approval) | Pub/Sub notifications (new/updated reviews) or polling `reviews.list` | All reviews per location | None | None | Business Profile API access (quota 0 until approved); verified locations; **chat discontinued 2024-07-31** (not offered) | **Built (B)** reviews + owner reply update/delete via polling (`integration_cursors`); GBP connection = stream C; live needs API approval |
| X | DMs, mentions (needs approval: paid) | Polling | Recent within API limits | None | None | Pay-per-use credits (default since 2026-02; Basic closed to new sign-ups — *secondary*); app permission "Read + write + Direct Messages"; per-request charges | Not built — needs paid access; shown as "needs approval" |
| YouTube | Comments (supported) | Polling (`commentThreads.list`) | All comment threads per video | None | None | `youtube.force-ssl`; `comments.insert` = 50 quota units of 10,000/day | **Built (B)** — polling, replies, hold/publish, delete own |
| LinkedIn | Organization post comments (needs approval) | Polling | Org post comments | None | None | Community Management API approval (separate developer app); no page messaging API | Not built — needs approval |
| Threads | Replies + mentions (needs approval); DMs not available | Webhook + polling | Replies to own posts | None | None | `threads_read_replies`, `threads_manage_replies`, `threads_manage_mentions` (App Review) | **Built (B)** — replies by polling, hide/unhide; mentions not built |
| Bluesky | Mentions, replies, DMs (supported) | Polling (notifications, chat) | Notifications + chat conversations | None | Read (chat) | App password; DMs need an app password created with direct-message access | **Built (B)** — replies, mentions, DMs (chat getLog), delete own reply |
| TikTok | Business-account comments (needs approval, *secondary*); DMs not available | Polling | Recent comments (≤ 90 days reported) | 48 h for organic comment replies (*secondary, unconfirmed*) | None | TikTok API for Business approval — not the Content Posting API Relay uses | Not built — needs approval |
| Pinterest | Not available (no comment/DM API in v5) | — | — | — | — | — | Not offered |

## Business integrations

| Connector | Auth + scopes (least privilege) | Inbound authenticity | Delivery semantics | Prerequisites | Relay |
|---|---|---|---|---|---|
| Asana | OAuth (PKCE) `tasks:read/write`, `projects:read`, `users:read`, `webhooks:write` | Handshake echoes `X-Hook-Secret`; events `X-Hook-Signature` = HMAC-SHA256(hook secret, body) | **At-most-once**, retries with backoff ≤ 24 h, then the webhook is deleted; events are compact (fetch state); heartbeats | Operator-registered app; polling fallback required for completeness | Verifier + ingress built; connector (C) |
| monday.com | OAuth `boards:read/write`, `users:read`, `webhooks:write` | URL challenge echoed; app webhooks carry a JWT (HS256, signing secret) in Authorization | Retries once a minute for 30 min | App with OAuth + signing secret (JWT only when created with the app token) | Verifier + ingress built; connector (C) |
| HubSpot | OAuth `crm.objects.contacts.read`, `crm.objects.companies.read`, `tickets`, `crm.objects.owners.read` | `X-HubSpot-Signature-v3` = base64 HMAC-SHA256(client secret, method + URI + body + timestamp), ≤ 5 min | Batched events with ids | Public app; tickets need Service Hub | Verifier + ingress built; connector (C) |
| Google Business Profile | OAuth `business.manage` | Pub/Sub push (Google-signed OIDC token) | Pub/Sub at-least-once | API access approval; Pub/Sub topic (billed Google Cloud service); chat discontinued | Verifier refuses until stream C adds OIDC/JWKS check |
| Google Cloud Translation | Service account / OAuth `cloud-translation` | n/a | Synchronous API | Cloud project + billing (per character); glossaries need Advanced (v3); pricing page not machine-readable here — verify current rates before estimating cost | Connector (C) |
| Slack | OAuth v2 `chat:write`, `channels:read`, `groups:read`, `users:read`, `users:read.email` | `X-Slack-Signature` = `v0=` hex HMAC-SHA256(signing secret, `v0:ts:body`), ≤ 5 min | Retries; interactive payloads form-encoded | App + signing secret + interactivity URL | Verifier (incl. rotation) + ingress built; connector (C) |
| Mailchimp | OAuth (Marketing API; account-wide, no granular scopes) | Optional `X-Mailchimp-Signature` (HMAC over timestamp + body — exact join to confirm) **or** secret in callback URL | Retries over 75 min; may be disabled | OAuth app | URL-key verifier built; signature mode pending confirmation (C) |
| WhatsApp | System-user token `whatsapp_business_messaging`, `whatsapp_business_management` | `X-Hub-Signature-256` (app secret) | Webhooks | See inbox row | Verifier built; channel (B) |

## Listening coverage

| Layer | Source | Status |
|---|---|---|
| Connected-source monitoring | Comments, mentions, reviews from connected inbox channels (public only; private DMs excluded from share-of-voice) | Data available through the inbox tables once channels are live; analysis is stream D |
| Broader listening | X search (paid credits), YouTube search (quota), Bluesky public search, Reddit (commercial terms), licensed news/web providers | Needs approval or a licence; stream D builds a provider interface + coverage registry and marks sources "awaiting activation" |
| Not offered | Logged-in scraping, private groups, "all social networks" claims | Refused by policy |

## Sources (checked 2026-11-07)
- Messenger policy (24 h window, Human Agent 7 days): developers.facebook.com/docs/messenger-platform/policy/policy-overview
- Private replies (7 days, one message, `pages_messaging`): developers.facebook.com/docs/messenger-platform/discovery/private-replies
- Instagram messaging permissions / 24 h / Human Agent / Advanced Access: developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
- WhatsApp pricing (per-message since 2025-07-01, service window, free tier, 2026 changes): developers.facebook.com/docs/whatsapp/pricing
- GBP reviews (list/get/updateReply/deleteReply): developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews; notifications via Pub/Sub: developers.google.com/my-business/content/notification-setup; access approval + quota 0: Google's access form + community reports (*secondary*); chat shutdown 2024-07-31 (*secondary press*)
- YouTube `comments.insert` (replies only, 50 units, force-ssl): developers.google.com/youtube/v3/docs/comments/insert
- Telegram Bot API (getUpdates vs webhook, 24 h retention, secret token header): core.telegram.org/bots/api
- Threads reply management: developers.facebook.com/docs/threads/reply-management
- LinkedIn Community Management comments API: learn.microsoft.com/linkedin/marketing/community-management/shares/comments-api
- X pricing (pay-per-use 2026): third-party summaries only (*secondary*) — verify in the X developer console
- TikTok business comments: third-party integration docs only (*secondary*)
- HubSpot v3 signatures: developers.hubspot.com/docs/api/webhooks/validating-requests
- Asana webhooks: developers.asana.com/docs/webhooks-guide
- monday.com webhooks: developer.monday.com/api-reference/reference/webhooks
- Slack request signing: docs.slack.dev/authentication/verifying-requests-from-slack
- Mailchimp webhooks: mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/


Stream B (2026-11-08): Instagram, WhatsApp, Google reviews, YouTube, Bluesky, Telegram and Threads adapters are built and
exercised on simulated transports; see `docs/v3-5/INBOX_NETWORKS.md`. Sources re-checked 2026-11-08: Instagram Send API +
private replies + comment replies (developers.facebook.com), WhatsApp Cloud API messages reference, GBP
`reviews.updateReply`, Telegram `setWebhook`/`getWebhookInfo`.
