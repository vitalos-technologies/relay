# Telegram provider: channel publishing via the Bot API

Code: `packages/providers/src/telegram/` (`telegramAdapter`, `telegramConnector`, `telegramFake`).
Connection lifecycle: `packages/services/src/connections/`. Contract tests: `tests/contracts/telegram.test.ts`;
integration: `tests/integration/connections.test.ts`.

Research date: **2026-11-06**. Facts marked **verified** were read from the official pages below on that date.
Facts marked **assumed** are inferred or come from experience, not from the docs. Nothing here has been run
against the live Bot API yet. The spec §5 access spike (a real bot, a real channel, a test post,
then removing the bot's admin right and checking the result) is **still outstanding**.

## Sources (fetched 2026-11-06)

| # | URL | Used for |
|---|---|---|
| T1 | https://core.telegram.org/bots/api | Request/response format, methods, types, limits. The latest changelog entry is **Bot API 10.3 (2026-08-24)**. |
| T2 | https://core.telegram.org/bots/faq | Broadcast and per-chat rate limits, 429 behaviour |

## Verified facts (T1 unless noted)

- **Requests**: `https://api.telegram.org/bot<token>/METHOD_NAME`, HTTPS only, GET or POST. Parameters can be
  sent as a query string, `application/x-www-form-urlencoded`, `application/json` (except uploads) or
  `multipart/form-data` (for uploads). Method names are case-insensitive. The token appears **only in the
  path**; `HttpTransport` and `log` redact `/bot<token>/` before logging.
- **Responses**: JSON with a Boolean `ok`. On success the data is in `result`. On failure there is a
  `description`, an integer `error_code` ("contents are subject to change"), and an optional `parameters`
  (`ResponseParameters`). `ResponseParameters.retry_after` is "the number of seconds left to wait before the
  request can be repeated" when flood control is exceeded. `migrate_to_chat_id` applies to migrated groups only.
- `getMe` takes no parameters and returns the bot's `User` (`id`, `is_bot`, `username`, …).
- `getChat(chat_id)` returns `ChatFullInfo` with `id`, `type` (`private|group|supergroup|channel`), `title` and
  `username`. `chat_id` is an Integer or a String (`@username` of a supergroup or channel).
- `getChatMember(chat_id, user_id)` returns a `ChatMember`. For other users it is "only guaranteed to work …
  if the bot is an administrator in the chat". `ChatMemberOwner.status` is always `"creator"`.
  `ChatMemberAdministrator.can_post_messages` is "True, if the administrator can post messages in the channel"
  and applies to channels only.
- `sendMessage`: `chat_id`; `text` is "1-4096 characters after entities parsing"; `link_preview_options`
  (`LinkPreviewOptions`: `is_disabled`, `url`, `prefer_small_media`, `prefer_large_media`, `show_above_text`);
  `reply_markup`.
- `sendPhoto`: `photo` (InputFile or String). "The photo must be at most 10 MB in size. The photo's width and
  height must not exceed 10000 in total. Width and height ratio must be at most 20." `caption` is "0-1024
  characters after entities parsing". Files are uploaded with `multipart/form-data`.
- `InlineKeyboardMarkup.inline_keyboard` is an "Array of button rows". `InlineKeyboardButton.url` is an
  "HTTP or tg:// URL to be opened when the button is pressed".
- `getWebhookInfo` takes no parameters and returns `WebhookInfo` (`url`, `has_custom_certificate`,
  `pending_update_count`, …).
- **Rate limits (T2)**: in one chat, avoid more than one message per second, or "eventually you'll begin
  receiving 429 errors". Groups are limited to 20 messages per minute. Bulk sending is limited to about 30 messages
  per second (paid broadcasts raise this).
- The Bot API has **no client idempotency key** and **no method for a bot to read channel history** (no such
  method exists in T1).

## Assumed (not stated in the docs; confirm in the access spike)

- Error `description` strings used for classification: `Forbidden: bot was kicked from the channel chat`,
  `Forbidden: bot is not a member of the channel chat`, `Bad Request: chat not found`,
  `Bad Request: not enough rights to send text messages to the chat`,
  `Bad Request: need administrator rights in the channel chat`, `Bad Request: message is too long`,
  `Bad Request: message caption is too long`, `Bad Request: PHOTO_INVALID_DIMENSIONS`, `BUTTON_URL_INVALID`.
  The adapter falls back to HTTP status when a string differs: 403 means permission, 401/404 mean the token is bad.
- A 5xx response to `sendMessage`/`sendPhoto` may follow a successful post, so it is treated as **Unknown**.
- Text counting uses UTF-16 code units (`textCounting: 'utf16'`). We send no `parse_mode`, so the text has no
  entities to parse.
- The product allows up to 5 URL buttons, one per row. Telegram itself allows more.

## Setup (operator / customer)

1. In Telegram, open **@BotFather**, send `/newbot`, and copy the token (`123456789:AA…`). Use a **dedicated
   bot** where practical.
2. Open the channel and go to **Administrators → Add Admin**. Choose the bot and enable **Post Messages**.
   Nothing else is needed.
3. In Social Lite, go to **Accounts → Connect Telegram**. Paste the token and the channel: either `@publicname`,
   or for a private channel the numeric ID (starts with `-100`). **Invite links (`t.me/+…`, `t.me/joinchat/…`)
   are rejected** because they do not identify a channel to the Bot API.
4. Social Lite verifies the bot and the channel before marking the connection Ready (AC-03):
   `getMe` → `getChat` (must be `type: channel`) → `getChatMember(chat, bot)`. The bot must be `creator`, or
   `administrator` with `can_post_messages`; otherwise the status is **Missing permission** and the exact fix is
   shown. It then reads `getWebhookInfo` only to report "existing webhook preserved". Social Lite **never calls
   `setWebhook`, `deleteWebhook` or `getUpdates`**, so an existing bot integration keeps its updates.
5. No app-level configuration is needed (`GET /api/providers` reports Telegram as configured).

The bot token is stored envelope-encrypted (`credentials`, AAD `credential:<workspaceId>`). It is never
returned to clients or logged, and it is deleted when the connection is disconnected.

## Capabilities and constraints (`TELEGRAM_CONSTRAINTS`, version `telegram-bot-api-10.3@2026-11-06`)

| | |
|---|---|
| Formats | text (with optional link and URL buttons), single photo with caption and buttons |
| Text | 4096 UTF-16 units; the link is appended to the text and gets a preview through `link_preview_options.url` |
| Caption | 1024 UTF-16 units (the link is appended to the caption) |
| Image | JPEG/PNG, ≤ 10 MB, width + height ≤ 10000, aspect ratio between 1:20 and 20:1, 1 per post |
| Buttons | URL buttons (https), up to 5, one per row |
| Edit/delete/metrics | not implemented |
| Reconcile | **unsupported**: no idempotency key and no history lookup |

Published URL: `https://t.me/<username>/<message_id>` when the channel has a public username. Otherwise none.
Every returned `message_id` is saved.

## Error policy (publish)

| Condition | Outcome | Blocking |
|---|---|---|
| 429 + `parameters.retry_after` | `rejected_safe_to_retry`, `retryAfterMs = retry_after*1000` | – |
| 401 / 404 (token revoked/regenerated) | `permanent_failure` `telegram_token_rejected` | `reconnect` |
| 403, or 400 "not enough rights" / "need administrator rights" / "bot was kicked" / "chat not found" | `permanent_failure` with the exact fix ("Administrators → … enable Post Messages") | `permission` |
| Other 400 (caption/text too long, bad photo, bad button, …) | `permanent_failure` with the specific fix | – |
| 5xx after the request was sent | `unknown` (may have posted) | – |
| `TransportError` before connect (`requestMayHaveBeenSent=false`) | `rejected_safe_to_retry` | – |
| Timeout/reset after send | `unknown` | – |

**Unknown outcomes** cannot be resolved automatically. `reconcile` returns `unsupported` with instructions to
check the channel and mark the delivery Published or Not published. If a late worker returned a
`message_id`, `reconcile` confirms it as published.

Health (`adapter.health`): `getMe` + `getChatMember`. A rejected token means **Reconnect required**. A bot that
is not an admin, or lacks the post right, means **Missing permission**. Network errors keep the previous
status and record "could not reach Telegram".

## Costs and limits

The Bot API is free. Throughput is limited by the rates above (about 1 message per second per channel). The
engine's per-connection throttling must respect `retry_after`.

## Simulated destination (`telegramFake`)

Serves `getMe`, `getChat`, `getChatMember`, `getWebhookInfo`, `sendMessage` and `sendPhoto` for `mock_` connections only.
Scenarios: `success`, `fail_permanent` (400 bad content), `fail_transient_once` (pre-connect failure, then
success), `timeout_after_send` (message stored, response lost), `rate_limited_once` (429 with `retry_after: 3`),
`processing` (same as success), `revoked` (401 everywhere), `missing_permission` (admin without
`can_post_messages`; sends return 400 "need administrator rights"). Message ids are `mock_…`.
