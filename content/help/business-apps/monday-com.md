---
title: Create monday.com items from Relay
summary: Connect monday.com, choose boards, create or link items from posts, campaigns, conversations and cases, and map name, date and status columns.
section: business-apps
audience: user
roles: [owner, admin, brand_manager, editor, care_agent]
status: needs-setup
related: [business-apps-overview, asana, slack]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [monday, monday.com, board, item, status column, webhook]
sources:
  - title: "monday.com — Webhooks (challenge, JWT signing, retries)"
    url: https://developer.monday.com/api-reference/reference/webhooks
    verified: 2026-11-09
---

## Before you start

The workspace owner registers a monday.com app with OAuth and a signing secret in **Setup**. Relay requests
`boards:read`, `boards:write`, `users:read`, `webhooks:write`.

## Connect and choose boards

1. **Connections → Business apps → monday.com** ([/integrations](/integrations)) → **Connect**; choose the scope; approve in monday.com.
2. **Resources** → select the **Boards**.
3. **Sync rules** → map Relay fields to the board's columns (the editor loads the board's columns).

## Create or link an item

Same places and same "what leaves Relay" preview as Asana: Composer **Integrations** card, Inbox **External work**,
or a listening alert. Link an existing item by URL or id; unlinking leaves the item in monday.com.

**Status labels:** *Done* ⇄ done, *Working on it* ⇄ in progress, anything else ⇄ open.

## How sync works

| Field | Direction |
|---|---|
| Name, date, status column | Relay → monday; two-way only if mapped two-way |
| Priority column | Relay → monday |
| Approval / publishing | Never synced |

monday.com webhooks are verified with the URL challenge and a JWT signed with the app's signing secret (monday.com
only signs webhooks created with an app token). monday.com retries failed deliveries once a minute for 30 minutes;
Relay also re-reads linked items periodically.

## Errors and disconnect

Deleted items and revoked access mark links unavailable; Relay records are kept. Lost create answers are reconciled
with the marker Relay writes in the item's first update. **Disconnect** deletes Relay's token; uninstall the app in
monday.com to revoke it there.
