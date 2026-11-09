---
title: Analytics ingestion and aggregation
summary: How Relay reads metrics from each network, stores them idempotently as observations and facts, rolls them up by time zone and keeps unsupported, missing and stale data distinct.
section: developers
audience: developer
status: available
related: [background-jobs-and-media, provider-adapters, data-model-and-migrations, mcp-tool-reference]
product_version: "2026-11"
reviewed: 2026-11-09
order: 64
keywords: [analytics, metrics, ingestion, sync, rollups, aggregation, reports, insights]
---

## Pipeline

```text
network API ─► sync run (per connection cursor)
             ─► metric_observations      raw points, deduplicated on a fact key
             ─► metric_cumulative_facts  lifetime / snapshot series (as-of values)
                metric_daily_facts       per-day values the network reports, plus labelled observed changes
             ─► metric_resource_latest   latest value per post or account
             ─► metric_rollups           15-minute buckets, recomputed per touched bucket
             ─► metric_rollup_days       per local day and time zone (kept in step by triggers)
             ─► data_coverage            supported? fetched? fresh? per destination
```

Code: `packages/services/src/analytics/` (`sync.ts`, `ingest.ts`, `cadence.ts`, `query.ts`, `semantics.ts`, `summary.ts`, `reports.ts`, `retention.ts`). Metric names and which networks report them come from the provider metric registry (`packages/providers/src/metrics.ts`) and `metric_definitions`.

## Sync

- One **cursor** per connection and stream (`sync_cursors`) holds a keyset position (published time, delivery id) and is checkpointed after **every** item, so an interrupted run resumes where it stopped.
- The worker's analytics tick (every 30 seconds) evaluates cursors and enqueues due runs on `analytics-sync`. A lease allows one runner per connection; at most `ANALYTICS_WORKSPACE_CONCURRENCY` (default 2) connections per workspace sync at once.
- Runs are idempotent per job key (`sync_runs.job_key` is unique): a redelivered job never starts a second run.
- **Publishing keeps priority.** A run pauses (checkpointed) while `ANALYTICS_YIELD_DUE_DELIVERIES` (default 25) or more deliveries are due, and the class defers under publishing pressure.
- **Authority is re-checked** when the job runs and before every item. A disconnected, revoked or reconnect-required connection, an archived brand or a suspended workspace stops the cursor with a reason; the queue payload is never trusted on its own.
- Backfill is bounded by `ANALYTICS_BACKFILL_DAYS` (default 90, maximum 365) and by what each network can still report.

## Refresh cadence

Lifetime counters settle over time, so young posts are read often and older posts rarely. After the horizon a post's last observation is final, not "stale".

| Policy | Young posts | Up to 14 days | Horizon | After the horizon |
|---|---|---|---|---|
| Default | every 6 h for the first 48 h | every 24 h | 90 days | weekly |
| X (reads are billable) | every 12 h for the first 48 h | every 48 h | 30 days | weekly |

Failures back off exponentially; permanent states (missing permission, deleted content) stop until something changes, such as a reconnect.

## Ingestion rules

- **Idempotent:** observing the same point again adds nothing. A different value for the same fact key updates the row (revision + 1, previous value kept).
- **Late data:** an older observation that arrives late never overwrites a newer one.
- **Validation:** unknown metric names, non-finite or negative values are rejected and counted — never stored, and never turned into zero.
- **Datasets never mix:** live data, simulated (`mock_`) destinations and the demo workspace are separate sources; live views never include simulated rows.

## Aggregation semantics

Pure functions in `semantics.ts`, covered by unit tests:

- Periods are inclusive local dates in an IANA time zone, converted to UTC at local midnights (23- and 25-hour days around daylight saving changes are handled).
- Comparisons: a zero baseline is "new"; a missing or insufficient baseline is "insufficient" (never an infinite percentage).
- Only compatible values combine. Unique counts such as reach are **never** added across networks or accounts. Ratio metrics are never summed. Snapshot values are never summed over dates. Engagement rate = sum of numerators ÷ sum of denominators over the posts that report both.
- Statuses stay distinct: zero, unsupported, permission missing, not fetched yet, stale, provider delayed, partial coverage, fetch failed.

The analytics dictionary for people (what each metric means and how to read it) is in the Analytics section of the Help Centre.

## Reports and exports

Saved views store filter state only and re-check access when opened. Exports run as jobs on `analytics-report-export` (one per workspace at a time): they need `analytics.read` and `exports.create` on every brand in scope, count towards the export budget, re-load the requester's current grants when the job runs and fail with `access_revoked` if access was lost. Formats: CSV (protected against spreadsheet formula injection), HTML and PDF (server-side Chromium when available, otherwise HTML with a note; `ANALYTICS_PDF=off` disables PDF). Exports to Google Docs, Drive or Notion go through the Content Hub exporter.

## Retention

| Case | What happens |
|---|---|
| Post deleted on the network | Refresh stops; the last observed values stay, labelled. |
| Post deleted in Relay | Its facts are removed and the affected rollups recomputed. |
| Account disconnected | Sync stops at once; history stays visible, labelled "access ended", for `ANALYTICS_DISCONNECTED_RETENTION_DAYS` (default 90), then is purged. |
| Raw observations | Kept `ANALYTICS_RAW_RETENTION_DAYS` (default 400); normalized facts stay with the account. |

## Related

- [Background jobs and media processing](/help/developers/background-jobs-and-media)
- [MCP tool reference](/help/developers/mcp-tool-reference) (analytics tools use the same query service)
