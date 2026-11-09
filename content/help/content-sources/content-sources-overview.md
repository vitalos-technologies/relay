---
title: How Google Drive, Docs and Notion imports work
summary: Relay imports a private, immutable copy of the files and pages you pick. What is read, who can see the copy, and what happens when the source changes or access is revoked.
section: content-sources
audience: user
roles: [owner, admin, brand_manager, editor]
status: needs-setup
related: [google-drive-and-docs, notion, refresh-imported-content, export-to-google-docs-drive-and-notion, notion-writeback]
product_version: "2026-11"
reviewed: 2026-11-09
order: 10
keywords: [import, drive, google docs, notion, snapshot, copy, sharing, permissions, source, private copy]
sources:
  - title: "Google Drive API — choose scopes (drive.file is non-sensitive, per-file)"
    url: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
    verified: 2026-11-09
  - title: "Notion API — versioning"
    url: https://developers.notion.com/reference/versioning
    verified: 2026-11-09
---

Relay can bring content in from **Google Drive** (images and videos), **Google Docs** and **Notion** (pages and
databases) and turn it into drafts, campaigns or media. It never syncs a whole drive or workspace: it reads only the
items someone picks.

> **Important:** Imports have been built and tested against labelled test data only. No live Google or Notion account
> has been connected yet, and live use needs the workspace owner to register Relay with Google and Notion first.

## The flow

**Connect → pick → preview → import (in the background) → snapshot → drafts → normal review and scheduling.**

1. **Connect** a Google or Notion account (Owner or Admin), for one brand or the whole workspace.
2. **Pick** items: Drive files and Docs through Google's own file picker; Notion pages and databases by searching the
   pages you shared with Relay's Notion connection.
3. **Preview** shows what will be imported, the target brand and a sharing notice.
4. **Import** runs in the background. Relay re-checks your access and the source when the job runs.
5. Relay stores an **immutable snapshot** of exactly what it read (with a fingerprint and the source's version) and
   creates drafts, a campaign or media from it.
6. The drafts are ordinary Relay drafts: they go through your normal review, approval and scheduling.

## Who can do what

| Action | Who |
|---|---|
| Connect, reconnect or disconnect a Google or Notion account; switch on Notion writeback; adopt webhooks | Owner, Admin |
| Pick items for a brand, import Docs/Notion into drafts | Owner, Admin, Brand manager, Editor (on that brand) |
| Import Drive media | People who can upload media on that brand |
| Export reports or content plans to Docs, Drive or Notion | Owner, Admin, Exporter — and only to a destination the connection was explicitly given |
| See imported drafts and media | Everyone with access to the **brand in Relay** |

## Imported copies do not follow the source's sharing

Every preview says it plainly: *"Importing stores a private copy in Relay for the brand. Anyone with access to the brand
in Relay can use it. Google Drive / Notion sharing is not copied or changed, and later edits arrive only when you refresh."*

- A Doc shared with three people in Google can, once imported, be seen by everyone with access to that brand in Relay.
- Removing someone from the Google Doc or Notion page does **not** remove their access to the imported copy in Relay.
  Manage that through brand access in Relay.
- Shared Drive membership is not copied either.
- Relay never changes sharing settings in Google or Notion, and never calls their sharing endpoints.

## What Relay reads and asks for

| Source | Permission requested | What it allows |
|---|---|---|
| Google | `drive.file` (plus your email address to label the connection) | Only files you open with Relay's picker or that Relay creates. Google classifies it as non-sensitive. Relay cannot browse your Drive, list folders or read files you did not pick. |
| Notion | The pages and databases you share with Relay's Notion connection during sign-in | Read content; update content only if you switch on writeback; insert content only if you export to Notion |

Comments in Google Docs are never read. Imported text is treated as plain text, never as instructions to Relay; an
import never submits, approves or schedules anything.

## What happens when…

| Event | Result in Relay |
|---|---|
| The source is **edited** | Nothing changes automatically. The item shows **Changed** (when change notifications are on) and you choose **Refresh**. See [Refresh imported content](/help/content-sources/refresh-imported-content). |
| The source is **deleted or moved to trash** | The item shows **Removed**; its preview and link are hidden. Snapshots, drafts and media already imported stay. |
| **Your access to one item is removed** in Google/Notion | The item shows **No access**; preview hidden; no further reads. Imported copies stay. |
| **The whole connection is revoked** (in Google or Notion settings) | The connection shows *Reconnect required*; background reads and writes stop; previews are hidden. Imported copies stay. |
| **Someone disconnects** in Relay | Relay asks Google/Notion to revoke its access, stops change notifications, deletes the stored tokens, cancels queued imports, exports and writebacks, and marks items **Disconnected**. Imported copies stay. |
| **Snapshot retention** expires | After access is lost or the source is disconnected, snapshots are kept for the workspace's retention period (default 365 days), then deleted — unless the item is put **On hold**. Drafts and media created from them are app content and stay. |
| You **delete a source item** in Relay | The link and its snapshots are deleted. Drafts and media created from it stay. |

## Limits

| Limit | Value |
|---|---|
| Items per selection | 20 |
| Drive images / videos | 20 MB / 300 MB |
| Sections per import | 50 |
| Draft text | 60,000 characters (longer text is truncated with a warning) |
| Notion page depth / blocks / list calls | 4 levels / 2,000 blocks / 40 calls per page |
| Notion rows per import | 100 |
| Notion media per import | 10 files |

## Not available

Whole-folder or whole-drive sync, Google Sheets and Slides imports, and following Notion child pages or child databases
are not implemented.
