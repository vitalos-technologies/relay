---
title: Translate messages and posts with Google Cloud Translation
summary: Turn on machine translation for the workspace, understand per-character billing and Relay's cost estimate, protect links and names, and use translations without anything being sent automatically.
section: business-apps
audience: user
roles: [owner, admin, care_agent, editor]
status: needs-setup
related: [business-apps-overview, inbox-channels-by-network]
product_version: "2026-11"
reviewed: 2026-11-09
order: 80
keywords: [translate, translation, google cloud, machine translation, glossary, language, billing, characters]
sources:
  - title: "Google Cloud Translation pricing (official page, via search result text)"
    url: https://cloud.google.com/translate/pricing
    verified: 2026-11-09
---

## Before you start

- The workspace owner provides a Google Cloud project with the Cloud Translation API enabled, **billing on**, and a
  service account in **Setup**. Glossaries need Translation Advanced (v3).
- **Google's price (official pricing page, 2026-11-09):** the first 500,000 characters per month are free (a monthly
  credit shared by Basic and Advanced); then **USD 20 per million characters** for standard translation. Other
  Google translation products are priced differently. Check the page before relying on these numbers.

## Turn it on (workspace)

**Connections → Business apps → Google Cloud Translation** ([/integrations](/integrations)) → **Settings** (Owner or Admin,
workspace scope):

1. Turn translation **on** and **acknowledge per-character billing**.
2. Separately allow translation of **customer messages and reply drafts** if you want it in the inbox.
3. Set the **Monthly limit (characters)** and optionally a **Glossary**.

The settings show usage and a cost estimate: characters sent × the list price (USD 20 per million by default; the
owner can change it). The free 500,000 characters are **not** subtracted, so the estimate never understates cost.

## Using translations

| Where | Who | What you get |
|---|---|---|
| Inbox → customer panel → **Translate** | Inbox access | The latest customer message, translated |
| Inbox reply draft | Can reply | The exact outgoing text for review, to **copy** — never inserted or sent automatically |
| Composer post text | Can edit content | A translation of the post text |
| Listening results | Listening access | Translated mentions |

Every result is labelled **Machine translated** with source → target language, and the original is always kept and
never modified. Links, @mentions, #hashtags, `{{placeholders}}`, merge tags and the brand name are protected and
restored exactly. Identical requests reuse the stored translation (no second charge).

## Turn it off

Switch translation off in **Settings**. Stored translations stay as a usage record for the workspace lifetime.
In demo environments, the simulated service returns `[Simulated → xx] <original>` and translates nothing.
