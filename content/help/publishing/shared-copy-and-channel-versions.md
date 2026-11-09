---
title: Use shared copy and channel versions
summary: Write once in the base content, then give individual channels their own text, link, media, crops and options where needed.
section: publishing
audience: user
roles: [owner, admin, brand_manager, editor]
status: available
related: [create-a-post, crop-images-for-each-channel, check-before-sending, add-images-albums-and-video]
product_version: "2026-11"
reviewed: 2026-11-09
order: 20
keywords: [variant, channel version, network version, custom text, override, per network]
---

Every post has **base content** (shared copy) and one **version per destination**. A version inherits the base content
until you customise one of its parts. What reviewers approve and what each network receives is the resolved version of
each destination.

## Customise one destination

1. In the editor, select the destination in the content switcher (the base content is listed first as **Base content —
   Shared by N destinations**).
2. For each part, choose **Inherited** or **Custom**:
   - **Text** — custom text for this destination only.
   - **Link** — a different link (or none).
   - **Media** — a different set or order of media; **Image required** marks networks that need one.
3. Network-specific fields appear below when the network supports them, for example:
   - **Telegram:** **URL buttons** (label + `https://` link).
   - **TikTok:** *Who can view*, **Allow comments**, **Allow Duet**, **Allow Stitch** (all off until you turn them on;
     photo posts show comments only), disclosure (**Your brand** → *Promotional content*;
     **Branded content** → *Paid partnership*), **AI-generated**, **Photo title** (photo posts, up to 90 characters).
   - **YouTube:** **Title**, **Tags**, **Altered or synthetic content**, and whether *Relay uploads at the scheduled time*
     or you *Let YouTube release it* (uploaded early as private; YouTube publishes at the scheduled time).
   - **Pinterest:** **Board**, **Pin title** (up to 100 characters), **Alt text** (up to 500 characters; empty uses the
     first image's library alt text).
   - **LinkedIn:** **Posting as** (person or organisation), **Visibility** (Anyone / Connections only), **Video title**.
   - Some networks: **Languages** (comma-separated codes, for example `en, de`).
4. Optional: **Crop** images for this destination only (see [Crop images for each channel](/help/publishing/crop-images-for-each-channel)).

Each destination card shows **Ready to send**, **Can't publish: …** with the reason, **Limits unknown** (run **Check** on
Connections to load the account's limits; the server still validates), or *Destination paused — sends after it is resumed*.

## Good to know

- Changing the base content updates every destination that still **inherits** that part; customised parts don't change.
- Removing a destination keeps its custom content in the draft until you save; re-adding it brings it back.
- Exact network rules (lengths, formats, required fields) are in each network's guide in **Social connections**; Relay
  checks them again on the server before sending.

## Limitations

- A post belongs to one brand and can only use that brand's connected accounts. For another brand, create a post there
  (a [template](/help/publishing/templates) helps reuse the text).
