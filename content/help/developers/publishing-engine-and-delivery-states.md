---
title: Publishing engine and delivery states
summary: How a schedule becomes per-destination deliveries, how the worker claims, prepares and sends them exactly once, and every delivery state and transition.
section: developers
audience: developer
status: available
related: [provider-adapters, background-jobs-and-media, architecture-and-modules, webhooks]
product_version: "2026-11"
reviewed: 2026-11-09
order: 61
keywords: [state machine, delivery, scheduling, publishing, retry, unknown, reconcile, lease, outbox]
---

## Overview

A post is published to each destination independently. Scheduling a post creates one **schedule** and one **delivery** per destination. Each delivery moves through a state machine (`packages/core/src/state-machine.ts`); every state write in the engine is checked against it. The engine lives in `packages/services/src/engine/` and runs in the worker.

The central rule: **a post that may already have been sent is never sent again automatically.** When the outcome is uncertain the delivery becomes `unknown` and is reconciled read-only.

## From draft to deliveries

One database transaction does all of this, or nothing:

1. Reserve the `Idempotency-Key`.
2. Check authority (`content.schedule` / `content.publish` on the brand and destinations) and the approval policy.
3. Validate the content against every destination's rules.
4. Snapshot the draft into an immutable revision and one immutable variant per destination (unchanged content reuses the latest revision).
5. Supersede any previous schedule of the post (`generation` + 1).
6. Insert the schedule, its deliveries and an outbox `delivery.due` row per delivery.
7. Record the publication authority (who scheduled, which approvals, policy version).

If the brand requires approval, the schedule waits as `pending_approval` without deliveries; the final approval inserts them. An approval is bound to the revision and schedule generation, so editing the post invalidates it.

## Dispatch

- **Outbox → queue.** The worker moves outbox rows to the `delivery-due` pg-boss queue with a deterministic job id; a crash between enqueue and marking cannot duplicate a job.
- **Two claim paths.** A pg-boss consumer handles the wake-up, and claim loops (`WORKER_CONCURRENCY` slots, every second) pick due deliveries straight from the `deliveries` table. A lost wake-up only delays publication.
- **Claim.** `SELECT … FOR UPDATE SKIP LOCKED` takes one due delivery, sets a 90-second lease and increments a **fencing token**; every later write must present the token, so a worker whose lease expired cannot overwrite a newer worker's result. One active claim per connection; throttled connections and open provider circuits are skipped; per-workspace (default 4) and per-network (default 8) live-lease caps keep one tenant or one network from taking every slot, with fair ordering across workspaces.
- **Installation switch.** Nothing is claimed while `system_flags.dispatch_enabled` is `false`. During a rolling deploy `system_flags.dispatch_version` can pin which worker version dispatches.

## Gate, prepare, send

Before preparing, and again inside the send transaction, the engine re-checks: schedule generation, cancellation, deadline (`publish_before`), workspace / brand / account pause, connection status, mock versus live identity, approval, the recorded publication authority, plan entitlements and usage budgets.

- A failed authority check **holds** the delivery (`blocked`, `authority_hold`) until an authorized publisher adopts it; it is never silently sent or cancelled.
- **Prepare** is safe to repeat (for example uploading media or creating an Instagram container) and checkpoints its progress on the delivery, so a restart resumes instead of starting over.
- **Send** is an atomic, fenced transition to `publishing` (phase `sending`). Budgets (for example X writes) are consumed here. Cancellation is guaranteed only before this point.

## Outcomes

| Adapter outcome | Delivery state |
|---|---|
| `confirmed` | `published` (provider ids and link stored) |
| `processing` | `processing`; the claim loop polls the network again when the next check is due |
| `rejected_safe_to_retry` | `retry_wait`, or `failed` / `expired` when attempts or the deadline run out |
| `permanent_failure` | `failed`, or `blocked` when the account needs attention (reconnect, permission, budget, rate limit) |
| `unknown` | `unknown` — never resent automatically |
| `handoff` | `handoff` — a draft waits in the network's app for a person to finish |

**Retries:** at most 5 attempts including the first, after about 30 seconds, 2, 5 and 10 minutes (±20 % jitter). A provider `Retry-After` wins, and no retry is scheduled past the publish-before deadline. Repeated transient failures open a per-network circuit breaker for a short cool-down.

## Sweeps and reconciliation

| Loop (worker) | Interval | What it does |
|---|---|---|
| Lease sweep | 5 s | Expired lease while **preparing** → back to `scheduled`. Expired lease while **sending** → `unknown` (never resent). |
| Deadline sweep | 5 s | `scheduled`, `retry_wait`, `paused` or `blocked` past `publish_before` → `expired`. |
| Reconciliation | 15 s | Checks `unknown` (and `handoff`) deliveries read-only with the network (`adapter.reconcile`), up to 10 automatic checks with backoff. Found → `published`; confirmed absent → `failed` (safe to retry); network cannot be searched (for example Telegram) → stays `unknown` for a person to resolve. |

A person resolves an `unknown` or `handoff` delivery manually (`POST /api/deliveries/<id>/resolve` with `published` + link, or `not_published`). Retrying an `unknown` delivery (`POST /api/deliveries/<id>/retry`) requires `acknowledge_duplicate_risk: true` and is audited.

## Pause

Workspace, brand and account pauses are checked at dispatch. Nothing new is sent after the pause commits; a request already sending may complete. Not-started deliveries move to `paused`. On resume, deliveries still within their deadline return to `scheduled`; the rest become `expired` instead of being flooded out. For provider-held releases (YouTube scheduled publication) a pause attempts remote cancellation and reports the residual risk if it cannot be confirmed.

## Provider-scheduled releases

For networks that can hold a release themselves (YouTube `publishAt`), the delivery is dispatched early (up to `PROVIDER_EARLY_UPLOAD_MINUTES`, default 180) so upload and processing finish in time, and the network releases it at the scheduled time. If too little lead time remains, Relay publishes at the due time itself — recorded on the delivery, never early.

## States and transitions

| State | Label in the app | Next states |
|---|---|---|
| `scheduled` | Scheduled | preparing, blocked, paused, cancelled, expired, failed |
| `preparing` | Preparing | publishing, retry_wait, scheduled, processing, blocked, paused, cancelled, expired, failed |
| `publishing` | Publishing | published, processing, unknown, retry_wait, failed, blocked, handoff |
| `processing` | Processing | published, unknown, failed, processing, cancelled, handoff |
| `retry_wait` | Retrying soon | scheduled, preparing, failed, expired, cancelled, paused, blocked |
| `blocked` | Blocked | scheduled, cancelled, expired, failed |
| `paused` | Paused | scheduled, cancelled, expired |
| `unknown` | Unknown — needs review | published, failed, scheduled (manual retry with acknowledgement), handoff |
| `handoff` | Manual handoff | published, failed, handoff |
| `failed` | Failed | scheduled (manual retry) |
| `published`, `cancelled`, `expired` | Published, Cancelled, Expired | — (terminal) |

A scheduled or retrying delivery more than 2 minutes past its dispatch time is shown as **Overdue** (the worker is stopped or backlogged).

The post's overall status is derived from its deliveries and never hides failures: `published` (all published), `cancelled`, `expired`, `needs_attention` (any unknown, blocked or handoff), `publishing` (anything in flight), `partial` (some published, the rest failed or cancelled), `failed`, otherwise `scheduled`.

## Related

- [Provider adapter contract](/help/developers/provider-adapters)
- [Background jobs and media processing](/help/developers/background-jobs-and-media)
- [Webhooks](/help/developers/webhooks)
