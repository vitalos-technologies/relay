---
title: Organise the content library
summary: Upload media to a brand's library, describe and tag it, find it again, and archive or trash what you no longer need.
section: publishing
audience: user
roles: [owner, admin, brand_manager, editor, publisher, approver, analyst, viewer]
status: available
related: [add-images-albums-and-video, alt-text-and-accessible-media, templates, archive-trash-and-delete, bulk-actions, brand-rules]
product_version: "2026-11"
reviewed: 2026-11-09
order: 33
keywords: [library, media library, assets, upload, tags, folders, images, files]
---

**Content library** ([/library](/library)) has three tabs per brand: **Media**, **Templates** and **Sources** (imports
from Google Drive, Google Docs and Notion — see the **Google Drive, Docs and Notion** section).

| Action | Permission | Roles |
|---|---|---|
| Browse and use media | `assets.read` | every staff role |
| Upload | `assets.upload` | Editor, Brand manager, Admin, Owner |
| Edit details, archive, trash | `assets.manage` | Brand manager, Admin, Owner |

## Upload

1. Choose the **Brand** in the header, open **Media**.
2. Drag files onto the drop zone or select **Choose files** (JPEG/PNG up to 20 MB, MP4/MOV up to 300 MB).
3. Each file shows its progress: *Preparing upload*, *Checking image*, then **Processing** for videos.
4. **Result:** the file appears as **Ready**. Files that fail checks appear as **Rejected** with the reason.

![Content library Media tab for the Relay Showcase workspace with a drop zone for JPEG and PNG files, search and status filters, and four synthetic images, each marked "No alt text"](/help/img/publishing/content-library.png)

## Find media

- **Search** by file name or tag.
- **Status**: All statuses, Ready, Processing, Rejected, Archived.
- **Select all on this page** to run [bulk actions](/help/publishing/bulk-actions) (tags, archive, trash).

## Describe a file

Select a file to open its details:

- **Alt text** — see [Add alt text](/help/publishing/alt-text-and-accessible-media).
- **Tags** — comma-separated; used by search and the media picker.
- **Licence and expiry** (when brand rules are on for your workspace): **Ownership**, **Owner**, **Licence**,
  **Expires**, **Licence link**, **Status** (Active, Superseded, Archived), **Notes**, and **Approved logo**. A post that
  uses an expired file is blocked by brand rules.

Select **Save**.

## Archive or trash a file

| | Archive | Move to Trash |
|---|---|---|
| Effect | *It can't be added to new posts.* Existing posts keep it. | Hidden everywhere; restorable for **30 days**, then deleted. |
| Refused when | — | A scheduled post or an unfinished delivery uses it: *Cancel or finish that post first.* |
| Drafts using it | Keep working | Keep working; the file isn't deleted permanently while a draft uses it. |

## Limitations

- There are no folders; use tags and search.
- Media belongs to one brand. To use a file in another brand, upload it there too.
