---
title: Export a brand's data
summary: Download a client handover of a brand's posts, revisions, delivery history and media list as ZIP or JSON.
section: administration
audience: user
roles: [owner, admin, exporter]
status: available
related: [audit-log, delivery-history, usage-and-limits]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [export, download data, backup, handover, gdpr, data portability, zip]
---

**Required:** `exports.create` on the brand (Owner, Admin, Exporter). Counts toward your export allowance; at most 3 per hour.

1. Open **Settings → Operations → Data export** ([/settings/operations/export](/settings/operations/export)) and choose the brand.
2. **Client handover** — *This brand's posts, every revision, delivery history and media list with download links valid
   for 15 minutes.*
3. Choose **Format**: **ZIP** or **JSON**, and select **Export**.
4. **Result:** *Handover export downloaded*. The export is recorded in the audit log.

Download the media from the links within 15 minutes; after that, export again.

## Other exports

| What | Where |
|---|---|
| Delivery history (CSV) | Planner → History → **CSV** |
| Audit log (CSV) | Audit log → **Export CSV** |
| Analytics | See the **Analytics and reporting** section |

## Limitations

- Exports never include passwords, tokens or account credentials.
- Deleting a whole workspace isn't self-service; contact Relay support.
