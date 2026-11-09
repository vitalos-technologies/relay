---
title: Webhooks
summary: Every inbound webhook Relay accepts, how each is verified on the raw body, deduplicated and retried, including billing events and the support widget's public endpoints.
section: developers
audience: developer
status: available
related: [api-conventions, publishing-engine-and-delivery-states, environment-variables, content-source-imports-and-exports]
product_version: "2026-11"
reviewed: 2026-11-09
order: 63
keywords: [webhook, callback, signature, hmac, stripe, telegram, meta, slack, notion, retries, widget]
---

## Common rules

All webhook endpoints follow the same order:

1. **Verify the raw body** with the sender's mechanism, using constant-time comparison and a replay window where the sender signs a timestamp. Unverified requests are rejected and **never stored**. A missing secret answers `412 provider_not_configured`.
2. **Persist and deduplicate** (unique on the sender's event id or a digest of the body).
3. **Acknowledge** with `200`. Duplicates are acknowledged (`"duplicate": true`) but not processed again.
4. **Process later** in the worker through the outbox, with retries. Webhooks are signals: publishing never depends on them, and a webhook never moves a delivery out of a final state.

Bodies are limited to 512 KB. Stored webhook bodies are cleared after 7 days (billing event bodies after 90 days); metadata is kept for audit.

## Endpoints

| Endpoint | Sender | Verification | Configure with |
|---|---|---|---|
| `POST /api/webhooks/telegram` | Telegram Bot API | `X-Telegram-Bot-Api-Secret-Token` equals the configured secret | `TELEGRAM_WEBHOOK_SECRET`. Relay never overwrites a bot's existing webhook. |
| `GET /api/webhooks/meta` | Meta subscription handshake | `hub.verify_token` equals the configured token; echoes `hub.challenge` | `META_WEBHOOK_VERIFY_TOKEN` |
| `POST /api/webhooks/meta` (also `facebook`, `instagram`) | Meta | `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(app secret, raw body) | `META_APP_SECRET` |
| `POST /api/meta/deauthorize`, `POST /api/meta/data-deletion` | Meta app callbacks | `signed_request` HMAC-SHA256 with the app secret | Meta app dashboard URLs |
| `POST /api/webhooks/stripe` | Stripe | `Stripe-Signature` v1 HMAC, 5-minute tolerance, current and previous secret during rotation | `RELAY_STRIPE_WEBHOOK_SECRET` (`_PREVIOUS` while rotating) |
| `POST /api/webhooks/notion` | Notion | `X-Notion-Signature` = `sha256=` + HMAC-SHA256(verification token, raw body) | `NOTION_WEBHOOK_VERIFICATION_TOKEN` |
| `POST /api/webhooks/google-drive` | Google Drive push channels | Per-channel random token (only its hash is stored), correlated by channel id; deduplicated by message number | Created automatically when a Drive source is linked; renewed before expiry |
| `POST /api/connectors/webhooks/<connector>` | Slack, HubSpot, Asana, monday.com, Mailchimp, WhatsApp, Google Business Profile | Slack `X-Slack-Signature` (signed timestamp, 5 min); HubSpot `X-HubSpot-Signature-v3` (5 min); Asana `X-Hook-Secret` handshake then `X-Hook-Signature`; monday.com JWT signed with the app signing secret; Mailchimp `X-Mailchimp-Signature` or a secret URL key; WhatsApp `X-Hub-Signature-256`; Google Business Profile authenticated Pub/Sub push (OIDC token, audience and service account) | The provider settings in [Environment variables](/help/developers/environment-variables) |
| `POST /api/integrations/tipsignal/events` | TipSignal | HMAC over `<timestamp>.<raw body>`, ±5 minutes, deduplicated on `event_id` | `TIPSIGNAL_SIGNING_SECRET`; creates drafts only |

## Processing and retries

| Source | Stored in | Retries |
|---|---|---|
| Social networks (Telegram, Meta) | `webhook_receipts` → outbox `webhook.received` | Outbox/pg-boss retries (5 with backoff). Processing is idempotent and never regresses delivery state. |
| Business connectors | `integration_events` (unique per connector + dedupe key) | Backoff per event; `dead` after 8 attempts. Echoes of Relay's own writes are recognised and ignored to prevent loops. |
| Stripe | `billing_webhook_events` (unique per provider event id) | Processed inline; on failure stays `failed` and the billing sweep retries every minute with exponential backoff (up to 6 hours apart), at most 10 attempts. The endpoint still answers `200` once the event is stored, so Stripe does not keep redelivering while Relay owns the retry. |
| Content sources (Notion, Drive) | `content_source_events` | Signals only: they mark linked items "change detected"; nothing is imported, published or approved automatically. |

### Billing events in detail

Handled Stripe event types include checkout completion and expiry, subscription created/updated/deleted/paused/resumed/trial-will-end, invoice paid/payment failed/action required/finalized/voided/uncollectible, customer updated and payment method attached. Each event is mapped to a workspace through Relay's own stored provider references (metadata is only a cross-checked fallback), then Relay **re-fetches** the object from Stripe and applies the current state, so out-of-order events converge. A reconciliation sweep also re-fetches subscriptions on its own (every 15 minutes for transitional states, every 6 hours otherwise) to catch events that never arrived.

## The support widget's public endpoints

The marketing-site support widget (`/api/widget/*`) is not a webhook, but it is the other unauthenticated surface that accepts writes from the internet. Protections:

- a visitor session cookie (or the signed-in member's session) and an Origin check;
- a signed form token with a minimum fill time and expiry, plus a honeypot field;
- shared rate limits per visitor and per IP (for example 5 new conversations per hour per visitor, 10 per IP; 30 replies per 10 minutes per visitor), size caps on messages and attachments;
- `client_id` deduplicates retries of the same message;
- Relay staff can block a visitor behind a ticket (ending their sessions), and platform operators can switch the widget off;
- a typed email never grants access to existing tickets; only the one-time email verification does.

## Testing webhooks locally

Integration tests sign fixtures with local test secrets (for example `tests/fixtures/stripe`). Without real provider apps, use the simulated destinations and the billing test double; never point a real provider's webhook at a development machine that holds production secrets.

## Related

- [API conventions](/help/developers/api-conventions)
- [Environment variables](/help/developers/environment-variables)
- [Content source imports and exports](/help/developers/content-source-imports-and-exports)
