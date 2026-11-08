# Requirements matrix (V1)

Status: **LV** locally verified (automated test) · **I** implemented, not separately tested · **AA** awaiting external activation · **X** not implemented.
Tests: E = `tests/integration/engine.test.ts`, C = `connections.test.ts`, M = `media.test.ts`, T = `tenancy.test.ts`, A = `auth*.test.ts`, K = `tests/contracts/*`, U = `tests/unit/*`, B = `tests/e2e/publishing.spec.ts`.

| Req | Implementation | Test | Status |
|---|---|---|---|
| AC-01 OAuth state single-use, expiring, user-bound, PKCE | services/connections/oauth.ts, auth/oidc.ts | C, A | LV |
| AC-02 Explicit destination choice | connection_flows + /accounts/select | C | LV |
| AC-03 Telegram verify bot/channel/rights before Ready | providers/telegram/connector.ts | C, K | LV (live AA) |
| AC-04 Account states, never Ready on save alone | connections/manage.ts | C | LV |
| AC-05 Disconnect blocks; different identity → new connection | manage.ts, engine/hooks.ts | C, E | LV |
| CO-01 Base + per-destination variants | core/validation.resolveVariants, variants table | E | LV |
| CO-02 Autosave + optimistic concurrency | posts/service.updateDraft, composer | E, B | LV |
| CO-03 Inherited vs custom text | VariantDraft.inheritText | U | LV |
| CO-04 Per-destination validation with exact fix | core/validation.ts | U, E, B | LV |
| CO-05 Platform-aware counting, safe preview | core/text.ts, composer preview | U | LV |
| CO-06 Media ready + ownership at schedule | posts/service.validateDraft, assertDraftRefs | E, M | LV |
| CO-07 One image, no truncation/threads | constraints.maxImages=1 | U | LV |
| CO-08 Publish now = same durable pipeline, confirmation | scheduling.publishNow, composer dialog | E, B | LV |
| SC-01 UTC + IANA + wall time | schedules table | E | LV |
| SC-02 DST gap rejected / fold choice | core/time.ts | U, E | LV |
| SC-03 TZ change doesn't move schedules | stored UTC | I | I |
| SC-04 Drag reschedule confirm | planner UI + reschedule | E (API) | LV (API), I (UI) |
| SC-05 Pause checked at dispatch | engine/process gate | E | LV |
| SC-06 Publish-before deadline (15 min default) | brands.default_deadline_minutes, sweeper | E | LV |
| SC-07 Missed jobs → review, no flood | sweepDeadlines, onScopeResumed | E | LV |
| SC-08 New generation; old jobs no-op | schedules.generation + gate | E | LV |
| AP-01..04 Single-stage approval, binding, diff, dispatcher check | posts/scheduling.ts, approvals UI | E | LV |
| ME-01 Direct private upload, size-limited | presigned POST | M | LV |
| ME-02/03 Real type, decode, bomb limits, metadata strip, quarantine, no SVG | media/process.ts | M | LV |
| ME-04 Immutable originals, derivatives, signed URLs | media/assets.ts | M | LV |
| ME-05 No deletion while referenced | archiveAsset | M | LV |
| DE-01/02 Per-destination states, partial success, retry only failed | engine + UI | E, B | LV |
| DE-03 Provider IDs, attempts, safe errors, no secrets in logs | delivery_attempts, log.redact | E, K | LV |
| DE-04 History CSV with destination + times | readmodels.historyCsv | I (manual) | I |
| DE-05 No implied remote edit/delete | capabilities, UI links | – | I |
| Roles §6 | core/permissions.ts, tenancy.ts | U, T, E, B | LV |
| Durable algorithm §11 | engine/* | E | LV |
| Outbox crash safety | outbox-dispatcher (deterministic job id) | I | I |
| Security §14 (encryption, CSRF, sessions, SSRF, redaction) | crypto.ts, api.ts, session.ts, ssrf.ts, log.ts | A, T, K, B | LV |
| Prod fail-closed | config.assertProductionSafe, instrumentation.ts | U + image | LV |
| Webhooks: authenticate, dedupe, ack, apply forward-only | webhooks.ts | webhook-processing.test.ts | LV |
| Ops dashboard / health / diagnostics | readmodels.ops, diagnostics.ts | B (renders) | LV |
| Backup/restore with dispatch off | restore-drill.sh | drill | LV |
| Load target (95% start ≤ 60 s) | worker | load test | LV (simulated) |
| Four live platforms | adapters | K (contracts) | **AA** |
| V1.1 CSV import | imports.ts + Compose dialog | imports.test.ts | LV |
| V1.1 TipSignal → drafts + deterministic graphics | tipsignal.ts | tipsignal.test.ts | LV |
| V1.1 AI caption assistance (diff acceptance, caps, fidelity) | services/ai/**, components/ai | ai-*.test.ts | LV (fixture; live AA) |
| V1.1 Carousels/albums/multi-image/video/Reels | providers/*, media/video* | contracts + media-video tests | LV (live AA) |
| V1.1 Posting slots + queue (DST-safe, concurrent-safe) | services/slots/** | slots tests | LV |
| V1.1 Image crops (approval-bound) | services/crops/** | crops tests | LV |
| V1.1 Native analytics with quotas (unavailable ≠ 0) | services/analytics, providers/*/metrics.ts | analytics tests | LV (live AA) |
| Meta deauthorize / data deletion | meta-callbacks.ts | meta-callbacks.test.ts | LV |
| Webhook application (forward-only) | webhooks.processWebhookReceipt | webhook-processing.test.ts | LV |
| Shared rate limiting | ratelimit.takeShared | auth-security.test.ts | LV |
| KMS key custody | kms.ts | kms.test.ts | LV (live AA) |
