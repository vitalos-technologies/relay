---
title: Reply to Google reviews in the inbox
summary: Bring Google Business Profile reviews for selected locations into the inbox, post or update the owner reply, and understand that customer reviews can never be deleted from Relay.
section: inbox-and-care
audience: user
roles: [owner, admin, care_agent]
status: needs-provider-approval
related: [google-business-profile, inbox-channels-by-network]
product_version: "2026-11"
reviewed: 2026-11-09
order: 40
keywords: [google reviews, business profile, owner reply, rating, location, maps]
sources:
  - title: "Google Business Profile — reviews (list, get, updateReply, deleteReply)"
    url: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews
    verified: 2026-11-09
  - title: "Google Business Profile APIs — prerequisites"
    url: https://developers.google.com/my-business/content/prereqs
    verified: 2026-11-09
---

## Before you start

- Google must have approved Relay's **Business Profile API** access (see [Google Business Profile](/help/business-apps/google-business-profile)).
- Connect Google Business Profile under **Connections → Business apps** and select the **locations**. Each selected
  location becomes an inbox channel for its brand.

> **Important:** Built and tested against a simulated Google API only; not verified with a live location.

## How reviews arrive

Relay lists each location's reviews and keeps a checkpoint so it only picks up new and changed ones. If Google's
review notifications are set up, a notification makes Relay check that location sooner; it does not replace the check.

## Replying

| Action | What it does on Google |
|---|---|
| **Reply** | Posts the public owner reply (Google allows one owner reply per review; replying again updates it) |
| **Edit reply** | Updates the owner reply |
| **Delete reply** | Deletes the owner reply only |

The customer's review itself can **never** be deleted from Relay — Google's API has no method for it. Use Google's own
tools to report a review.

## When a reply's result is lost

Relay reads the review back from Google to see whether the reply landed, before doing anything else.

## Limitations

- Google Business Profile chat was discontinued by Google in July 2024; it is not available.
- Q&A and photos on the profile are not handled.
