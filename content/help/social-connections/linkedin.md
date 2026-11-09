---
title: Publish to LinkedIn
summary: Connect your LinkedIn profile or a Company Page you administer, publish text, images, multi-image posts and videos, and understand what LinkedIn's approvals and token lifetimes mean for you.
section: social-connections
audience: user
roles: [owner, admin, publisher]
status: needs-provider-approval
related: [connect-social-accounts, connection-status-and-fixes, network-limits-at-a-glance, metrics-by-network, set-up-social-network-apps]
product_version: "2026-11"
reviewed: 2026-11-09
order: 46
keywords: [linkedin, company page, organization, member, profile, community management api, multi-image, video]
sources:
  - title: "LinkedIn — Community Management API overview (vetted product, tiers, r_member_social closed)"
    url: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview
    verified: 2026-11-09
  - title: "LinkedIn — MultiImage API (2–20 images, pixel limit, page roles)"
    url: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api
    verified: 2026-11-09
  - title: "LinkedIn — Videos API (3 s–30 min, 75 KB–500 MB, MP4)"
    url: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
    verified: 2026-11-09
  - title: "LinkedIn — Refresh tokens (60-day access, 365-day refresh, approved partners)"
    url: https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
    verified: 2026-11-09
  - title: "LinkedIn — Share on LinkedIn (w_member_social, self-serve)"
    url: https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
    verified: 2026-11-09
---

## At a glance

| | |
|---|---|
| Status in Relay | Built and tested on a simulated LinkedIn API; **not verified with a live account**. |
| Destinations | Your **member profile**, and **Company Pages** where you are an administrator, content admin or sponsored-content poster (Company Pages need LinkedIn's approval of Relay's app) |
| Formats | Text · Image · Multi-image (2–20) · Video |
| Scheduling | Relay publishes at the scheduled time |
| Edit / delete after publishing | Not possible from Relay |
| Analytics | Company Pages: impressions, unique impressions, clicks, reactions, comments, reposts. Profiles: impressions, members reached, reactions, comments, reposts. Both need LinkedIn's approved permissions. |
| Inbox | Not available (comments need LinkedIn's Community Management approval; LinkedIn has no Page messaging API) |

## Before you start

**Network rules (LinkedIn, verified 2026-11-09):**

- **Profile posting** uses the self-serve *Share on LinkedIn* product (`w_member_social`).
- **Company Page posting** and Page analytics use the **Community Management API**, a *vetted* product: LinkedIn
  approves a Development tier first, then a Standard tier after reviewing a screencast. It must be requested from a
  new developer app that has no other LinkedIn products.
- Organization posting requires the member to hold one of these Page roles: **ADMINISTRATOR**, **CONTENT_ADMIN** or
  **DIRECT_SPONSORED_CONTENT_POSTER**.
- Reading a member's own posts (`r_member_social`) is a **closed** permission; LinkedIn is not accepting requests.
- Access tokens last **60 days**. Refresh tokens (valid for a year) are only issued to approved partners.

**Relay:** Company Pages are offered only after the workspace owner switches on organization posting in **Setup**
(requesting those permissions before LinkedIn approves them makes LinkedIn refuse the sign-in).

## Connect

1. **Connections** ([/accounts](/accounts)) → brand → **Connect** → **LinkedIn**.
2. Sign in and approve. LinkedIn's consent is all-or-nothing.
3. On **Choose destinations**, tick your profile and/or the Company Pages. Pages where you lack a posting role are greyed out.
4. Select **Add**.

## What you can publish

| Format | In Relay | Notes |
|---|---|---|
| Text | Text, link appended | |
| Image | One image | The image's library alt text is sent with it |
| Multi-image | 2–20 images | Images only; each image's alt text is sent |
| Video | One video | Optional **Video title** in the LinkedIn variant |

The LinkedIn variant also has **Visibility**: *Public* or *Connections only*. Connections-only applies to profile posts;
Company Page posts are always public.

## Limits

| Rule | LinkedIn (verified 2026-11-09) | Relay |
|---|---|---|
| Text | 3,000 is widely reported but not stated in the Posts API reference — **not verified** | 3,000 UTF-16 units |
| Images | Fewer than 36,152,320 pixels; JPG, GIF (≤ 250 frames), PNG | Same, plus 10 MB per image (Relay limit) |
| Multi-image | 2–20 images | Same |
| Video | MP4, 3 s–30 min, 75 KB–500 MB | Same |

## Scheduling and publishing

Media is uploaded and processed by LinkedIn first (Relay waits until LinkedIn reports it available), then the post is
created at the due time.

If LinkedIn's answer is lost:

- **Company Pages:** Relay lists the Page's posts since the send time and resolves it automatically.
- **Profiles:** Relay cannot read your posts (closed permission), so the delivery shows **Not confirmed — check before
  retrying**. Check your profile and resolve it in Relay.

## Analytics

Company Pages (organizational share statistics) and profiles (member post analytics) report different metric sets;
Relay keeps them separate. Missing values from LinkedIn's organization statistics are documented by LinkedIn as 0.
See [Metrics by network](/help/analytics/metrics-by-network).

## Reconnect, revoke, disconnect

- LinkedIn sign-ins expire after 60 days; the card shows **Expires soon** beforehand. **Reconnect** before then.
- **Disconnect** deletes the stored sign-in and blocks scheduled posts; posts stay on LinkedIn.
- Revoke Relay on LinkedIn under **Settings → Data privacy → Permitted services**. The menu names are the network's and may change (not verified in a live account).

## Common problems

| Message | Fix |
|---|---|
| Posting permission (w_member_social) was not granted. | Reconnect and approve. |
| LinkedIn: image has … pixels; LinkedIn accepts fewer than 36,152,320. | Resize the image. |
| LinkedIn videos must be at least 75 KB. | Use a longer or higher-quality video. |
| LinkedIn: organization posts are public; "Connections only" applies to member posts. | Set visibility to Public. |
| Invalid scope when signing in | The owner enabled organization posting before LinkedIn approved it; switch it off in Setup. |
