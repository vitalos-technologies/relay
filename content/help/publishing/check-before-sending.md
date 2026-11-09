---
title: Preview a post and fix readiness checks
summary: Use the preview and readiness panel to see what each network will get and fix limits, media, account, approval and brand-rule problems before sending.
section: publishing
audience: user
roles: [owner, admin, brand_manager, editor, publisher]
status: available
related: [shared-copy-and-channel-versions, add-images-albums-and-video, brand-rules, schedule-a-post, network-limits-at-a-glance]
product_version: "2026-11"
reviewed: 2026-11-09
order: 45
keywords: [validation, preview, readiness, warnings, character limit, errors, preflight, duplicate]
---

## Preview

In the editor, **Preview** shows how the post will look on one destination at a time (choose it under **Preview
destination**). Missing required media is called out, for example *Instagram requires an image*, *TikTok requires a
video or photos*, *YouTube requires a video*, *Pinterest requires an image or video*.

The preview approximates each network's layout; the network decides the final rendering.

## Readiness

The **Readiness** card lists problems per destination as you type; select one to jump to that destination. When you
schedule, submit or publish, Relay runs a full server check (preflight) and shows it in the dialog:

| Check | Fails when | Warns when |
|---|---|---|
| Permission | You can't schedule/publish/submit on this brand. | — |
| Accounts | No destination, or an account isn't connected, lacks permissions or needs reconnecting. | An account is expiring, paused, or rate limited by the network. |
| Time | The time is invalid, in the past or ambiguous. | — |
| Media | Media is missing, unsupported, too many, or not ready (processing, rejected, archived). | — |
| Content | Text too long, too many hashtags or mentions, invalid link, unsupported buttons, empty post. | — |
| Approval | The brand requires review (schedule/publish), or doesn't (submit). | — |
| Provider limits | Posts around this time exceed a known network limit (for example Instagram's 50 API posts per 24 h). | Near the limit (80%). |
| Budget | The X post budget would be exceeded. | Near the budget. |
| Brand rules | A **mandatory** brand rule is broken. | An **advisory** rule is broken. |
| Duplicates | — | Similar text or the same media went to the same destination recently. |
| Paused | — | The workspace, brand or destination is paused (held until resumed). |

**Failures block** the action. **Warnings** don't, except the duplicate warning, which you must confirm with **Post anyway**.

## Typical messages and fixes

| Message | Fix |
|---|---|
| caption is 2,310 of 2,200 allowed. Shorten by 110. | Shorten the text for that destination (custom text). |
| text is 290 of 280 allowed (X-weighted; links count as 23). | X counts links as 23 characters and some characters double. |
| links are not clickable here; put the URL in your bio or remove it. | Remove the link for that destination. |
| a video must be posted on its own here. | Give that destination a custom media set. |
| Limits unknown | Run **Check** on Connections to load the account's limits. |

Network-by-network limits: [Network limits at a glance](/help/social-connections/network-limits-at-a-glance).

## Duplicate check

**Settings → Publishing → Safety rules** sets the window per brand: *Warns before scheduling similar text or the same media
to the same destination within this many hours. A warning only — it never blocks without your confirmation. 0 = off.*
