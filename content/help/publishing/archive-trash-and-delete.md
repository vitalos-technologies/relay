---
title: Archive, trash, restore and delete posts
summary: The difference between archiving, moving to Trash and deleting on a network, and what each does to schedules and published posts.
section: publishing
audience: user
roles: [owner, admin, brand_manager, editor]
status: available
related: [reschedule-pause-or-cancel, organise-the-content-library, bulk-actions]
product_version: "2026-11"
reviewed: 2026-11-09
order: 70
keywords: [delete, archive, trash, restore, remove post, recycle bin, undo]
---

**Relay never deletes or edits anything on a social network.** Archive and Trash only affect Relay. To remove a
published post from a network, delete it there.

## Compare

| | Archive | Move to Trash | Delete on the network |
|---|---|---|---|
| Where | **⋯ → Archive** on the post, or bulk | **⋯ → Move to Trash**, or bulk | In the network's own app |
| Who | `content.edit` (archive) | `content.archive` (Editor and above) | The account owner |
| Allowed for scheduled posts | No: *Cancel the schedule before archiving this post* | No: *This post is scheduled or waiting for approval. Cancel the schedule first.* | — |
| Allowed for published posts | **Yes** — the way to tidy published posts | **No**: *This post was published. Archive it instead; Relay never deletes posts from social networks.* | Yes |
| Visible in planner | Hidden | Hidden everywhere | — |
| Comes back with | **Unarchive** (bulk, or the toast's undo) | **Restore** in Trash within **30 days** | — |
| After that | Stays archived | Deleted permanently after 30 days | — |

## Move a draft to Trash

1. Open the post → **⋯ More post actions → Move to Trash**.
2. Relay shows the consequences: *Restorable for 30 days*, *Nothing on social networks is deleted or changed*, *Restoring
   it later does not schedule or publish it.*
3. Confirm **Move to Trash**. The toast offers undo.

## Restore from Trash

1. Open **Trash** ([/trash](/trash)) — *Kept 30 days*. **Show** posts or files.
2. Select **Restore** → *Restore as a draft?* — *Nothing is scheduled or published.* (Files: *It returns to the library.*)
3. Items marked **Deletes today** are about to be removed. **Can't restore** explains why (for example the brand is gone).
   Files still used by a draft show **In use · kept**.

## Archive a published post

1. Open the post → **⋯ → Archive** → *Archive this post?* — *Hidden from the planner. Cancel any active schedule first.*
2. The published post stays live on the network; its history and analytics stay in Relay.

## Limitations

- Trash can't be emptied manually; items are purged after 30 days (files only when nothing uses them any more).
