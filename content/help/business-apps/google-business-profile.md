---
title: Post to Google Business Profile and read location metrics
summary: Connect Google Business Profile, choose locations, publish local posts from scheduled Relay posts, read 28-day location metrics and answer reviews in the inbox — after Google approves API access.
section: business-apps
audience: user
roles: [owner, admin, brand_manager, publisher]
status: needs-provider-approval
related: [business-apps-overview, google-reviews-in-the-inbox, other-metrics-in-relay]
product_version: "2026-11"
reviewed: 2026-11-09
order: 70
keywords: [google business profile, gbp, google my business, local post, location, reviews, maps, search views, calls, directions]
sources:
  - title: "Google Business Profile APIs — prerequisites (access request, quota 0 until approved)"
    url: https://developers.google.com/my-business/content/prereqs
    verified: 2026-11-09
  - title: "Google Business Profile — localPosts reference"
    url: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts
    verified: 2026-11-09
---

## Before you start (Google's rules, verified 2026-11-09)

- Google must approve **Business Profile API access** for Relay's Google Cloud project (an access request form). Until
  approved the project's quota is **0**; approval raises it to 300 requests per minute.
- To apply, a Business Profile must be verified and active for **60+ days** and list a website.
- Relay requests `business.manage` (plus your email to label the connection).
- Business Profile chat was discontinued by Google in July 2024 and is not offered.

## Connect and choose locations

**Connections → Business apps → Google Business Profile** ([/integrations](/integrations)) → **Connect** → sign in with a
Google account that manages the locations → **Resources** → select **Locations**.

## Local posts

1. Schedule a post as usual (it must pass approval).
2. Composer → **Integrations** card → **Post to locations** → choose up to **10 locations** and type the number of
   locations you chose to confirm.
3. The Google posts follow the post's schedule. At the scheduled time Relay re-runs the approval check for that exact
   revision and your permissions. States: *Waiting for approval*, *Scheduled*, *Processing at Google*, live,
   **Needs review** (the post changed after you requested it — request it again), *Rejected by Google*, *Failed*,
   **Cancelled** (schedule cancelled or rejected) and *Not confirmed*.

Text = the scheduled revision's text, up to **1,500 characters** (Relay limit; Google's reference does not state a
maximum — **not verified**). Deleting a local post is done in Google.

## Location metrics (28 days)

**Settings** tab → **Location metrics (28 days)** → **Refresh** per location. Each value is the **sum of Google's daily
values over the last 28 days** (UTC dates), stored with the time it was fetched:

| Label | Google metric |
|---|---|
| Search views (desktop) | `BUSINESS_IMPRESSIONS_DESKTOP_SEARCH` |
| Search views (mobile) | `BUSINESS_IMPRESSIONS_MOBILE_SEARCH` |
| Calls | `CALL_CLICKS` |
| Website clicks | `WEBSITE_CLICKS` |
| Directions | `BUSINESS_DIRECTION_REQUESTS` |

These are not part of the Analytics pages and are not combined with social metrics. Metrics Google does not return
stay missing. See [Other metrics in Relay](/help/analytics/other-metrics-in-relay).

## Reviews

Reviews of selected locations arrive in **Inbox**; you can post, update or delete the **owner reply** (never the
customer's review). See [Google reviews in the inbox](/help/inbox-and-care/google-reviews-in-the-inbox).

## Disconnect

Deletes Relay's token; local post dispatch and review polling stop; posts stay on Google. Remove Relay in your Google
Account's third-party access settings to revoke it there.
