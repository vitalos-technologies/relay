---
title: Network limits at a glance
summary: Text length, media counts, file sizes, video length and required fields for every network Relay publishes to — with the network's own rule and Relay's check side by side.
section: social-connections
audience: user
status: not-live-verified
related: [connect-social-accounts, instagram, facebook, telegram, x-twitter, tiktok, youtube, linkedin, threads, pinterest, bluesky]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [character limit, caption, length, file size, video length, images per post, carousel, album, aspect ratio, format]
sources:
  - title: "Instagram — IG User Media reference"
    url: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
    verified: 2026-11-09
  - title: "Facebook — Page Photos reference"
    url: https://developers.facebook.com/docs/graph-api/reference/page/photos/
    verified: 2026-11-09
  - title: "Telegram Bot API"
    url: https://core.telegram.org/bots/api
    verified: 2026-11-09
  - title: "X — media best practices"
    url: https://docs.x.com/x-api/media/quickstart/best-practices
    verified: 2026-11-09
  - title: "TikTok — media transfer guide"
    url: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
    verified: 2026-11-09
  - title: "TikTok — photo post reference"
    url: https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
    verified: 2026-11-09
  - title: "YouTube — videos resource"
    url: https://developers.google.com/youtube/v3/docs/videos
    verified: 2026-11-09
  - title: "LinkedIn — MultiImage API"
    url: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api
    verified: 2026-11-09
  - title: "LinkedIn — Videos API"
    url: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
    verified: 2026-11-09
  - title: "Threads — overview (media specifications)"
    url: https://developers.facebook.com/docs/threads/overview
    verified: 2026-11-09
  - title: "Threads — posts (500 characters, emoji bytes, 5 links)"
    url: https://developers.facebook.com/docs/threads/posts
    verified: 2026-11-09
  - title: "Bluesky lexicons as published in the official @atproto/api package"
    url: https://unpkg.com/@atproto/api/dist/client/lexicons.js
    verified: 2026-11-09
---

Relay checks every channel variant against these limits **while you write**, **when you schedule** and **again just
before sending**. The composer shows the exact fix (for example "Threads: text is 512 of 500 allowed").

How to read the tables:

- **Network rule** is what the network documents. Where we could not find it in the network's current official
  documentation on 2026-11-09 it says **not verified**.
- **Relay** is what Relay enforces. It is sometimes stricter than the network (our media pipeline accepts videos up to
  15 minutes and 300 MB for most networks, and produces JPEG/MP4 files to publish), and occasionally a network rule is
  not checked in advance — then the network rejects the post and the delivery shows its message.

## Text

| Network | Network rule | Relay checks |
|---|---|---|
| Instagram | Caption 2,200 characters, 30 hashtags, 20 @tags | 2,200 code points, 30 hashtags, 20 mentions; text-only posts not possible |
| Facebook Page | No limit found in Meta's Page post reference — **not verified** | 10,000 code points (conservative Relay limit) |
| Telegram | Message 1–4,096 characters; media caption 0–1,024 characters (after formatting) | 4,096 / 1,024 UTF-16 units |
| X | 280, links count as 23 — **not re-verified 2026-11-09** | 280 weighted characters |
| TikTok | Video caption 2,200 UTF-16 units; photo title 90, photo description 4,000 | 2,200 (photo description capped at 2,200 by Relay); photo title 90 |
| YouTube | Title 100 characters; description 5,000 **bytes**; no `<` or `>`; tags 500 characters in total | Same; title required |
| LinkedIn | 3,000 is widely reported; not stated in the Posts API reference — **not verified** | 3,000 UTF-16 units |
| Threads | 500 characters; each emoji counts as its UTF-8 bytes; at most 5 links | 500 with the emoji rule. The 5-link rule is **not** checked by Relay (the network rejects the post) |
| Pinterest | Description 800; title 100 — **title not verified** | Description 800, title 100, alt text 500, destination link 2,048 characters |
| Bluesky | 300 graphemes and 3,000 bytes | Same |

## Images and albums

