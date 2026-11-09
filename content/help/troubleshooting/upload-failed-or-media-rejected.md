---
title: An upload failed or a file was rejected
summary: Why Relay refuses or rejects an image or video, and how to export a file it will accept.
section: troubleshooting
audience: user
status: available
related: [add-images-albums-and-video, organise-the-content-library, usage-and-limits]
product_version: "2026-11"
reviewed: 2026-11-09
order: 40
keywords: [upload error, rejected image, video rejected, file too large, unsupported format]
---

Relay checks every file before anyone can use it. Rejected files show **Rejected** in the library with the reason.

## Images

| Reason | Fix |
|---|---|
| Only JPEG and PNG images are supported | Export as JPEG or PNG (not HEIC, WebP, GIF, SVG). |
| The file is larger than 20 MB | Export at a lower size or quality. |
| The image is too large (… ). The maximum is 40 megapixels and 12000px per side. | Resize. |
| The image is too small … The minimum is 16px per side. | Use a bigger image. |
| The file content … does not match its declared type | The file was renamed (for example a PNG called .jpg). Re-export it. |
| The image is incomplete, malformed or could not be read | Re-export from the original. |
| The image contains hidden extra content … and was rejected | Re-export the image in an editor; the file had data appended. |

## Videos

| Reason | Fix |
|---|---|
| Only MP4 and MOV videos are supported / Videos must be 300 MB or smaller | Export as MP4, smaller. |
| The video codec … is not supported. Export the video as H.264 MP4 | Re-export with H.264 video. |
| The audio codec … is not supported. Export the video with AAC audio | Re-export with AAC audio. |
| The video is too short (min 0.5 s) / too long (max 15 minutes) | Trim it. |
| The video is too large … maximum is 8192px per side | Export at a smaller resolution. |
| The video took too long to analyse | Re-export it and try again. |

## Other causes

- *Upload failed. Check your connection and try again.* — the connection dropped.
- *Storage refused the file* — try again; if it repeats, contact support with the time.
- Storage allowance full, or paid actions paused — see [Usage and limits](/help/billing-and-plans/usage-and-limits).
- You need `assets.upload` (Editor and above).
