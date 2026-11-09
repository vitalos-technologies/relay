---
title: Import from Notion pages and databases
summary: Connect Notion, import pages as drafts or campaigns, map a Notion database to Relay drafts row by row, and understand what Notion statuses can and cannot do in Relay.
section: content-sources
audience: user
roles: [owner, admin, brand_manager, editor]
status: needs-setup
related: [content-sources-overview, notion-writeback, refresh-imported-content, export-to-google-docs-drive-and-notion, google-drive-and-docs]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [notion, page, database, data source, mapping, rows, status, content calendar, import]
sources:
  - title: "Notion API — versioning (2026-03-11 is the newest version referenced)"
    url: https://developers.notion.com/reference/versioning
    verified: 2026-11-09
  - title: "Notion API — request limits"
    url: https://developers.notion.com/reference/request-limits
    verified: 2026-11-09
  - title: "Notion API — file object (Notion-hosted file URLs valid one hour)"
    url: https://developers.notion.com/reference/file-object
    verified: 2026-11-09
---

## Before you start

- The workspace owner must have registered Relay as a Notion public connection in **Setup**.
- When you connect, **Notion asks which pages to share** with Relay. Relay can only see those pages (and pages below
  them). You can change the selection later in Notion's connection settings.
- Relay uses Notion API version 2026-03-11.

## Connect Notion

1. **Settings → Connections → Notion** ([/settings](/settings)) → **Connect**; choose a brand or the whole workspace.
2. In Notion, choose the workspace and the pages to share, then allow access.

## Import a Notion page

1. **Library → Sources** ([/library](/library)) → **Search Notion** → **Type: Pages** → pick a page.
2. Review the sections and warnings, choose **Draft per section**, **One draft** or **Campaign**, optionally
   destination accounts, then **Import**.

What Relay reads: the page's blocks, level by level, up to 4 levels deep and 2,000 blocks (40 list requests).
**Child pages and child databases are not followed.** Blocks Notion marks as unsupported, and anything past the limits,
are listed as warnings and the snapshot is marked **Incomplete**.

**Images and files on the page:** files hosted by Notion inside the selected sections (up to 10 per import) are
downloaded during the import — Notion's file links are valid for only one hour — and pass the same media checks as
uploads. Expired or unavailable files make the import **Imported with problems**. Files linked from external sites
are not fetched. Relay never stores Notion's file links.

## Import rows from a Notion database (content calendar)

Notion databases contain one or more **data sources**; Relay works with data sources.

1. **Library → Sources** → **Search Notion** → **Type: Data sources** → pick one.
2. **Map properties** to Relay fields:

   | Relay field | Notion property |
   |---|---|
   | Title | A title or text property |
   | Body | **Page content** (the row's page) or a text property |
   | Campaign | Optional; Relay finds or creates a campaign with that name |
   | Target date | Optional; becomes the draft's due date |
   | Status | Optional; used with **Import rows with status** |
   | External ref | Optional; stored as a reference |

   Relay validates the mapping against the live database: unknown properties, wrong types or statuses that don't exist
   are flagged on the field. Select **Save mapping**.
3. Optionally tick **Import rows with status** values (for example *Ready*).
4. Select rows (up to 100 per import) and **Import**.

Each row reports **imported**, **skipped**, **duplicate** (already imported, unchanged) or **error**. A row that was
imported before and has changed is **skipped** — use **Refresh** on it instead.

> **Important:** A Notion status such as *Ready* or *Approved* never approves anything in Relay. Every row becomes a
> plain draft that goes through your normal review and approval.

## Change notifications (optional)

Notion can notify Relay when shared pages change, through a webhook the workspace **owner** sets up once: Notion
sends a one-time verification token to Relay, the owner adopts it in Relay and pastes it into Notion's webhook
settings. Notifications are checked against Notion's signature and only mark items **Changed** (or **Removed**);
nothing is imported, approved or published from them. Notion delivers each notification at most once (with up to 8
attempts), so use **Refresh** if you expect a change that isn't flagged.

## Limits and notes

| Limit | Value |
|---|---|
| Rows per import | 100 |
| Media files per page import | 10 |
| Depth / blocks / list calls per page | 4 / 2,000 / 40 |
| Notion rate limit (Notion's rule, verified 2026-11-09) | 180 requests per minute per connection (600 on Notion Business and Enterprise plans); querying a data source about 3 per second; workspace-wide limits also apply. Relay waits and retries when Notion says to. |

## Disconnect Notion

**Settings → Connections → Notion → Disconnect** (Owner/Admin). Relay asks Notion to revoke its access, deletes the
stored tokens, cancels queued imports, exports and writebacks and marks items **Disconnected**. Imported drafts and
media stay. In Notion you can also remove Relay under **Settings → Connections**.
