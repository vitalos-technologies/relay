---
title: Background jobs and media processing
summary: The worker's queues, workload classes and periodic sweeps, how jobs get from the outbox to pg-boss, and how uploaded images and videos are validated and processed.
section: developers
audience: developer
status: available
related: [publishing-engine-and-delivery-states, architecture-and-modules, analytics-ingestion, content-source-imports-and-exports]
product_version: "2026-11"
reviewed: 2026-11-09
order: 62
keywords: [worker, jobs, queue, pg-boss, outbox, sweeps, media, video, images, upload, ffmpeg]
---

## From the outbox to a job

1. A service writes its change and an **outbox** row (`event_type`, `aggregate_id`, `workspace_id`, small payload) in the same transaction. If the transaction rolls back, no job exists.
2. Every second the worker's outbox loop takes pending rows (`FOR UPDATE SKIP LOCKED`, 50 at a time) and sends each to its pg-boss queue with a job id derived from the outbox id (UUID v5). It then marks the row `dispatched`. If the worker dies in between, the next pass sends the same id again and pg-boss ignores the duplicate.
3. A row that cannot be enqueued is retried every 30 seconds and becomes `dead` after 10 failed attempts. Workspace admins see dead-lettered events in the admin console and can requeue the safe types (`delivery.due`, `asset.uploaded`, `source.import_requested`, `export.requested`, `bulk.requested`).
4. Job handlers receive **ids only**. They reload rows and re-check the requester's current authority before acting; a job never trusts its payload.

pg-boss queues are created with 5 retries, a 10-second base delay and exponential backoff. Dispatched outbox rows are deleted after 30 days.

## Queues

| Queue | Fed by | Workload class |
|---|---|---|
| `delivery-due` | `delivery.due` | publishing |
| `events` | other events (notifications, engine hooks) | notifications |
| `collab-notify` | comments, mentions, tasks, review requests and decisions | notifications |
| `media-transcode` | `asset.uploaded` (video) | video |
| `source-import` | `source.import_requested`, `source.changes_signal` | interactive import |
| `writeback` | `writeback.requested` | interactive import |
| `report-export` | `export.requested` (Content Hub destinations) | report export |
| `analytics-sync`, `analytics-report-export` | analytics tick, report requests | analytics refresh, report export |
| `bulk-ops` | `bulk.requested` | interactive import |
| `inbox-reply` | `inbox.reply_requested` | customer reply |
| `inbox-events` | inbox messages, assignments, notes, cases, listening alerts | inbox ingest |
| `integration-sync` | business-app events and sync requests | integration sync |
| `listening-ingest` | listening ingest and re-match requests | listening ingest |
| `ai-assist` | `ai.run_requested` | AI assist |

## Workload classes

Each class has a per-worker concurrency cap and a per-workspace cap, so no tenant monopolises a class. Classes on the **bulk** pool use a separate database pool (`WORKER_BULK_POOL_MAX`, default 6) and the deferring classes wait (up to 60 seconds) while publishing is under pressure (due work older than `PUBLISHING_PRESSURE_DUE_AGE_SECONDS`, default 10).

| Class | Max concurrent | Per workspace | Pool | Defers for publishing |
|---|---|---|---|---|
| publishing | `WORKER_CONCURRENCY` (4) | same | main | no |
| connection_health | 1 | 1 | main | no |
| notifications | 2 | 2 | main | no |
| customer_reply | 4 | 2 | main | no |
| inbox_ingest | 2 | 2 | main | no |
| interactive_import | 2 | 1 | bulk | no |
| ai_assist | 2 | 1 | bulk | no |
| analytics_refresh | 2 | 1 | bulk | yes |
| historical_backfill | 1 | 1 | bulk | yes |
| video | 1 | 1 | bulk | yes |
| report_export | 2 | 1 | bulk | yes |
| integration_sync | 2 | 1 | bulk | yes |
| listening_ingest | 1 | 1 | bulk | yes |

