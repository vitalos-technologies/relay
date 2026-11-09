---
title: Inbox channels by network
summary: Which conversations Relay's inbox can read and answer on each network — DMs, comments, mentions, reviews — the reply windows, what needs the network's approval, and what is not possible at all.
section: inbox-and-care
audience: user
roles: [owner, admin, care_agent, brand_manager]
status: needs-provider-approval
related: [whatsapp-in-the-inbox, google-reviews-in-the-inbox, telegram, instagram, facebook, youtube, bluesky, threads]
product_version: "2026-11"
reviewed: 2026-11-09
order: 20
keywords: [inbox, channels, dm, messages, comments, mentions, reviews, reply window, 24 hours, human agent, capabilities]
sources:
  - title: "Messenger Platform policy overview (24-hour window, Human Agent 7 days)"
    url: https://developers.facebook.com/docs/messenger-platform/policy/policy-overview
    verified: 2026-11-09
  - title: "Telegram Bot API (one update consumer; updates kept 24 hours)"
    url: https://core.telegram.org/bots/api
    verified: 2026-11-09
  - title: "YouTube Data API quota costs (comments.insert 50 units)"
    url: https://developers.google.com/youtube/v3/determine_quota_cost
    verified: 2026-11-09
  - title: "Threads API — get started (reply permissions)"
    url: https://developers.facebook.com/docs/threads/get-started
    verified: 2026-11-09
  - title: "Google Business Profile — reviews (list, get, updateReply, deleteReply)"
    url: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews
    verified: 2026-11-09
  - title: "WhatsApp Business Platform pricing"
    url: https://developers.facebook.com/docs/whatsapp/pricing
    verified: 2026-11-09
---

Publishing access and inbox access are separate: being able to post to a network does not mean Relay may read or
answer messages there. **Settings → Inbox → Channels** ([/settings](/settings)) shows the same capability table for
your workspace, including which channels are connected.

> **Important:** Every inbox channel below is built and tested on simulated network APIs. None has been verified with
> a live account, and the ones marked *needs approval* only work for real accounts after the network approves Relay.

## Capability table

| Network | Conversations | How messages arrive | Reply rules | Moderation | Needs |
|---|---|---|---|---|---|
| **Facebook Page** | Messenger DMs; comments on Page posts (mentions not built) | Webhook + polling | DMs within **24 h** of the customer's last message; Human Agent tag **7 days**; one private reply to a comment within 7 days | Hide/unhide comments; delete the Page's own reply | Meta App Review: `pages_messaging`, `pages_manage_engagement`, `pages_read_user_content`; Page role with messaging |
| **Instagram** | DMs; comments (mentions not built) | Webhook | DMs within 24 h (7 days with Human Agent approval); DM text up to 1,000 bytes; one private reply per comment within 7 days | Hide/unhide comments; delete own reply | Meta App Review: Instagram messaging and comment permissions |
| **WhatsApp** | Messages | Webhook | Free-form only within 24 h; otherwise approved templates, charged by Meta | — | WhatsApp Business Account, verified business, payment method. See [WhatsApp in the inbox](/help/inbox-and-care/whatsapp-in-the-inbox) |
| **Google Business Profile** | Reviews | Polling (Google notifications trigger a check) | Public owner reply; update or delete it | Delete the **owner reply** only | Google Business Profile API approval. See [Google reviews](/help/inbox-and-care/google-reviews-in-the-inbox) |
| **YouTube** | Comments on your videos | Polling (about every 5 min) | Public replies (50 quota units each) | Hold for review / publish; delete own reply | `youtube.force-ssl` permission |
| **Bluesky** | Replies, mentions, DMs | Polling (about every minute) | Public replies; DMs in existing conversations | Delete own reply | App password (with DM access for DMs) |
| **Telegram** | Private chats with the bot; group messages it can see | Relay's webhook, after you explicitly hand the bot's updates to Relay | Private chats privately; groups in the group | Delete the bot's own messages (within 48 h) | Bot token; no other app may read the bot's updates |
| **Threads** | Replies to your posts (mentions not built) | Polling (10 most recent posts, about every 5 min) | Public replies | Hide/unhide replies | Meta App Review: `threads_read_replies`, `threads_manage_replies` |
| X | — | — | — | — | Paid API access; not built in Relay |
| LinkedIn | — | — | — | — | Community Management API approval; not built. LinkedIn has no Page messaging API |
| TikTok | — | — | — | — | Business-account comments need a different TikTok API; not built. No DM API |
| Pinterest | — | — | — | — | Not possible (no comment or message API) |
| Threads DMs, TikTok DMs | — | — | — | — | Not possible (no API) |

## Telegram: handing the bot's updates to Relay

A Telegram bot has exactly one update stream. In **Settings → Inbox → Channels**:

1. **Check** the bot. If another app already has a webhook, Relay shows only its host and **never overwrites it**.
2. If there is no webhook, confirm that **no other app reads this bot's updates** (Telegram cannot tell Relay about
   polling apps). Within 10 minutes of the check, **Claim**: Relay re-checks and sets its own webhook with a secret.
3. Until claimed the channel shows **Not receiving yet**. Telegram keeps undelivered updates for only 24 hours, so
   older history cannot be imported.
4. **Release** removes Relay's webhook only if it is still Relay's.

## When a reply's result is lost

Relay looks the reply up on the network (Instagram, YouTube, Bluesky, Threads, Google) before doing anything.
**Telegram** has no lookup — a person checks. **WhatsApp** waits for Meta's status notification. Nothing is resent
automatically.

## Attachments

Attachments are fetched only when someone opens them, from the network's own media hosts, up to 20 MB, checked for
type, stored privately and served as downloads to people with inbox access.
