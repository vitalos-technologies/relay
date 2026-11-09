---
title: Add images, albums and video to a post
summary: Attach media from the library or upload new files, order an album, add one video, and understand the file limits.
section: publishing
audience: user
roles: [owner, admin, brand_manager, editor]
status: available
related: [organise-the-content-library, crop-images-for-each-channel, alt-text-and-accessible-media, shared-copy-and-channel-versions, upload-failed-or-media-rejected]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [image, photo, carousel, album, video, upload, media, gallery, reel]
---

## Before you start

- **Required permission:** `assets.read` to use library media; `assets.upload` to upload (Editor, Brand manager, Admin, Owner).
- Uploads need an active plan with storage left; when paid actions are paused, new uploads are refused.

## Relay's file limits

| | Accepted | Size | Other limits |
|---|---|---|---|
| Images | JPEG, PNG | up to **20 MB** | Checked and re-encoded; metadata (such as GPS) is removed |
| Video | MP4, MOV | up to **300 MB** | 0.5 s to 15 min; Relay makes a network-ready MP4 (H.264/AAC, up to 1280×1024) and a poster frame |

Each network has its own rules on top (number of items, video length, aspect ratio, whether text-only posts are
allowed). Relay checks them per destination; see the network guides in **Social connections**.

## Add media

1. In the editor, under **Media** (base content, or a destination's version set to **Custom**), select add.
2. In **Add media**, choose **Library** (search by name or tag; only **Ready** files are listed) or **Upload**.
3. Pick the files. The dialog says how many you may add: *One image or video.* or *Up to N items, or one video.* — N is
   the smallest album size among the selected destinations (at most 10).
4. **Result:** the media strip shows the files in publish order. Videos show a badge with their duration.

## Order or remove items

Drag items, or use **Move … earlier** / **Move … later** (keyboard friendly). **Remove …** detaches a file from this post
only; it stays in the library.

## Messages you may see

| Message (per destination) | Fix |
|---|---|
| … is required. Add an image or video or remove this destination. | Instagram, TikTok, YouTube, Pinterest need media. |
| text-only posts are not supported. | Add media. |
| videos are not supported for this destination. | Remove the video or that destination. |
| a video must be posted on its own here. | Don't mix a video with other items for that network. |
| at most N items per post. Remove X. | Shorten the album, or give that destination a custom media set. |
| Media not ready | The file is still processing, or was rejected or archived. |

## Limitations

- **Video thumbnails:** Relay uses an automatically extracted poster frame. Choosing a custom thumbnail or cover image
  isn't supported.
- Crops apply to images only, never to video.
- GIF, WebP, HEIC and other formats aren't accepted; convert to JPEG or PNG first.
