---
title: Publish to a Facebook Page
summary: Connect Facebook Pages you manage, publish text and link posts, photos, multi-photo posts and videos, read post insights and answer Messenger and comments.
section: social-connections
audience: user
roles: [owner, admin, publisher]
status: needs-provider-approval
related: [connect-social-accounts, instagram, connection-status-and-fixes, network-limits-at-a-glance, metrics-by-network, inbox-channels-by-network, set-up-social-network-apps]
product_version: "2026-11"
reviewed: 2026-11-09
order: 41
keywords: [facebook, page, meta, multi-photo, page video, link post, messenger, page publishing authorization]
sources:
  - title: "Facebook — Page Photos reference (formats, 10 MB, tasks, permissions)"
    url: https://developers.facebook.com/docs/graph-api/reference/page/photos/
    verified: 2026-11-09
  - title: "Facebook — Insights reference (Page post metrics, delays, retention)"
    url: https://developers.facebook.com/docs/graph-api/reference/insights
    verified: 2026-11-09
  - title: "Meta — Permissions reference (App Review, Business Verification)"
    url: https://developers.facebook.com/docs/permissions
    verified: 2026-11-09
  - title: "Meta — Graph API versions"
    url: https://developers.facebook.com/docs/graph-api/changelog/versions
    verified: 2026-11-09
---

## At a glance

| | |
|---|---|
| Status in Relay | Built and tested on simulated Facebook; **not verified with a live Page**. Other people's Pages can connect only after Meta App Review. |
| Destination | One Facebook **Page** per connection (not personal profiles, not groups) |
| Formats | Text (with link preview) · Single photo · Multi-photo (2–10 photos) · Video |
| Scheduling | Relay publishes at the scheduled time (Facebook's own scheduler is not used) |
| Edit / delete after publishing | Not possible from Relay |
| Analytics | Post insights (views, viewers, clicks, reactions) — needs the insights permission |
| Inbox | Messenger conversations and Page post comments (needs a separate Meta approval) |

## Before you start

**Network rules (Meta, verified 2026-11-09):**

- Posting a photo needs a Page access token of a person who can perform the **CREATE_CONTENT** task on the Page, and
  the permissions `pages_manage_posts`, `pages_read_engagement` and `pages_show_list`. Relay also accepts the MANAGE task.
- Post insights need `read_insights` and `pages_read_engagement`, from a person with the **ANALYZE** task.
- For Pages managed by people who are not app testers, Meta must approve each permission in **App Review**; Advanced
  Access requires **Business Verification**.

**Relay setup:** the workspace owner configures the Meta app ([Set up the social network apps](/help/social-connections/set-up-social-network-apps)).
The insights permission is requested only when the owner has switched it on in **Setup** after Meta's approval.

## Connect

1. **Connections** ([/accounts](/accounts)) → brand → **Connect** → **Facebook**.
2. Sign in to Facebook and approve every permission; when Facebook asks which Pages to share, include the Pages you need.
3. On **Choose destinations**, tick the Pages. Pages where you lack a posting task are greyed out.
4. Select **Add**.

## What you can publish

| Format | In Relay | How it is sent |
|---|---|---|
| Text / link | Text, optional link | Feed post; the link is sent as Facebook's separate link field so a preview card appears |
| Photo | One image | Photo post; the link (if any) is appended to the caption |
| Multi-photo | 2–10 images (Relay limit — Meta documents no maximum) | Photos are uploaded unpublished first, then attached to one post |
| Video | One video | Page video; Facebook processes it before it appears |

## Limits

| Rule | Facebook | Relay |
|---|---|---|
| Text | No limit found in Meta's documentation (**not verified**; 63,206 is widely reported) | 10,000 code points |
| Photo | JPEG, BMP, PNG, GIF, TIFF up to 10 MB (PNG under 1 MB recommended) | JPEG/PNG up to 10 MB |
| Multi-photo | Not documented | 2–10 photos, no videos |
| Video | Size and length limits not found on Meta's pages (**not verified**) | MP4/MOV, H.264 + AAC, ≤ 15 min, ≤ 300 MB |

## Scheduling and publishing

Relay publishes at the due time. For multi-photo posts, the photos are staged as unpublished photos (Facebook deletes
unused ones after about a day; Relay re-stages them when needed). Videos show **Processing** until Facebook reports
them ready. If an answer is lost, Relay searches the Page's recent posts for yours before deciding; it never posts again
blindly.

## Analytics

**Views** (`post_media_view`), **Viewers** (`post_total_media_view_unique`, unique), **Clicks** (`post_clicks`) and
**Reactions by type**, all lifetime values per post. Meta says most metrics update once every 24 hours and only the
last two years are available. Meta deprecated `post_impressions*` above Graph API v25, which is why Relay uses the
"media view" metrics. Values include paid distribution if the post was boosted. See
[Metrics by network](/help/analytics/metrics-by-network).

## Inbox

Messenger conversations and comments on Page posts can be answered in **Inbox** once Meta approves `pages_messaging`,
`pages_manage_engagement` and `pages_read_user_content` and the owner switches inbox permissions on. Messenger replies
are allowed within 24 hours of the customer's last message (7 days with Meta's Human Agent feature).
See [Inbox channels by network](/help/inbox-and-care/inbox-channels-by-network).

## Limitations

- Personal profiles, groups and events are not supported.
- No editing or deleting published posts; no Stories; no Reels on Facebook (video posts are Page videos).
- Multi-photo posts cannot include videos.

## Reconnect, revoke, disconnect

- **Reconnect** to grant missing permissions or when access was lost. Page access stops working when the person who
  connected loses their Page task, changes their Facebook password or removes the app.
- **Disconnect** deletes the stored sign-in and blocks scheduled posts; published posts stay on Facebook.
- To revoke Relay on Facebook's side, remove the app in Facebook **Settings → Business integrations**. The menu names are the network's and may change (not verified in a live account).

## Common problems

| Symptom | Cause | Fix |
|---|---|---|
| Page greyed out when connecting | You don't have a content-creation task on it | Ask a Page admin for access, then reconnect |
| Missing permission (`pages_manage_posts` …) | A permission was declined | Reconnect and approve all |
| Analytics show *missing permission* | Insights permission not granted (or not yet requested by the app) | Owner enables insights after Meta's approval; reconnect |
| Duplicate post rejected | Facebook thought an earlier attempt already posted it | Relay treats this as *Unknown* and checks the Page; resolve after checking |
| Policy block | Facebook restricted the post or Page | Fix on Facebook; Relay cannot override it |
