# CH — Content Hub progress (resume here after restart)

Started 2026-11-07. Migration: packages/db/migrations/016_v3_content_hub.sql (only).

## Status
- [x] 0. Read docs/code (connections, media, ssrf, posts, settings, outbox, collab, authz)
- [x] 1. Research official docs (record URL+date in docs/V3_CONTENT_INTEGRATIONS.md)
- [x] 2. Migration 016 (written, applies on scratch DB; NOT yet applied to dev)
- [x] 3. core contracts content-hub.ts (+ exports.ts if absent)
- [x] 4. services/content-hub (connections, google, notion, imports, refresh, writeback, exports, jobs)
- [x] 5. worker registration
- [x] 6. web routes + UI components
- [x] 7. tests (unit + integration)
- [x] 8. docs/V3_CONTENT_INTEGRATIONS.md
- [ ] 9. verify tsc/test/integration, db:migrate dev

## Notes
- Research done 2026-11-07 (facts recorded in docs/V3_CONTENT_INTEGRATIONS.md "Sources"): Notion-Version 2026-03-11 (archived→in_trash), data sources (POST /v1/data_sources/{id}/query, 10k cap, request_status), /v1/oauth/token Basic auth + refresh_token rotation, /v1/oauth/revoke, file URLs 1h, webhooks X-Notion-Signature sha256=HMAC(verification_token, raw body), at-most-once, 8 attempts. Google: drive.file non-sensitive per-file; Picker needs API key + appId(project number) + OAuth token; files.get alt=media (binary only), export 10MB limit; md5/headRevisionId binary only; version monotonic; shortcutDetails; changes.watch ≤1w, files.watch ≤1d, no auto renew, empty body; documents.get includeTabsContent, suggestionsViewMode, commentsViewMode; PKCE accepted for web clients but secret still required (third-party reports).
- Design: services in packages/services/src/content-hub/*; OAuth reuses oauth_states (provider 'content:google'/'content:notion', purpose connect), no connection_flows (single account per auth). Callback /api/content-hub/oauth/[source]/callback. Commit = import row + outbox 'source.import_requested' → queue source-import; worker re-checks authority (assurance null). Picker: browser uses GIS token client (no server token exposed), server verifies ids with stored token.
- Written so far: migration 016, core/contracts/{exports,content-hub}.ts, settings/setup keys, content-hub/{transport,config,google,notion,normalize,docs-parse,notion-parse,connections}.ts, media/ingest.ts (+media/index export).
- Next: items.ts (grants/selection, previews), imports.ts, refresh.ts, writeback.ts, exports.ts, webhooks.ts, jobs.ts, fakes.ts, index.ts; outbox/dispatcher/worker wiring; routes/UI; tests; docs.
- Services written: items, imports, rows, refresh, writeback, exports, webhooks, jobs, fakes, store, notion-fetch, index. Wired: outbox.ts event types, outbox-dispatcher WORKLOAD_QUEUES, worker main.ts (3 queues + 'content-hub' sweep timer). Root tsc green at this point.
- Next: tests (unit parse/diff/signature; integration content-hub.test.ts), routes, UI, docs.
- 2026-11-07 (after restart): tests/integration/content-hub.test.ts 20/20 green. setup.test.ts updated for google_content/notion groups + secret assertions (lead request). Lead applies 015–017 to dev (do NOT run db:migrate). Remaining: unit tests, routes, UI, docs, full verify.
- Routes (apps/web/app/api/content-hub/**, webhooks/google-drive, webhooks/notion), UI (components/content-hub/**), entry points (library Sources tab, settings Sources tab, compose button), CSP opt-in Google Picker origins (+unit test) DONE; tsc root+web green. Remaining: docs/V3_CONTENT_INTEGRATIONS.md, full pnpm test / test:integration.
- DONE 2026-11-07: tsc root+web green, pnpm test 455/455, test:integration 42 files/319 tests green. Migration 016 NOT applied to dev (lead applies 015–017).
