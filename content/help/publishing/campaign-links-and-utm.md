---
title: Build campaign links with UTM parameters
summary: Add consistent UTM tracking to links, optionally shorten them to count clicks in Relay, and see what is measured per campaign.
section: publishing
audience: user
roles: [owner, admin, brand_manager, editor]
status: needs-setup
related: [campaigns-tags-and-owners, feature-flags]
product_version: "2026-11"
reviewed: 2026-11-09
order: 81
keywords: [utm, tracking link, short link, campaign link, clicks, link builder]
---

> **Note:** Campaign links are an optional feature, **off by default**. An Owner or Admin turns on **Campaign short links
> with app-observed clicks** in **Settings → Operations → Feature flags**.

## Set defaults

1. **Settings → Publishing → Campaign links** ([/settings/publishing/links](/settings/publishing/links)).
2. Choose the **Brand** and **Campaign** (or **All campaigns (brand default)**).
3. Fill in the **Brand parameters** or **Campaign parameters** (source, medium, campaign…). Fields left blank show what
   they inherit (*Uses …*). **Save**.

## Add a link to a post

1. In the editor, next to **Link**, open the link builder (**Campaign link**).
2. Enter the **Destination** (`https://…`). The **Final link** shows the parameters added.
3. Select **Use link**, or **Use short link** to count clicks in Relay.

## Measurement

**Campaigns → ⋯ → Measurement** shows, per campaign:

| Row | Source |
|---|---|
| Native social metrics | Network analytics of the campaign's posts. |
| Relay link clicks | Clicks on Relay short links. |
| Website events | *Not connected* — Relay doesn't read your website analytics. |
| Attributed conversions | *Unavailable*. |

## Limitations

- Click counts cover Relay short links only; they're not unique people.
