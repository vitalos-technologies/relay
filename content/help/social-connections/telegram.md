---
title: Publish to a Telegram channel
summary: Connect a Telegram channel with your own bot, publish text with link previews and URL buttons, photos, albums and videos, and understand why Telegram has no analytics and why lost results need a manual check.
section: social-connections
audience: user
roles: [owner, admin, publisher]
status: not-live-verified
related: [connect-social-accounts, connection-status-and-fixes, network-limits-at-a-glance, inbox-channels-by-network]
product_version: "2026-11"
reviewed: 2026-11-09
order: 42
keywords: [telegram, bot, botfather, channel, token, url buttons, album, media group, webhook]
sources:
  - title: "Telegram Bot API (limits, media groups, updates)"
    url: https://core.telegram.org/bots/api
    verified: 2026-11-09
---

## At a glance

| | |
|---|---|
| Status in Relay | Built and tested on a simulated Bot API; **not verified with a live bot**. No network approval is needed. |
| Destination | One Telegram **channel** where your bot is an administrator allowed to post |
| Formats | Text (with link preview and up to 5 URL buttons) · Photo · Album (2–10 photos/videos) · Video |
| Scheduling | Relay sends at the scheduled time |
| Edit / delete after publishing | Not possible from Relay |
| Analytics | **None** — the Bot API gives bots no post or channel statistics. Shown as *not provided*, never as 0. |
| Inbox | Private chats with the bot and group messages it can see — only after you explicitly let Relay receive the bot's updates |

## Before you start

1. In Telegram, open **@BotFather**, create a bot (`/newbot`) and copy its **token**. Use a bot dedicated to Relay if you can.
2. Add the bot to your channel as an **administrator** with the **Post messages** right.
3. Know the channel's public `@username`, or its numeric ID (starts with `-100`) for a private channel. Invite links
   (`t.me/+…`) do not identify a channel to bots and are refused.

## Connect

1. **Connections** ([/accounts](/accounts)) → brand → **Connect** → **Telegram**.
2. Paste the **Bot token** (stored encrypted, never shown again) and the **Channel** (`@yourchannel` or `-100…`).
3. Select **Connect**. Relay checks the token, finds the channel and confirms the bot may post.

**Expected outcome:** **Connected**. If the bot is not an admin with *Post messages*, the card shows **Missing
permission** with the fix.

> **Note:** Connecting for publishing never changes the bot's webhook or reads its updates, so another app already
> using the same bot keeps working. Relay only reports that an existing webhook was left alone.

## What you can publish

| Format | In Relay | Notes |
|---|---|---|
| Text | Text, optional link, optional URL buttons | The link is appended and previewed; up to 5 buttons (Relay limit), one per row |
| Photo | One image + caption | Buttons allowed |
| Album | 2–10 photos and/or videos | The caption goes on the first item. **URL buttons are not possible on albums** (Telegram does not allow them) |
| Video | One video + caption | Sent with streaming support |

## Limits

| Rule | Telegram (verified 2026-11-09) | Relay |
|---|---|---|
| Text message | 1–4,096 characters after formatting | 4,096 UTF-16 units |
| Caption with media | 0–1,024 characters | 1,024 |
| Photo | ≤ 10 MB; width + height ≤ 10,000; ratio ≤ 20 | Same; JPEG/PNG |
| Album | 2–10 items; no buttons | Same |
| Video | Bots can send up to 50 MB | ≤ 50 MB, ≤ 15 min (Relay limit), MP4/MOV with H.264 + AAC |

## Scheduling and publishing

Relay sends at the due time. Telegram has no idempotency key and no way for a bot to look up what it sent, so if the
answer from Telegram is lost Relay **cannot tell** whether the message went out. The delivery shows **Not confirmed —
check before retrying**: look at the channel, then mark it *Published* or *Not published* in Relay. Retrying without
checking can post twice.

## Analytics

None. Telegram does not give bots view counts or channel statistics. Telegram posts appear in **Analytics** counts of
posts published, but every network metric is shown as *not provided by the network*.

## Inbox

Relay can receive private chats with your bot and group messages it can see, but a bot has exactly **one** update
stream (a webhook or polling). Relay therefore asks before taking it: **Settings → Inbox → Channels** → check the bot
→ Relay shows whether another app already uses a webhook (it never overwrites one) → you confirm that no other app
reads the bot's updates → Relay sets its own webhook. Releasing removes only Relay's webhook. Telegram keeps updates
for 24 hours only, so earlier history cannot be imported. See [Inbox channels by network](/help/inbox-and-care/inbox-channels-by-network).

## Reconnect, revoke, disconnect

- **Reconnect** with a new token after you revoke or regenerate it in @BotFather (the card shows *Reconnect required*).
- **Disconnect** deletes the stored token and blocks scheduled posts; channel messages stay.
- To fully revoke, remove the bot from the channel admins or revoke its token in @BotFather (`/revoke`).

## Common problems

| Message | Fix |
|---|---|
| Make the bot a channel admin ("Post messages"), then Check. | Add the bot as admin with *Post messages*, then **⋯ → Check now**. |
| Reconnect with a new @BotFather token. | The token was revoked or is wrong: paste a valid token. |
| Use @name (4+ chars) or -100… ID. | Invite links and short names are not accepted. |
| Image width + height is … at most 10000px. | Resize the image. |
| Buttons not allowed on albums | Remove the buttons or send a single photo. |
