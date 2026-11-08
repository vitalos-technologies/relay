# V3.5 final activation checklist

Everything V3.5 needs from outside the codebase before a capability can be used against a real provider. Nothing on this
list has been done: every V3.5 flow is **implemented and locally tested on simulated transports / signed fixtures**, and
**none has been verified against a live provider** (no credentials, approvals or test accounts were available, and the
brief forbids buying services or messaging real customers during development). Missing credentials never turn into
success: each capability shows its honest state (Needs app setup · Awaiting approval · Awaiting activation · Not set up)
until its row here is done. Compiled by stream F from the foundation, B, C, D and E progress notes (2026-11-08).

Legend — **Owner**: who acts (Operator = whoever runs this Relay installation; Admin = workspace owner/admin in Relay).
**Cost**: ✱ = billed service or per-use charge (needs budget approval first).

## 0. Deploy and restart (Operator)

| # | Item | Notes |
|---|---|---|
| 0.1 | Apply migrations 028–032 (`pnpm db:migrate`, then `pnpm db:roles`) | 033 was not needed. All five are applied on the dev database. |
| 0.2 | Deploy a web build and a **worker build that include all V3.5 streams**, then restart the worker | The worker registers: inbox (foundation + B), integrations (C: executors, Slack sender, GBP posts, Pub/Sub handler), listening (D), AI + automation (E), GBP review notifications → poll (F). The dev worker was rebuilt + restarted by stream F on 2026-11-08. |
| 0.3 | HTTPS `APP_BASE_URL` | Needed by every webhook below and by Telegram `setWebhook`. |
| 0.4 | Queue capacity | New queues `inbox-reply`, `inbox-events`, `integration-sync`, `listening-ingest`, `ai-assist` are created by the worker; customer replies run on the main pool, bulk work on the bulk pool (see `docs/v3-5/DATA_MODEL_AND_EVENTS.md`). |

## 1. Inbox networks (provider approvals)

