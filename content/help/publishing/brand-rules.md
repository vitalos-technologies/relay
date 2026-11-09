---
title: Set brand rules and licence checks
summary: Define prohibited phrases, required footers and disclaimers, approved link domains, a brand profile and media licences that are checked before posts go out.
section: publishing
audience: user
roles: [owner, admin, brand_manager]
status: needs-setup
related: [check-before-sending, approved-knowledge-and-brand-voice, organise-the-content-library, feature-flags]
product_version: "2026-11"
reviewed: 2026-11-09
order: 80
keywords: [brand rules, compliance, prohibited words, disclaimer, footer, licence, logo, governance, brand guidelines]
---

> **Note:** Brand rules are an optional feature, **off by default**. An Owner or Admin turns on **Brand rules editor and
> review list** in **Settings → Operations → Feature flags**.

**Required permission:** `brands.manage` on the brand to edit; everyone can read.

## Add rules

1. Open **Settings → Publishing → Brand rules** ([/settings/publishing/brand-rules](/settings/publishing/brand-rules)),
   choose the brand, tab **Rules**.
2. Select **Add rule**. Choose the **Type**:
   - **Prohibited phrase** / **Discouraged phrase** (with **Use instead**).
   - **Preferred term**.
   - **Required footer** / **Required disclaimer** (*Disclaimer text*).
   - **Approved link domain**.
3. Choose **Severity**: **Mandatory · blocks** or **Advisory · warns**, the **Destinations** it applies to, and an
   optional **Note**. **Save**.

## What rules do

- In the editor, findings appear under **Brand rules** in **Readiness**.
- **Mandatory** findings block submit, schedule and publish until fixed. **Advisory** findings warn.
- Adding or tightening a rule shows already scheduled and draft posts that now break it. For each, choose **Keep**,
  **Will edit** or **Cancel schedule**. *Posts aren't changed* automatically.

## Brand profile

Tab **Profile**: **Tone**, **Default call to action**, **Colours** (name + `#RRGGBB`), **Approved logos** from the library.

## Media licences

Tab **Assets**, or a file's details in the library → **Licence and expiry**: **Ownership** (for example
*User-generated*), **Owner**, **Licence**, **Expires**, **Licence link**, **Status**, **Notes**, **Approved logo**. A post
using an **Expired** file is blocked by brand rules.

## Limitations

- Rules check text, links and media licences; they don't analyse what an image shows.
