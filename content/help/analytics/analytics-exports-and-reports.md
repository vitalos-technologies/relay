---
title: Export analytics
summary: Export the current Analytics view as CSV or PDF with a manifest that records the filters, period, definitions and coverage; limits, expiry and who can export.
section: analytics
audience: user
roles: [owner, admin, exporter]
status: available
related: [use-analytics, analytics-metric-dictionary, export-to-google-docs-drive-and-notion]
product_version: "2026-11"
reviewed: 2026-11-09
order: 100
keywords: [export, csv, pdf, download, report, manifest, saved report]
---

## Export the current view

1. Open the view (Overview, Content, Channels, Video, Audience or Workflow) and set the filters.
2. Select **Export** → **CSV** or **PDF**.
3. Relay builds the file in the background and downloads it when ready (usually seconds). If it takes longer you see
   **Export queued**; it finishes in the background.

**Who:** the **Exporter**, **Admin** or **Owner** role, plus Analytics access to every brand in the export. Your
workspace's security policy may ask you to confirm your identity again before exporting.

## What's in the file

Every export starts with a **manifest**: title, view, brands and accounts, the exact filters, time zone and period, data
set (live, simulated or demo), measure definitions, observation times, the *Complete through* time and coverage. Then
the view's tables, for example:

| View | Tables |
|---|---|
| Overview | KPIs (value, basis, previous value, change, comparison state, status, coverage), trend per day, channels, top content, calculated observations |
| Content | Every post in scope (up to 5,000 rows) with its metrics |
| Channels | One row per account and native metric with status, coverage and observation time |
| Video | Totals, by network, formats |
| Audience | Breakdowns with buckets, shares and suppressed counts |
| Workflow | Team and workflow facts |

- Missing values are **blank**, never 0.
- Text cells are protected against spreadsheet formula injection (cells starting with `=`, `+`, `-`, `@` are prefixed).
- **PDF** is rendered on the server. If PDF rendering is unavailable, Relay delivers **HTML** instead and says
  "Delivered as HTML".

## Limits

| Limit | Value |
|---|---|
| Rows | 5,000 |
| File size | 20 MB |
| Download link | expires after **7 days** (the file is then deleted) |
| Rate | about 10 exports per hour per person |
| Plan | Exports count towards your plan's export allowance (**Settings → Operations → Usage and limits**) |

When the export job runs, Relay re-checks your **current** access; if you lost access to a brand in the meantime the
export fails with *access revoked* instead of including it.

## Saved reports and external destinations

Relay's API can save a view's filters as a named report (private or shared with the workspace) and deliver an export
to a Google Doc, Drive file or Notion page. The Analytics screen does not offer these yet; bookmarking the view's
address gives you the same filters.