| # | Network | What to do | Cost | Owner |
|---|---|---|---|---|
| 1.1 | Facebook Page (Messenger + Page comments) | Meta App Review: `pages_messaging`, `pages_manage_engagement`, `pages_read_user_content` (+ Human Agent feature if 7-day replies are wanted → then set `META_HUMAN_AGENT_APPROVED=true`); set `META_REQUEST_INBOX=true`; subscribe the Page webhook fields (`messages`, `message_echoes`, `message_edits`, `message_deliveries`, `message_reads`, `feed`) to `/api/webhooks/meta`; reconnect Pages. | — | Operator |
| 1.2 | Instagram | App Review `instagram_manage_messages`, `instagram_manage_comments` (+ Human Agent); subscribe Instagram webhook (`messages`, `comments`) to `/api/webhooks/meta`. | — | Operator |
| 1.3 | WhatsApp Business Platform | WABA + registered number + Business verification + payment method; system-user token; webhook `whatsapp_business_account/messages` → `/api/connectors/webhooks/whatsapp` (verify token + `META_APP_SECRET`); approved message templates; optional rate card per channel. | ✱ per message | Operator + Admin |
| 1.4 | Google Business Profile reviews | Business Profile API access approval (quota 0 until granted); verified locations; see 2.4 for OAuth + Pub/Sub. | ✱ Pub/Sub (optional) | Operator |
| 1.5 | YouTube | `youtube.force-ssl` granted (reconnect existing channels); quota budget for replies (`comments.insert` = 50 units). | — | Operator |
| 1.6 | Bluesky | App password created with direct-message access (for DMs). | — | Admin |
| 1.7 | Telegram | Per bot: Settings → Inbox → Channels → Check → Claim (only when no other app consumes the bot's updates). Removing the channel releases Relay's webhook. | — | Admin |
| 1.8 | Threads | App Review `threads_read_replies`, `threads_manage_replies`; add them to the Threads OAuth scopes. | — | Operator |
| 1.9 | X, LinkedIn, TikTok inbox | Provider access first (X paid API ✱, LinkedIn Community Management API, TikTok API for Business); no adapter is built. | ✱ (X) | Operator |

## 2. Business integrations (app registrations)

Redirect URIs and webhook URLs are shown in Relay → Integrations → <connector> to the instance owner and platform operators.

| # | Connector | What to do | Cost | Owner |
|---|---|---|---|---|
| 2.1 | Asana | Register an OAuth app (scopes `tasks:read/write`, `projects:read`, `users:read`, `webhooks:write`, `workspaces:read`; redirect `<APP_BASE_URL>/api/connectors/oauth/asana/callback`) → `ASANA_CLIENT_ID`, `ASANA_CLIENT_SECRET`. | — | Operator |
| 2.2 | monday.com | App with OAuth + signing secret → `MONDAY_CLIENT_ID`, `MONDAY_CLIENT_SECRET`, `MONDAY_SIGNING_SECRET`; confirm the current `MONDAY_API_VERSION`. | — | Operator |
| 2.3 | HubSpot | Public app (Service Hub portal for tickets) → `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`; subscribe app webhooks `ticket.propertyChange`, `ticket.deletion` → `/api/connectors/webhooks/hubspot`; set a default pipeline + stage per installation. Marketplace listing only if distributed. | — | Operator + Admin |
| 2.4 | Google Business Profile | OAuth client → `GBP_CLIENT_ID`, `GBP_CLIENT_SECRET`; optional Pub/Sub topic + authenticated push subscription → `GBP_PUBSUB_AUDIENCE`, `GBP_PUBSUB_SERVICE_ACCOUNT` (review notifications then trigger an immediate poll of the location's inbox channel). | ✱ Pub/Sub | Operator |
| 2.5 | Google Cloud Translation | Project with billing + API enabled; service account with `roles/cloudtranslate.user` → `GOOGLE_TRANSLATE_PROJECT_ID`, `GOOGLE_TRANSLATE_SERVICE_ACCOUNT_JSON` (+ `GOOGLE_TRANSLATE_LOCATION` for glossaries); confirm list price (`TRANSLATE_PRICE_PER_MILLION_USD`, default 20). A workspace admin must still enable translation and acknowledge billing. | ✱ per character | Operator + Admin |
| 2.6 | Slack | App (bot scopes `chat:write`, `channels:read`, `groups:read`; interactivity URL `/api/connectors/webhooks/slack`) → `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`. Members link identities explicitly from a Slack click. | — | Operator |
| 2.7 | Mailchimp | Registered app → `MAILCHIMP_CLIENT_ID`, `MAILCHIMP_CLIENT_SECRET`; optional signed webhooks `MAILCHIMP_WEBHOOK_SECRET` (URL-key mode is the baseline). Drafts only; sending stays a separate privileged action in Mailchimp. | — | Operator |
| 2.8 | Live verification | One designated test account per connector; run the flows in `docs/v3-5/INTEGRATIONS.md` → "Live verification". None done yet. | — | Operator |

## 3. Listening (licensed data)

| # | Item | Cost | Owner |
|---|---|---|---|
| 3.1 | Connected-source listening goes live with the inbox channels (1.1–1.8): no extra step. | — | — |
| 3.2 | Broader listening — each needs a provider adapter + credentials/licence (re-verify docs before building): X API pay-per-use credits + budget approval; YouTube Data API key (search = 100 units); Bluesky app password; Reddit Data API commercial agreement; a licensed news/web/forums provider contract. Until then every broad source shows "Awaiting activation". | ✱ (X, Reddit, news) | Operator |
| 3.3 | Optional AI sentiment/topics (budget-gated) once the AI service exposes a classification task; today a transparent lexicon baseline is used. | ✱ | Operator |

## 4. Relay AI and automation

| # | Item | Cost | Owner |
|---|---|---|---|
| 4.1 | AI provider key (Setup → AI). Without it the assistant shows "AI is not set up" and AI replies stay off; classification, routing and saved-reply automation work without AI. MCP `prepare_with_ai` returns `not_configured`. | ✱ per token | Operator |
| 4.2 | Workspace monthly AI token cap (`limits.ai_monthly_tokens`) and per-policy token budgets before enabling AI replies. | — | Admin |
| 4.3 | Approve knowledge per brand (Assistant → Knowledge) with review dates before any AI answer about policy, prices or refunds. | — | Admin (brand manager) |
| 4.4 | Integration automation actions need the integrations in section 2 connected (Slack/Asana/monday/HubSpot). Mailchimp drafts are made from approved posts only (not an automation action). | — | Admin |

## 5. MCP (stream F)

| # | Item | Owner |
|---|---|---|
| 5.1 | Existing MCP clients keep their consented scopes. To use the V3.5 tools a person re-approves the client with the new scopes (`inbox.read`, `inbox.draft`, `inbox.assign`, `cases.manage`, `listening.read`, `ai.prepare`) in Settings → Developer → MCP. API-key clients created before V3.5 must be re-created to receive them. | Admin / each member |
| 5.2 | No MCP tool sends a customer reply; drafts are sent by a person in Relay. Nothing to activate. | — |

## 6. Decisions still open (lead / user)

- Main navigation grouping (proposal in `docs/v3-5-progress/final.md` → "Nav proposal"); Inbox in the phone bottom bar for
  inbox users (lead recommends replacing Planner for them).
- Whether platform operators should get a per-workspace (still counts-only) drill-down; today the platform view is
  installation-wide aggregates only.
