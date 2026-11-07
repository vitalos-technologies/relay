# Decisions and deviations

| # | Decision | Why |
|---|---|---|
| D1 | Working draft on `posts.draft` with optimistic `version`; immutable revisions created on submit/schedule/publish (spec suggested a revision per PATCH) | Autosave every second would create hundreds of revisions; approval and delivery still bind to immutable revisions |
| D2 | Approval invalidated when the draft content for the submitted destinations changes; drafts edited after an *approved* schedule do not alter what is sent until rescheduled | What reviewers approved is exactly what is sent |
| D3 | Brands with approval enabled cannot be scheduled directly, even by owners; owners/admins may approve their own submission (audited `self_approved`) | One clear path; single-stage approval per spec |
| D4 | Deliveries table is the queue of record; pg-boss carries outbox events (fast wake-up, notifications) | Claims, leases and fencing need row-level control; pg-boss satisfies "Postgres-backed job library" without owning correctness |
| D5 | One active claim per connection | Natural per-account rate limiting and fairness |
| D6 | Unknown is never auto-retried; Telegram reconcile is "unsupported" → manual | Telegram Bot API has no idempotency key or history lookup |
| D7 | Graph API pinned to **v26.0** | Newest version in Meta's versions table on 2026-11-06 (v27.0 referenced elsewhere but not listed) |
| D8 | Instagram via Facebook Login route only | Spec MVP default; one route reduces complexity |
| D9 | X budget enforced per workspace (`limits.x_monthly_writes/reads`) before sending; reconcile reads metered | X API is pay-per-use; other channels continue when X is capped |
| D10 | SeaweedFS for local S3 | MinIO images were not pullable in this environment; app code uses standard S3 APIs |
| D11 | Dex for local OIDC with static disposable users | Real standards-based login flow; production uses a managed OIDC provider (validated at boot) |
| D12 | webpack build (`next build --webpack`) | Turbopack does not map the packages' ESM `.js` import suffixes to `.ts` sources |
| D13 | Simulated destinations require `is_mock` + `mock_` ID (DB CHECK) + `ENABLE_MOCK_PROVIDERS` + non-production | Mock success can never be confused with, or fall back from, live publishing |
| D14 | Rate limiting is per process (token bucket) | Single-host deployment; documented for scale-out |
| D15 | CSV export neutralises formula injection (`= + - @` prefixed) | Exports are opened in spreadsheets |
| D16 | TypeScript 5.9, Vitest 3.2, Next 16, pg-boss 12 pinned | Supported stable lines; avoided brand-new majors (TS 7, Vitest 5) for a one-day build |
| D17 | Default workspace/brand timezone Europe/London; browser zone never used to interpret input | SC-01..03 |
| D18 | Product renamed **Relay** ("Create. Coordinate. Publish.") per the client brand kit (2026-11-07). User-facing strings come from `packages/core/src/brand.ts`; internal identifiers (`@social-lite/*` packages, DB/cookie/realm names, test domains) unchanged to avoid churn | One source of truth for naming; zero data migration |
| D19 | Brand palette replaces lime: Orange `#FD6701` primary (ink `#121416` text, 6.7:1), Red `#FE4114`, Amber `#FDA602`, Ink `#121416`, Mist `#EBEDEE`; logo gradient `#FD8221→#F13E1F`; light-theme accent text `#B23A00`. Typeface Inter (self-hosted variable). R mark redrawn as SVG from the kit raster | Colours sampled from the kit; accessible text/fill pairings; replace the SVG with the designer's master vector when supplied |
| D20 | Keycloak 26.4 replaces Dex for local OIDC (V2) | Dex has no MFA; Keycloak gives standards-based TOTP, passkeys, recovery codes, `acr`/`amr` step-up (`acr_values=mfa` + `max_age=0`), application-initiated factor actions and back-channel logout — no custom cryptography. Migration 010 resets users bound to the retired Dex issuer to *pending*; a pending user is bound to the first identity that signs in with the **same, IdP-verified email** (then never re-bound — a different subject with that email gets `account_conflict`). This trusts the IdP's email verification, so self-registration must stay off at the IdP (`registrationAllowed: false` in the realm) and email changes there must require verification |
