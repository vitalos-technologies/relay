---
title: Architecture and modules
summary: How Relay is built — one web app, one background worker, PostgreSQL for state and queues, and four shared packages.
section: developers
audience: developer
status: available
related: [local-development-setup, publishing-engine-and-delivery-states, background-jobs-and-media, data-model-and-migrations]
product_version: "2026-11"
reviewed: 2026-11-09
order: 10
keywords: [architecture, monorepo, packages, worker, design]
---

## Overview

Relay is a modular monolith in one pnpm workspace. Two processes run the product:

| Process | Code | What it does |
|---|---|---|
| Web | `apps/web` (Next.js 16 App Router, webpack build) | Pages, the HTTP API under `/api`, the MCP endpoint `/mcp`, OAuth callbacks and webhooks. |
| Worker | `apps/worker` (one esbuild bundle, `dist/main.mjs`) | Publishing, retries, reconciliation, media processing, analytics sync, imports/exports, notifications, billing sweeps and retention. |

Both processes share the same domain code and the same PostgreSQL database. There is no Redis, Kafka or separate microservice: PostgreSQL holds the application state **and** the durable job queue (pg-boss, schema `pgboss`).

External dependencies:

| Dependency | Purpose | Local stand-in (`infra/compose.yaml`) |
|---|---|---|
| PostgreSQL 16 | State, transactional outbox, pg-boss queues, shared rate-limit buckets | `postgres` container on port 54329 |
| S3-compatible object storage | Private media originals and derivatives, exports | SeaweedFS on port 8333 |
| OpenID Connect identity provider | Sign-in, two-step verification, step-up, back-channel logout, MCP OAuth tokens | Keycloak 26.4, realm `social-lite`, port 5556 |
| SMTP | Invitations, alerts, digests | Mailpit (SMTP 1025, UI 8025) |
| Social network and business-app APIs | Publishing, analytics, inbox, listening, integrations | Simulated `mock_` destinations when `ENABLE_MOCK_PROVIDERS=true` |

## Packages

| Package | Path | Responsibility | Depends on |
|---|---|---|---|
| `@social-lite/core` | `packages/core/src` | Pure domain code, no IO: types, zod schemas, validation, text counting, time zones, the delivery state machine, the retry policy, the authorization policy (`authz.ts`), the provider adapter contracts (`adapter.ts`) and shared DTO contracts (`contracts/*`). | — |
| `@social-lite/db` | `packages/db/src` | Connection pools, the migration runner and CLI, database role checks. Migrations live in `packages/db/migrations`. | — |
| `@social-lite/providers` | `packages/providers/src` | One adapter per network (`meta`, `telegram`, `x`, `tiktok`, `youtube`, `linkedin`, `threads`, `pinterest`, `bluesky`) plus inbox/business connectors (`whatsapp`, `google-business`, `asana`, `monday`, `hubspot`, `slack`, `mailchimp`, `google-translate`, `stripe`). The registry hands out adapters and transports. | core |
| `@social-lite/services` | `packages/services/src` | Every domain service: tenancy and access, posts and scheduling, the publishing engine, media, analytics, Content Hub, collaboration, inbox, listening, AI and automation, MCP, billing, entitlements, support and the widget, the admin and platform consoles, and the Help Centre library. | core, db, providers |

The web app and the worker never talk to provider APIs or the database directly for business logic: they call services. Route handlers are thin (parse, call one service function, return JSON).

## Request path (web)

1. `apps/web/proxy.ts` sets per-request security headers (nonce-based CSP, frame and referrer policies; HSTS in production).
2. A route handler under `apps/web/app/api/**/route.ts` is wrapped by one of the wrappers in `apps/web/lib`:
   - `route()` — session cookie, CSRF check on mutations, active workspace access (`Ctx`);
   - `platformRoute()` — Relay staff with a platform operator role (everyone else gets 404);
   - `publicRoute()` — no session (callbacks, webhooks, health);
   - `machineRoute()` — service-account API keys for `/api/v1/*`;
   - `widgetRoute()` — the support widget (member or visitor session).
3. The service enforces permissions with the central policy (`requireAction` / `authorizeCtx`), scopes every query by `workspace_id` and the caller's brand grants, and writes audit events and outbox rows in the same transaction as the change.
4. Errors leave as one envelope: `{ "error": { "code", "message", "fieldErrors"?, "details"? }, "correlation_id" }` with an `x-correlation-id` header.

See [Authentication and authorization](/help/developers/authentication-and-authorization) and [API conventions](/help/developers/api-conventions).

## Background work (worker)

State changes that need follow-up work write an **outbox** row in the same transaction. The worker moves outbox rows to pg-boss queues with a deterministic job id, so a crash between "enqueue" and "mark dispatched" cannot create duplicates. Publishing never depends on the queue alone: a claim loop also picks up due deliveries directly from the `deliveries` table.

Work is split into **workload classes** (publishing, connection health, notifications, imports, analytics refresh, backfill, video, report export, customer replies, inbox ingest, integration sync, listening ingest, AI assist) with per-class and per-workspace concurrency caps. Bulk classes use a separate database pool and back off while publishing is under pressure. Details: [Background jobs and media processing](/help/developers/background-jobs-and-media).

## Data and tenancy

Every customer row carries `workspace_id`. Many tables use composite foreign keys `(workspace_id, id)` so a row cannot point at another workspace's data. Content is versioned: drafts are mutable, but submitting, scheduling or publishing snapshots an immutable revision and one immutable variant per destination. See [Data model and migrations](/help/developers/data-model-and-migrations).

The database is used through three least-privilege roles: the migrator (DDL), the web app and the worker (DML only; the audit log is append-only).

## Security boundaries

- Provider credentials are envelope-encrypted (AES-256-GCM per secret, wrapped by a key-encryption key from `KEY_ENCRYPTION_KEYS` or a KMS), bound to their purpose and never returned to browsers or MCP clients.
- Live connections always use the HTTPS transport, restricted to an allow-list of provider hosts with no redirects. Simulated (`mock_`) connections use an in-process simulator and only when mock providers are enabled outside production. A live connection can never receive the simulator.
- Production refuses to start with development settings (mock providers, insecure OIDC, local storage or email, the development key).

## Where to go next

- [Set up a local development environment](/help/developers/local-development-setup)
- [Publishing engine and delivery states](/help/developers/publishing-engine-and-delivery-states)
- [Provider adapter contract](/help/developers/provider-adapters)
- [API route reference](/help/developers/api-route-reference)
- [Connect an MCP client](/help/developers/mcp-server)