| Network | Images per post (network) | Relay accepts | File rules (network → Relay) |
|---|---|---|---|
| Instagram | Carousel up to 20 images/videos | 2–20 (album); single image | JPEG only, ≤ 8 MB, aspect 4:5–1.91:1, width 320–1440 (scaled) → same; min width 320 |
| Facebook Page | Multi-photo maximum not documented | 2–10 (Relay limit), images only | JPEG/BMP/PNG/GIF/TIFF ≤ 10 MB → JPEG/PNG ≤ 10 MB |
| Telegram | Album 2–10 photos/videos | 2–10, videos allowed; URL buttons not allowed on albums | Photo ≤ 10 MB, width + height ≤ 10,000, ratio ≤ 20 → same, JPEG/PNG |
| X | Up to 4 photos, or 1 GIF, or 1 video | 1–4 images, or 1 video | Image ≤ 5 MB (JPG/PNG/GIF/WEBP) → JPEG/PNG ≤ 5 MB |
| TikTok | Photo post up to 35 images | 1–35 | JPEG/WebP ≤ 20 MB, max 1080p → JPEG/WebP ≤ 20 MB (the 1080p maximum is **not** checked by Relay) |
| YouTube | Video only | Video only | — |
| LinkedIn | Multi-image 2–20 | 2–20 | Fewer than 36,152,320 pixels; JPG/GIF/PNG → same, plus a 10 MB Relay cap |
| Threads | Carousel 2–20 | 2–20, videos allowed | JPEG/PNG ≤ 8 MB, aspect up to 10:1 → same |
| Pinterest | 2–5 images per multi-image Pin — **not verified** | 2–5 | Relay: JPEG/PNG ≤ 20 MB |
| Bluesky | Up to 4 images | 1–4 | ≤ 2,000,000 bytes per image → same; JPEG/PNG/WebP |

## Video

| Network | Network rule | Relay accepts |
|---|---|---|
| Instagram (Reels) | MOV/MP4, H.264/HEVC, AAC, 23–60 fps, ≤ 1920 px wide, aspect 0.01:1–10:1, 3 s–15 min, ≤ 300 MB | Same |
| Facebook Page | Not found on Meta's pages — **not verified** | MP4/MOV, H.264 + AAC, ≤ 15 min, ≤ 300 MB |
| Telegram | Bots can send videos up to 50 MB | ≤ 50 MB, ≤ 15 min, H.264 + AAC |
| X | 0.5 s–20 min (longer for Premium), up to 8 GB, 32×32–1280×1024, aspect 1:3–3:1, ≤ 60 fps, H.264 High + AAC-LC | 0.5 s–15 min, ≤ 300 MB, same dimensions/aspect/fps/codecs |
| TikTok | MP4/WebM/MOV; H.264/H.265/VP8/VP9; 23–60 fps; 360–4096 px each side; up to 10 min via the API (account limits may be lower); ≤ 4 GB | Same; Relay also checks the creator's own maximum when posting |
| YouTube | ≤ 256 GB; 15 min unless the channel is verified (then up to 12 h) | Same (12 h only when YouTube reports long uploads allowed) |
| LinkedIn | MP4, 3 s–30 min, 75 KB–500 MB | Same |
| Threads | MOV/MP4, H.264/HEVC, AAC, 23–60 fps, ≤ 1920 px wide, up to 5 min, ≤ 1 GB | Same |
| Pinterest | **Not verified** | MP4/MOV/M4V, H.264/HEVC, 4 s–15 min, ≤ 2 GB |
| Bluesky | Network supports MP4 up to 300 MB | **Not supported in Relay** |

## Required fields per network

| Network | You must fill in |
|---|---|
| TikTok | **Who can view** (no default) and agreement to TikTok's Music Usage Confirmation (and Branded Content Policy if you mark branded content) |
| YouTube | **Title**, **Privacy** (Public / Unlisted / Private) and **Made for kids** (Yes / No) |
| Pinterest | A board — chosen when you connect (each board is its own connection) |
| Instagram | At least one image or video |
| TikTok, YouTube, Pinterest | Media (text-only posts are not possible) |

## Links and buttons

| Network | How a link is sent |
|---|---|
| Facebook | Separate link field on text posts (preview card); appended to the caption on photo posts |
| Instagram, TikTok | Links are not supported (not clickable in captions) |
| Telegram | Appended to the text, with link preview; optional URL buttons (up to 5, Relay limit; not on albums) |
| X, LinkedIn, Bluesky, YouTube | Appended to the text (Bluesky makes it clickable) |
| Threads | As a link attachment on text-only posts; appended to the text when media is attached |
| Pinterest | Destination link of the Pin (separate field) |
