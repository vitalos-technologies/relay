---
title: Publish to Pinterest
summary: Connect Pinterest boards, create image, multi-image and video Pins with a title, alt text and destination link, and understand Pinterest's Trial access, where Pins are visible only to you.
section: social-connections
audience: user
roles: [owner, admin, publisher]
status: needs-provider-approval
related: [connect-social-accounts, connection-status-and-fixes, network-limits-at-a-glance, metrics-by-network, set-up-social-network-apps]
product_version: "2026-11"
reviewed: 2026-11-09
order: 48
keywords: [pinterest, pin, board, trial access, standard access, sandbox, outbound click, alt text]
sources:
  - title: "Pinterest — access tiers (Trial sandbox, Standard upgrade)"
    url: https://developers.pinterest.com/docs/key-concepts/access-tiers/
    verified: 2026-11-09
  - title: "Pinterest official API client — PinUpdate (description 800 characters)"
    url: https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/PinUpdate.md
    verified: 2026-11-09
---

## At a glance

| | |
|---|---|
| Status in Relay | Built and tested on a simulated Pinterest API; **not verified with a live account**. |
| Destination | **One board per connection** — pick each board you want when connecting |
| Formats | Image Pin · Multi-image Pin (2–5) · Video Pin |
| Scheduling | Relay publishes at the scheduled time |
| Edit / delete after publishing | Not possible from Relay |
| Analytics | Impressions, saves, Pin clicks, outbound clicks, comments, reactions (Pinterest reports the last 90 days) |
| Inbox | Not available (Pinterest has no comment or message API) |

## Before you start

**Network rules (Pinterest, verified 2026-11-09):** an app on **Trial access** creates Pins and boards as **sandbox
entities visible only to you**, with low daily rate limits. **Standard access** (after Pinterest reviews a recording
of the app's OAuth flow and use) makes them public and raises limits. Relay shows a connection on Trial access as
**Limited access** with this explanation.

## Connect

1. **Connections** ([/accounts](/accounts)) → brand → **Connect** → **Pinterest**.
2. Sign in to Pinterest and approve (`boards:read`, `pins:read`, `pins:write`, `user_accounts:read`).
3. On **Choose destinations**, tick each **board** to publish to. Each board becomes its own connection.

## The Pinterest variant

| Field | Rule |
|---|---|
| Description | Post text, up to 800 characters |
| **Pin title** | Optional, up to 100 characters (Relay limit; Pinterest's limit **not verified**) |
| **Alt text** | Optional, up to 500 characters |
| Link | The Pin's destination link, up to 2,048 characters (Relay limit; **not verified**) |
| Media | Required |

## Limits

| Rule | Pinterest | Relay |
|---|---|---|
| Description | 800 characters (verified) | 800 |
| Images | **Not verified** on 2026-11-09 | JPEG/PNG ≤ 20 MB; multi-image 2–5 |
| Video | **Not verified** on 2026-11-09 | MP4/MOV/M4V, H.264/HEVC, 4 s–15 min, ≤ 2 GB |

## Scheduling and publishing

Pinterest fetches images itself from a temporary signed Relay link at publish time. Videos are uploaded and processed
before the Pin is created. A lost answer is resolved by looking at the board's recent Pins.

## Analytics

`IMPRESSION`, `SAVE`, `PIN_CLICK`, `OUTBOUND_CLICK`, `TOTAL_COMMENTS`, `TOTAL_REACTIONS`. Pinterest reports at most
90 days back, so for Pins older than that Relay shows a rolling 90-day total, not a lifetime total. Pinterest data is
treated as about 2 days late. (Pinterest's analytics documentation could not be re-checked on 2026-11-09.) See
[Metrics by network](/help/analytics/metrics-by-network).

## Reconnect, revoke, disconnect

- **Reconnect** when Pinterest's sign-in lapses (refresh tokens rotate; an unused connection eventually expires).
- **Disconnect** deletes the stored sign-in for that board and blocks its scheduled Pins; Pins stay on Pinterest.
- Revoke Relay in Pinterest under **Settings → Security and logins → Apps**. The menu names are the network's and may change (not verified in a live account).

## Common problems

| Message | Fix |
|---|---|
| Pinterest: choose a board. | Connect a board. |
| Pinterest: title is … of 100 characters. / alt text is … of 500 | Shorten the field. |
| Pins not visible to others | Relay's app is still on Trial access (Limited access badge). |
