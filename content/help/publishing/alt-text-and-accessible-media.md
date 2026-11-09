---
title: Add alt text and make posts accessible
summary: Describe images for people using screen readers, and know which networks receive that description.
section: publishing
audience: user
roles: [owner, admin, brand_manager, editor]
status: available
related: [organise-the-content-library, add-images-albums-and-video, profile-appearance-and-accessibility, when-an-approval-is-reset]
product_version: "2026-11"
reviewed: 2026-11-09
order: 32
keywords: [alt text, alternative text, accessibility, screen reader, image description]
---

## Add alt text to a library image

1. Open **Content library** ([/library](/library)) → **Media** and select the image.
2. In **Alt text**, describe what matters in the image in one or two sentences (for example *Barista pouring latte art
   into a blue cup*).
3. Select **Save**. Images without a description show **No alt text** in the library.

Reviewers see each file's alt text next to its name in **Approvals**.

## Where alt text is sent

When a post is published, Relay attaches each image's library alt text to that image, on every network whose API has a
field for it. The library field shows the list under **Alt text** (*Sent to …*).

| Network | What's sent |
|---|---|
| Facebook | Each photo's alt text (single photo and multi-photo posts). |
| Instagram | Single images and the images in a carousel, up to 1,000 characters. Not Reels (Instagram doesn't accept alt text for them). |
| Threads | Images and videos, up to 1,000 characters. |
| X | Each image, up to 1,000 characters. X bills this as a separate request per described image. |
| LinkedIn | Each image. A per-post alt text sent through the API takes priority. |
| Bluesky | Each image. |
| Pinterest | One alt text per Pin: the **Alt text** field in the Pinterest version of the post, or else the first image's library alt text, up to 500 characters. |
| Telegram, TikTok, YouTube | **Not sent.** These networks have no alt-text field. |

Relay sends the text as it is when the post publishes and never shortens it. If it is longer than a network accepts,
the composer's **Readiness** shows *alt text of the image is … of … characters* for that destination; shorten it in
the library (for Pinterest you can also type a Pinterest alt text instead). Alt text is part of what reviewers approve: if you
edit an image's alt text after a post was approved, the post is held until it is approved again (see
[Why an approval was reset](/help/teams-and-approvals/when-an-approval-is-reset)).

## Write accessible posts

- Put important information in the text, not only in an image.
- Use **CamelCase** for multi-word hashtags (#SpringMenu) so screen readers read them correctly.
- Add captions to videos before uploading; Relay doesn't add captions.
- Avoid relying on emoji or colour alone to carry meaning.
