---
title: Provider adapter contract
summary: The interfaces every social network adapter implements (validate, prepare, publish, reconcile, health, refresh), how transports are chosen, and how to add or test a provider.
section: developers
audience: developer
status: available
related: [publishing-engine-and-delivery-states, testing-and-contributing, webhooks, analytics-ingestion]
product_version: "2026-11"
reviewed: 2026-11-09
order: 60
keywords: [provider, adapter, network, integration, transport, connector, oauth, contract]
---

## Where things live

| Piece | Location |
|---|---|
| Contracts (pure types) | `packages/core/src/adapter.ts` (publishing, connections), `packages/core/src/contracts/v35-inbox.ts` (inbox) |
| Adapters, connectors and simulators | `packages/providers/src/<network>/` for `meta` (Facebook, Instagram), `telegram`, `x`, `tiktok`, `youtube`, `linkedin`, `threads`, `pinterest`, `bluesky`; inbox and business connectors in `whatsapp`, `google-business`, `asana`, `monday`, `hubspot`, `slack`, `mailchimp`, `google-translate`; billing in `stripe` |
| Registry | `packages/providers/src/registry.ts` (publishing) and `inbox-registry.ts` (inbox). Services obtain adapters, connectors and transports **only** through these. |
| Transports | `packages/providers/src/transport/http.ts` (live) and `transport/mock.ts` (simulated) |
| Contract tests | `tests/contracts/*.test.ts` (one or more per network) |

The engine and services depend only on the contracts, never on a network's code.

## The publishing adapter

```ts
interface PublishingAdapter {
  readonly provider: Provider;
  capabilities(connection): ChannelCapabilities;          // formats, limits, publish mode
  validate({ variant, media, connection }): ValidationResult; // pure, no IO
  prepare(ctx, input, checkpoint): Promise<PrepareOutcome>;    // safe to repeat
  publish(ctx, input, checkpoint): Promise<PublishOutcome>;    // the one call that may create content
  reconcile(ctx, ref): Promise<ReconcileOutcome>;             // read-only; must never create content
  health(ctx, connection, credentials): Promise<ConnectionHealth>;
  refreshCredentials?(ctx, credentials): Promise<…>;          // callers serialize per connection
  cancelRemoteSchedule?(ctx, ref): Promise<RemoteScheduleCancelOutcome>; // provider-held releases
}
```

Rules every adapter follows:

- **`validate`** is pure and runs in the browser preview, at scheduling and again at dispatch. It reports network rules (text length, media count, formats, aspect ratios) separately from Relay's own limits.
- **`prepare`** returns `ready`, `pending` (poll again after `checkAfterMs`), `retryable` or `permanent`, plus a **checkpoint** the engine stores on the delivery. Prepared objects that expire on the network side (for example an Instagram container after about 24 hours) carry `expiresAt`.
- **`publish`** returns one of `confirmed`, `processing`, `rejected_safe_to_retry`, `permanent_failure` (optionally with a blocking reason: `reconnect`, `permission`, `budget`, `rate_limit`), `unknown` or `handoff`. If the request may have reached the network and no clear answer came back, the adapter **must** return `unknown`, never `rejected_safe_to_retry`.
- **`reconcile`** searches for a post created by an ambiguous attempt (around `sentAt`, using known provider ids and the text) and returns `published`, `processing`, `not_published`, `still_unknown`, `handoff` or `unsupported`. It never creates content.
- **`health`** returns `ready`, `missing_permission`, `expiring` or `reconnect_required` with a person-readable message and the exact fix.
- Errors are classified by `packages/providers/src/shared/classify.ts`; credentials are never logged.

`PublishInput` carries the delivery id, attempt number, a stable `idempotencyKey` (used where the network supports client idempotency), the connection, decrypted credentials, the resolved variant (text, link, format, buttons, options) and media as short-lived signed URLs with a `load()` for networks that need multipart upload.

## Credentials

Credential kinds: `oauth2` (access/refresh token, expiry, scope), `meta_page` (page token derived from a long-lived user token), `telegram_bot` (bot token), `atproto_app_password` (Bluesky session) and `mock`. They are stored envelope-encrypted, decrypted only in the worker or the connection service, and refreshed under a per-connection advisory lock.

## Transports

| Transport | Used for | Guarantees |
|---|---|---|
| `HttpTransport` | Every live connection | HTTPS only; host must be on the provider allow-list (plus `BLUESKY_SELF_HOSTED_HOSTS`); redirects never followed; bounded timeouts; network failures classified by whether the request may have been sent (`TransportError.requestMayHaveBeenSent`) — only a failure before the connection was established is safe to retry for a publish. |
| `MockTransport` | `mock_` destinations only | In-process simulator with scenarios `success`, `fail_permanent`, `fail_transient_once`, `timeout_after_send` (post created, response lost → Unknown), `rate_limited_once`, `processing`, `revoked` and `missing_permission`. Returned only when the destination id starts with `mock_` **and** mock providers are enabled outside production. |

`transportFor()` throws if a live destination would get the simulator or a `mock_` destination would get the live transport.

## Connecting accounts

- **OAuth networks** implement `OAuthConnector`: `authorizationUrl` (state, PKCE where supported), `exchangeCode`, `listDestinations` (pages, profiles, channels the person can publish to, with a reason when one cannot be selected) and `finalize` (credentials, granted scopes, expiry, health).
- **Telegram** uses a bot token and channel (`TelegramConnector.verify`); it checks the bot may post and never changes the bot's webhook.
- **Bluesky** uses an app password (`BlueskyConnector`).
- App credentials come from environment variables or the setup page (`ProviderAppConfig`); without them the network shows as "Not configured" and connecting returns `provider_not_configured`.

## Inbox and business connectors

Inbox adapters (`InboxAdapter` in `contracts/v35-inbox.ts`) add `capability`, `missingPermissions`, `parseWebhook`, optional `poll`, `replyRules`, `sendReply` and `findSent`. Replies use the same send-once discipline as publishing: an ambiguous send is checked with `findSent` instead of being repeated. Business connectors (Asana, monday.com, HubSpot, Slack, Mailchimp, Google Business Profile, Cloud Translation) live in `packages/services/src/integrations-v35/` and `packages/services/src/connectors/` and use the same encrypted credential storage and verified webhooks.

## Adding or changing a provider

1. Read the network's current official API documentation; record limits and approvals in the provider notes and keep network rules apart from Relay limits.
2. Add the adapter, connector and simulator under `packages/providers/src/<network>/`, register them in `registry.ts`, add the network to `PROVIDERS` in `packages/core/src/types.ts` and its API hosts to `PROVIDER_HOSTS`.
3. Map errors with the shared classifier. Return `unknown` whenever a publish may have happened.
4. Implement `reconcile` read-only, or return `unsupported` (the delivery then needs a person to resolve it).
5. Add contract tests in `tests/contracts/` against recorded or simulated responses: validation, each outcome kind, timeouts during publish (must be `unknown`), token refresh and revocation.
6. Add the setting keys for app credentials in `packages/services/src/settings.ts` and document them in [Environment variables](/help/developers/environment-variables) (the docs check fails otherwise).

## Related

- [Publishing engine and delivery states](/help/developers/publishing-engine-and-delivery-states)
- [Webhooks](/help/developers/webhooks)
- [Testing and contributing](/help/developers/testing-and-contributing)
