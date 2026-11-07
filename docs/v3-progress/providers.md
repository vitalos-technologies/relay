# V3 social adapters — progress (resumable)

Owner: V3 social adapters stream. Read this first after a restart.

## Plan
1. Research official docs (date 2026-11-07) → docs/providers/<p>.md
2. Per provider: packages/providers/src/<p>/{api,oauth,adapter,fake,metrics,index}.ts + tests/contracts/v3-<p>.test.ts
3. Integration: core types (PROVIDERS), registry, metrics registry, settings keys, runtime/oauth lists, platform icon, CAPS map, migration 014.
4. Verify: tsc (root + web), contracts, unit, integration; db:migrate dev.

## Status
| Provider | research | code | fake | metrics | tests | doc |
|---|---|---|---|---|---|---|
| tiktok | done | done | done | done | 35 pass | draft |
| youtube | done | done | done | done | 29 pass | draft |
| linkedin | done | done | done | done | 29 pass | draft |
| threads | done | done | done | done | 24 pass | draft |
| pinterest | done | done | done | done | 22 pass | draft |
| bluesky | done | done | done | done | 25 pass | draft |

Research is complete and recorded in docs/providers/<p>.md (drafted 2026-11-07 BEFORE code; update behaviour sections
if the code diverges). Pinterest OpenAPI copy: scratchpad only (re-download from github raw if needed).

## Design decisions (keep consistent)
- Shared helpers: packages/providers/src/shared/{http,oauth,classify,text}.ts (new, owned by this stream).
- Core additive changes: PROVIDERS +6; HttpRequest.body may be Uint8Array; ProviderCredentials += atproto_app_password;
  ProviderAppConfig.features?; ChannelCapabilities optional publishMode/nativeScheduling/eligibility;
  textCounting += 'graphemes'; PublishingAdapter.cancelRemoteSchedule? ; ValidationIssue.field += 'options'.
- Provider-required fields live in variant.options.<provider> (tiktok/youtube/pinterest/bluesky/linkedin).
- Pinterest destinations = boards. LinkedIn providerAccountId = URN (person/organization). TikTok = open_id.
- TikTok inbox handoff => publish 'processing'; reconcile SEND_TO_USER_INBOX => still_unknown (manual handoff text).
- YouTube/TikTok/LinkedIn video: prepare uploads all but last chunk; publish = final chunk (publishes:true).
- Bluesky: deterministic TID rkey in checkpoint; reconcile via getRecord (not found => not_published).

Integration (done 2026-11-07): core types/adapter/text/state-machine (additive); providers registry + metrics
registry + transport allow-list (+ *.host.bsky.network suffix); services settings keys + setup groups + runtime
providerAppConfig/OAUTH_PROVIDERS + oauth.ts messages + manage.ts PROVIDER_NAME; web platform-icon; tests CAPS map;
migration 014 applied to dev; engine hook: engine/remote-schedule.ts + pollProcessing (process.ts) + onScopePaused
(hooks.ts) wake-up. Contract tests done (164 V3 tests). Integration tests: tests/integration/v3-remote-schedule.test.ts (3),
v3-connections.test.ts (2); setup.test.ts group list updated. Docs final; PROVIDER_CAPABILITIES V3 register appended.
Bluesky connect service: services/connections/bluesky.ts (route/UI not built). FINAL VERIFICATION (2026-11-07): root tsc ✓, web tsc ✓, pnpm test 418/418 ✓ (contracts incl. 164 V3),
pnpm test:integration 243/244 (only the pre-existing Dex OIDC diagnostics test fails), db:migrate dev applied 014. DONE.

## Notes / gaps for lead
- setup.test.ts 'checks … OIDC' fails because the test hardcodes Dex (:5556/dex) while stream A moved to Keycloak (not V3).
- Engine: scheduling service must set due_at = upload lead time before YouTube publishAt for provider-owned deliveries.
- Engine/UI: no first-class 'manual handoff' delivery state (TikTok inbox uses unknown + explicit text).
- API route + UI for Bluesky app-password connect; UI fields for provider-required options (variant.options.<provider>).
- Self-hosted Bluesky PDS hosts not in the transport allow-list (only *.host.bsky.network + bsky.social).
