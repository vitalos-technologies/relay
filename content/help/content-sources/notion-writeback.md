---
title: Write post status back to Notion
summary: Let Relay update a Notion content calendar with each post's Relay status, scheduled time and post links — field by field, with conflict detection so edits made in Notion are never silently overwritten.
section: content-sources
audience: user
roles: [owner, admin]
status: needs-setup
related: [notion, content-sources-overview, refresh-imported-content]
product_version: "2026-11"
reviewed: 2026-11-09
order: 60
keywords: [notion, writeback, status, content calendar, sync, conflict, scheduled time, post url]
---

Writeback keeps a Notion database you imported from up to date with what happens in Relay. It is **off** by default
and only writes the fields you choose.

## What can be written

| Relay field | Values written to Notion |
|---|---|
| **Relay status** | Draft in Relay · In review · Scheduled · Published · Failed |
| **Scheduled time** | The post's scheduled date and time |
| **Post URLs** | Links to the published posts |

Properties used to import content (title, body, campaign, target date, external ref) can't be writeback targets, and a
Relay status can't be written to the same property you import statuses from (that would create a loop).

## Switch it on

1. An Owner or Admin opens **Settings → Connections → Notion** ([/settings](/settings)) and turns **Writeback** on
   for the connection.
2. Open the data source in **Library → Sources** ([/library](/library)), and in the mapping choose a Notion property for
   each writeback field you want. **Save mapping**.
3. If you write the status into a Notion *Status* property, create the five Relay status options in Notion first;
   otherwise Notion rejects the update and the writeback fails.

## How it behaves

- **One property per update.** Relay never rewrites the whole row.
- **Driven only by Relay events** (review, scheduling, publishing). Imports, refreshes and Notion notifications never
  trigger writeback; edits made by Relay's own Notion connection are ignored when they come back.
- **Conflict detection:** before writing, Relay compares the property's current value with what it last saw or wrote.
  If someone changed it in Notion, the writeback stops with **Conflict** and asks a person to choose: overwrite with
  Relay's value, or keep Notion's.
- **Re-checked every time:** the connection must still be active with writeback on, the mapping unchanged, and the
  person who configured it must still manage connections for the brand — otherwise nothing is written.

## Turn it off

Turn **Writeback** off on the connection or clear the writeback fields in the mapping. Values already written stay in
Notion. Disconnecting Notion cancels pending writebacks.
