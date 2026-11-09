---
title: Set up listening searches
summary: Choose which connected channels to monitor and create saved searches for your brand, products or competitors.
section: listening
audience: user
roles: [owner, admin, brand_manager, editor, analyst]
status: not-live-verified
related: [read-listening-results, listening-alerts-and-dashboards, plans-and-features, work-in-the-inbox]
product_version: "2026-11"
reviewed: 2026-11-09
order: 10
keywords: [listening, monitoring, mentions, saved search, keywords, competitors, social listening]
---

## What Relay listens to

| Source | Status |
|---|---|
| **Connected accounts**: public comments, mentions and reviews arriving through your inbox channels | Available. Private messages are **never** included. |
| **Broader listening** (X, YouTube, Bluesky search, news, web, forums) | **Not available.** Shown under *Broader listening* as *Not connected* / *Awaiting activation* with what each would need. No search provider is active in this release. |
| Logged-in scraping, private groups or messages, "complete coverage" | *Never offered.* |

So listening covers what your own connected channels receive. It doesn't search the whole network.

## Who and which plan

- `listening.read` to view (Owner, Admin, Brand manager, Editor, Analyst). `listening.manage` to create searches, alert
  rules and change sources (Owner, Admin).
- **Plan:** listening is part of **Professional**, with a number of active saved searches set by your plan.

## Choose monitored channels

1. **Settings → Listening → Sources** ([/settings/listening/sources](/settings/listening/sources)) or **Listening → Sources**.
2. Under **Connected accounts**, switch **Monitor** on for each inbox channel. Turning it off removes that channel's
   mentions from listening (*Excluded · N mentions removed from listening*); the inbox keeps the messages. Turning it on
   again adds stored items back.

## Create a saved search

1. **Listening** ([/listening](/listening)) → **New search**.
2. Fill in:
   - **Name** and **Brand**; **Type** (for example own brand or competitor).
   - **Names and aliases** — *Comma-separated. Any match counts.* (for example `Northwind, Northwind Coffee, #northwind`).
   - **Keywords** — *Also match any of these.*
   - **Exclude** — *Any of these removes the item* (for example `job, hiring`).
   - **Advanced query** — *Must also match.* `AND`, `OR`, `NOT` (upper case), `"exact phrase"`, `(brackets)`, `prefix*`,
     `#tag`, `@handle`. Up to 500 characters and 50 terms. Errors point to the character position.
   - **Languages** and **Sources** (empty = all monitored).
3. Select **Test** to try it on the last 30 days of stored mentions without saving.
4. **Save**. **Result:** *Search created*. Editing later saves a new version (*Saved as version 2*) and re-matches stored
   mentions; results say which version they used.

Matching is on whole words, ignoring case and accents; a plain word also matches its `#tag` and `@handle`.

## Limitations

- Monitoring starts when a channel was added to the inbox; earlier periods show as *not collected*, never as zero.
- Searches over your plan's allowance are paused (they keep their history) until an admin chooses which stay active.
