---
title: Refresh imported content after the source changes
summary: What Refresh does when a Google Doc, Drive file or Notion page changed — new snapshot, a diff, and either a new draft revision or a separate new draft — and why approved or scheduled posts are never changed.
section: content-sources
audience: user
roles: [owner, admin, brand_manager, editor]
status: needs-setup
related: [content-sources-overview, google-drive-and-docs, notion, notion-writeback]
product_version: "2026-11"
reviewed: 2026-11-09
order: 40
keywords: [refresh, changed, diff, snapshot, source changed, revision, access lost, removed, retention, hold]
---

Imported content never updates itself. When a source changes, you decide when to bring the change in.

## How you notice a change

- With change notifications on (**Watch changes** on a Google connection, or the Notion webhook set up by the owner), the item shows **Changed — refresh to
  review**.
- Without them, open the item and select **Refresh** whenever you want to check.

## Refresh

1. **Library → Sources** ([/library](/library)) → the item → **Refresh**.
2. Relay re-reads the source in the background with the connection's current access.
3. **If nothing changed**, nothing happens.
4. **If it changed**, Relay stores a new snapshot and shows a **diff** (sections added, removed and changed, plus line
   changes). Then, for each draft created from the source:

| Draft's situation | What Refresh does |
|---|---|
| Still an editable draft and **not edited in Relay** since the import | Adds a **new revision** of that draft with the new text (the previous version stays in its history) |
| **Edited in Relay** since the import | Creates a **new draft** beside it (reason: *edited in Relay*) so your edits are not overwritten |
| **Approved, scheduled or published** | Creates a **new draft** beside it (reason: *approved or scheduled*). The approved revision and any schedule are **never** touched |

Posts are always sent from Relay's own stored copy and media; a later source change can never alter what goes out
unless someone refreshes and the new draft goes through review again.

## When refresh can't read the source

| State | Meaning | What you can do |
|---|---|---|
| **No access** | Google or Notion refused this item (unshared, permission removed) | Ask the owner to share it again with the connected account, then Refresh |
| **Removed** | The file or page was trashed or deleted | Nothing to refresh; imported copies stay |
| Reconnect required (on the connection) | The whole Google or Notion authorization was revoked or expired | An Owner or Admin reconnects |
| **Disconnected** | Someone disconnected the source in Relay | Connect again and re-pick the item |

In all of these states Relay hides the preview and the link to the source, because it can no longer confirm you may
see them. Drafts, campaigns and media already imported are unaffected.

## Keeping or deleting snapshots

- Snapshots are kept while the item is readable. After access is lost or the source is disconnected they are kept for
  the workspace's snapshot retention period (default **365 days**), then deleted automatically.
- **On hold** stops that deletion for an item (for example for a legal or audit need).
- **Delete source and snapshots** removes the link and all its snapshots now. Drafts and media created from it stay.
