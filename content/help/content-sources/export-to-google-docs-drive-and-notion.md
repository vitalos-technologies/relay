---
title: Export to Google Docs, Drive or Notion
summary: Send an analytics report or a content plan to a new Google Doc, a file in a chosen Drive folder, or a new Notion page — and what Relay checks about the destination and the content.
section: content-sources
audience: user
roles: [owner, admin, exporter]
status: needs-setup
related: [content-sources-overview, analytics-exports-and-reports, google-drive-and-docs, notion]
product_version: "2026-11"
reviewed: 2026-11-09
order: 50
keywords: [export, google doc, drive folder, notion page, content plan, report, destination]
---

Relay can **create** documents in Google or Notion. It never edits or overwrites existing files and never changes
sharing.

## Destinations

| Destination | What Relay creates | Limit |
|---|---|---|
| **Google Doc** | A new Google Doc (Relay uploads HTML and Google converts it) | Upload up to 5 MB |
| **Drive file** | A new file (CSV, HTML or PDF) in a Drive folder you picked | Upload up to 5 MB |
| **Notion page** | A new page under a parent page you picked | Notion's request limits |

A PDF cannot become a Google Doc — export it as a Drive file instead.

## Before you start

- You need the **Exporter**, **Admin** or **Owner** role, and read access to the content (analytics for reports,
  content for plans) on every brand in the export.
- The Google or Notion connection must have been **given the destination explicitly**: pick the Drive folder with
  Google's picker, or share the Notion parent page with Relay. Picking a folder does not give Relay access to the
  files already inside it.

## Export a content plan

1. **Library → Sources** ([/library](/library)) for the brand → **Export plan**.
2. Choose the **Destination account** (Google Docs or Notion).
   - Google: optionally **Choose folder** (default: *My Drive*). Relay creates a new **Google Doc** there.
   - Notion: **Choose parent page** (required). Relay creates a new page under it.
3. Select **Export**. The export runs in the background: **Exporting…** (with the sharing warning) → **Exported**
   with an **Open** link.

## Export an analytics report

In the app, analytics exports are files you download (see [Export analytics](/help/analytics/analytics-exports-and-reports)).
Relay's API can also deliver a report export to a Google Doc, Drive file or Notion page with the same destination
checks; the Analytics screen does not offer this yet.

## What Relay checks

The destination permission (Exporter/Admin/Owner + an explicitly selected destination) and the content permission are
checked **separately**, when you request the export and again when the background job runs. If you lost access in
between, the export fails instead of writing.

**Sharing:** the new document inherits the sharing of the folder or parent page it is created in. Relay shows a
sharing warning but never changes sharing — check who can see that folder or page before exporting.