Override with `WORKLOAD_<CLASS>_CONCURRENCY` and `WORKLOAD_<CLASS>_PER_WORKSPACE`. The worker's `/ready` endpoint and the Operations page show live class usage.

## Periodic loops

| Loop | Every | Purpose |
|---|---|---|
| heartbeat | 10 s | `worker_heartbeats` row with in-flight work and last loop runs |
| outbox | 1 s | Outbox → pg-boss (above) |
| claim slots | 1 s | Claim due deliveries directly from the table |
| sweep | 5 s | Expired leases and publish-before deadlines |
| reconcile | 15 s | Unknown deliveries, read-only |
| mcp-jobs, workload-samples | 5 s | MCP report exports; workload timing samples |
| analytics, bulk-jobs | 30 s | Analytics cursors and exports; resume interrupted bulk jobs |
| budget-sweep, billing-sweep, notification-emails, collab-sweeps, support-sweeps | 60 s | Expired usage reservations; billing webhook retries, trials and provider reconciliation; deferred emails and digests; reminders and offboarding; support access expiry |
| content-hub | 2 min | Writeback, Drive channel renewal, snapshot retention |
| entitlement-holds, grant-expiry | 5 min | Re-evaluate held work after plan changes; revoke expired grants |
| health | 10 min | Connection health checks (25 per run) |
| retention, trash-purge | 1 h | Webhook bodies after 7 days; expired idempotency keys; OAuth states and connection flows a day after expiry; sessions 7 days after expiry; dispatched outbox after 30 days; old heartbeats; collaboration retention; trash past retention |

Inbox, integrations, listening and AI register further loops of their own (polling cursors, SLA timers, reply recovery).

## Shutdown and restarts

On `SIGTERM` the worker stops its loops, waits up to 30 seconds for in-flight work, stops pg-boss gracefully and exits. Work still in flight keeps its lease; the lease sweep later returns preparing work to `scheduled` and turns anything that was sending into `unknown`. Running several workers is safe: claims, leases and fencing tokens prevent double processing.

## Images

1. The browser asks for an **upload intent** (rate-limited, 30 per minute per person) and gets a presigned storage POST with a size range. The file goes straight to the private bucket.
2. Completing the upload runs validation in the web process (`packages/services/src/media/process.ts`):
   - the real type is sniffed from the bytes; only JPEG and PNG are accepted and must match the declared type;
   - data appended after the image (ZIP, HTML, script, PDF, executables) is rejected;
   - the image is decoded with a pixel limit (decompression-bomb guard); any decode error rejects it;
   - derivatives (`thumb` 400 px and `preview` 1600 px WebP, and a `jpeg_publish` JPEG up to 4096 px that networks receive) are re-encoded from decoded pixels, auto-oriented, sRGB, with all metadata removed.
3. Originals are never served. Browsers and networks get short-lived signed URLs, only after authorization.

## Videos

1. The upload is stored and **quarantined**; the web request only writes an `asset.uploaded` outbox row.
2. The worker (`video` class, one at a time) runs `ffprobe` and `ffmpeg` directly (no shell, argument arrays, wall-clock timeout, output caps, `-protocol_whitelist file` so a crafted file cannot open network URLs).
3. It extracts a poster frame and produces a publish file every network accepts: MP4, H.264 High + AAC-LC, yuv420p, 23–60 fps, at most 1280×1024 in either orientation, `moov` atom first, metadata (GPS, device) stripped. Compatible files are remuxed; others are transcoded within time limits.
4. The asset becomes `ready` or `rejected` with a reason. Storage failures throw so pg-boss retries; after repeated failures the asset is rejected.

Files imported from Google Drive or Notion go through exactly the same validation path as browser uploads.

## Related

- [Publishing engine and delivery states](/help/developers/publishing-engine-and-delivery-states)
- [Analytics ingestion](/help/developers/analytics-ingestion)
- [Content source imports and exports](/help/developers/content-source-imports-and-exports)
