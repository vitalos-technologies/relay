# V3 security and test report

Relay V3 (tag `v3.0.0`): providers, analytics, Content Hub, MCP, engine gaps and the UX redesign. Re-run 2026-11-07 13:52 UTC on `main` @ c6a8c0a. The working tree also holds uncommitted V3.1 UI files; they are client code, not used by these suites.

V2 baseline: [V2_TEST_REPORT.md](V2_TEST_REPORT.md). Threat model: [V2_THREAT_MODEL.md](V2_THREAT_MODEL.md).

Environment: Linux container, Node 22, Vitest 3.2.7, Playwright, PostgreSQL 16, SeaweedFS (S3), Keycloak 26.4, Mailpit. **All provider, Google, Notion and MCP-client traffic goes to labelled fakes or recorded-request transports.** Nothing was verified live.

## 1. Results

| Suite | Command | Files | Tests | Result |
|---|---|---|---|---|
| Unit | `pnpm -s test` (project `unit`) | 15 | 138 | **138 passed** (incl. V3.1: 34) |
| Provider contracts | `pnpm -s test` (project `contracts`) | 16 | 352 | **352 passed** |
| Integration (real Postgres + S3 + Keycloak; disposable DB per run) | `set -a; . ./.env; set +a; npx vitest run --project integration` | 49 | 374 | **373 passed, 1 failed** (153 s). The failure is flaky: it passed 3/3 when re-run alone. Includes V3.1: 51 |
| Browser E2E on a **production build** | `next build --webpack` + `next start`, then `pnpm test:e2e` | 3 specs | 39 | **39 passed** in 18.3 min (lead run, 95f8e34; `evidence/e2e/results.json`: 39 expected, 0 unexpected, 0 flaky) |
| Typecheck | `tsc` root + web | – | – | Clean (UX stream, after 3e5e3f2); not re-run here |
| Migration rehearsal 001–019 | `./scripts/migration-rehearsal.sh` | – | 10 checks | PASS (`evidence/v2/migration-rehearsal.txt`); not re-run here |

Unit + contracts: **490/490** (`Test Files 31 passed (31) · Tests 490 passed (490)`).

Integration failure, verbatim:

```
FAIL  |integration| tests/integration/engine-handoff.test.ts > manual handoff delivery state > processing → handoff (polled hourly), resolvable by a person, never auto-retried
AssertionError: expected 'unknown' to be 'handoff' // Object.is equality
 ❯ tests/integration/engine-handoff.test.ts:32:49
     32|     expect(await reconcileOne(world.deps, 'r')).toBe('handoff');
```

Re-run alone 3 times (`npx vitest run --project integration tests/integration/engine-handoff.test.ts`): 2/2 passed each time. The earlier 08:19 run of the full suite (on e3d0e17) also passed it. Treat it as timing-sensitive under full-suite load (gap V6).

### E2E notes

- **Earlier 5 failures:** the previous full run (33/38) used the **dev server**, because the production server failed to start with `EADDRINUSE`. Those failures came from that run's conditions (one outdated expectation, dev-server recompiles), not product defects. Source: the lead. The cause is recorded only in this report.
- **Strict-CSP fix:** Zod v4 probes `Function('')` when it builds object schemas. Under the strict CSP (no `unsafe-eval`), the browser reported an eval violation on every page. Browser builds now call `z.config({ jitless: true })` (`packages/core/src/schemas.ts`; the server is unchanged). `security.spec` "CSP + security headers … no violations" passes on the production build.
- **E2E isolation:** E2E now runs in its own seeded **"E2E Workspace"** (`scripts/seed-e2e.ts`, `tests/e2e/global-setup.ts`, `helpers.useE2EWorkspace`), so Playwright fixtures no longer land in the Demo Workspace. `publishing.spec` is pinned to the seeded simulated destinations.
- Contract tests for LinkedIn, Pinterest and Threads now use the test clock instead of the real clock (95f8e34).

## 2. V3 test inventory

| File | Tests | Proves |
|---|---|---|
| `integration/mcp.test.ts` | 21 | PRM + 401 challenge; pinned revision and tool annotations; Origin/Host, GET 405, DELETE; expired/wrong-aud/wrong-iss/forged/non-access/unknown-subject tokens → 401; `insufficient_scope` before dispatch; read-only consent blocks writes; revoked client; MFA-gated tools; no cross-workspace leaks; brand consent narrows; drafts with idempotency + expected versions; Content Hub tools see only selected items; `analytics_overview` live data only; bounded pages/ranges; approval brands need review; fabricated confirmation rejected, trusted confirmation commits once; stale intent; automation policy limits + revocation; pause identical to UI (no resume via MCP); prompt injection authorizes nothing, leaks nothing; async exports re-check authority, no duplicates; cancellation; service-account keys scoped by grants |
| `unit/mcp.test.ts` | 5 | Scope parsing; scopes never map to admin permissions; read-only tools never destructive; RFC 6750 challenges; policy-grant limits |
| `integration/api-fixes-v3.test.ts` | 2 | Each provider reports its own setting keys; `status=draft` returns never-scheduled posts, other values refused (8e774ba) |
| `integration/v31-brand-rule-hold.test.ts` | 1 | A mandatory brand rule added after scheduling holds the delivery; nothing is sent while held (46d6313) |
| `integration/content-hub.test.ts` | 20 | `drive.file` only, PKCE, separate grant, encrypted tokens never returned; foreign-session callback and declined scope refused (and revoked); Notion OAuth + pinned version; cross-tenant connection refused; Picker ids verified, private ids rejected, retries dedupe; shortcuts / Shared Drive / denied / trashed; Docs tabs and warnings; changed source refused; refresh → diff + revision, scheduled content gets a new draft; access loss hides previews, keeps snapshots; disconnect revokes and wipes tokens; bounded Notion blocks; incomplete flag; mappings and row import; writeback single property, no loops, conflicts; exports never touch ACLs; Notion webhook signatures; Drive watch tokens; queued import fails after access loss |
| `unit/content-hub.test.ts` | 9 | Docs/Notion parsing, fingerprints, diff, mapping validation, writeback payload, HMAC, HTML escaping |
| `integration/v3-analytics.test.ts` | 13 | Registry mapping; 0 vs missing vs unsupported; lifetime vs daily; ratio of sums; DST buckets; zero baseline; fact-key upserts; no cross-family/unique sums; coverage + through-date; rollups = per-post; channels/video/audience/best-time; **demo never in live**; cross-tenant ids not found, brand-scoped analysts |
| `integration/v3-analytics-pipeline.test.ts` | 8 | Checkpoints and job keys; rate limits/back-off; **revoked access stops sync**; per-workspace concurrency yields to publishing; V1.1 backfill keeps states; CSV export matches filters, injection-safe; exports re-check authority at request/run/download; saved views re-check access |
| `unit/v3-analytics-semantics.test.ts` | 12 | DST, rollup buckets, comparisons, aggregation refusals, CSV cells, canonical filter serialisation, cadence |
| `contracts/v3-{tiktok,youtube,linkedin,threads,pinterest,bluesky}.test.ts` | 164 | Per provider: OAuth URL/exchange (tokens never echoed), validation and required fields, upload/resume, lost-response → Unknown → reconcile, standard failure scenarios, metrics (missing ≠ 0) |
| `integration/v3-connections.test.ts` | 4 | Bluesky app password encrypted and labelled; **self-hosted servers need the operator allow-list**; reconnect re-verifies the same account; V3 OAuth providers registered |
| `integration/v3-remote-schedule.test.ts` | 3 | YouTube provider-held schedule recorded; pause cancels it; unconfirmed cancellation stays visible with residual risk |
| `integration/v3-youtube-early-upload.test.ts` | 3 | Early dispatch with `publishAt`; app-owned at due time; short lead falls back |
| `integration/engine-handoff.test.ts` | 2 | `handoff` state never auto-retried; reconcile completes it (one case flaky under full-suite load) |
| `integration/db-roles.test.ts` | 5 | Includes **runtime role guard**: least-privilege roles pass; owner/superuser refused in production (G14) |
| `integration/grant-expiry.test.ts` | 1 | Expired grants revoked, audited, policy version bumped (G7) |
| `unit/security-headers.test.ts` | 6 | Includes "Content Hub Google Picker origins are opt-in and limited to Google picker/identity hosts" |

V1/V2 suites (engine, media, tenancy, identity, auth, collab, product, adversarial) and the V3.1 suites (`v31-*`, `api-fixes-v3`) passed in the same run. The only failure is the flaky `engine-handoff` case above.

E2E specs:
- `publishing.spec`: compose → publish to four simulated destinations, partial retry, CSRF, cross-workspace read, viewer limits, screens render on desktop and mobile, keyboard.
- `security.spec`: Keycloak TOTP, step-up, sessions, CSP, service accounts, the Settings security policy.
- `v2-product.spec`: health centre, readiness preflight, activity/budgets/handover through the new `/settings/operations/export`, viewer on mobile.

## 3. Threat-relevant V3 changes

### MCP (`packages/services/src/mcp/**`, `apps/web/app/mcp/route.ts`, migration 017)

| Control | Implementation | Test |
|---|---|---|
| Authentication always required | OAuth resource server; Keycloak is the authorization server (Relay issues no tokens); RFC 9728 metadata; 401 + `WWW-Authenticate` | MCP |
| Token validation | JWKS signature (RS256/PS256/ES256), `iss`, `aud` ∋ resource URI, `exp`, `typ`, `azp`; web-login token rejected | MCP |
| Audience | Keycloak 26.4 lacks RFC 8707: audience mapper on each MCP scope. **Production must set it to the public `/mcp` URL** | Scratch Keycloak run (`V3_MCP_GUIDE.md`) |
| Consent | First token creates a pending registration. The user, signed in with step-up, picks workspace, scopes and brands | MCP |
| Effective permission | V2 grants ∩ token scopes ∩ consented scopes ∩ consented brands ∩ policy, applied as `AuthzState` restrictions | MCP, MCPu |
| Revocation | Per registration; effective on the next request; voids policies, open intents and queued jobs. Tokens live 300 s | MCP |
| Publication intents | `prepare` stores an intent (30 min, SHA-256 hash). `commit` re-checks everything and needs a trusted confirmation in Relay (session + CSRF + Origin + step-up) or a policy grant; `confirmed:true` ignored; idempotent | MCP |
| No passthrough | Raw token stays in `auth.ts`. No Google/Notion/social credentials, signed URLs or keys are returned | MCP |
| Transport | Origin/Host allow-lists; 256 KB body; per-principal rate limits (general, mutation, export); 200 KB results; ≤ 50 page size; ≤ 31/92-day ranges | MCP |
| Untrusted content | Post, source and analytics text labelled untrusted; no SQL/shell/fetch/role tools | MCP |
| Audit | `mcp_audit` (ids, result, code, latency; no arguments or text) + `audit_events` | MCP |

Residual:
- Sessions are in-process: several web replicas need sticky routing, or the client re-initialises.
- DCR is off.
- No real MCP client has been tested.

### Content Hub token handling and revocation (`packages/services/src/content-hub/**`, migration 016)

| Control | Implementation | Test |
|---|---|---|
| Least scope | Google `openid email drive.file` only; `include_granted_scopes=false`. Declined `drive.file` ⇒ revoked + refused | CH |
| Token storage | Envelope-encrypted, AAD `content-connection:<workspace>:<connection>`. Never returned. Refresh serialized (advisory lock + CAS) | CH |
| OAuth state | `oauth_states`: sha256 only, single use, 10 min, bound to the starting session user; PKCE verifier encrypted | CH |
| Browser Picker | Browser gets its own short-lived `drive.file` token from Google Identity Services; the server token never reaches the browser; server re-verifies every picked id | CH (server side only) |
| Disconnect | Best-effort provider revoke, tokens deleted, watches stopped, queued jobs cancelled, previews hidden | CH |
| Access loss | 401 after one forced refresh ⇒ `reconnect_required`; background reads/writes stop | CH |
| Job authority | Workers rebuild the requester's current authority; removed/narrowed people fail | CH |
| Untrusted input | Imported text stays plain draft text; Notion statuses never approve | CH, CHu |
| Webhooks | Notion HMAC (constant-time) + dedupe; Drive channel token hash + message-number dedupe; signals only | CH |
| ACLs | Never reads or changes Drive/Notion sharing; exports warn about inheritance | CH |

Residual:
- The Notion webhook handshake trusts the latest verification POST until an owner adopts it.
- `NOTION_INTERNAL_TOKEN` is refused in production.
- Google "PKCE + secret" behaviour is assumed (third-party reports).

### Analytics dataset isolation (`packages/services/src/analytics/**`, migration 015)

- `source` on every observation/fact: `provider` | `simulated` | `synthetic`.
- `connections.is_synthetic` requires `is_mock` (DB CHECK).
- Datasets: `live` (real accounts only), `simulated` (mock destinations), `demo` (synthetic, demo workspaces only). Live queries never include the others (AN).
- `analytics.read` per brand. Exports also need `exports.create` and are re-checked at request, run and download (ANP).
- Sync stops on revocation, reconnect-required, archived brand or suspended workspace (ANP).
- CSV formula injection neutralised; missing values blank, never 0.

### CSP: Google Picker origins (`apps/web/lib/csp.ts`, `apps/web/proxy.ts`)

- `buildCsp()` adds Google origins only when `googlePicker` is true. The added origins:
  - frame: `docs.google.com`, `accounts.google.com`, `content.googleapis.com`;
  - connect: `www.googleapis.com`, `content.googleapis.com`, `accounts.google.com`;
  - img: `*.googleusercontent.com`, `ssl.gstatic.com`.

  Otherwise `frame-src 'none'` (UH).
- **The proxy turns it on by default** (`CONTENT_HUB_GOOGLE_PICKER !== 'false'`), even when no Picker keys are configured.
  - This is kept on by design (lead decision): the CSP is built in the proxy before database settings are readable.
  - It only adds Google Picker/identity origins.
  - To keep `frame-src 'none'`, set `CONTENT_HUB_GOOGLE_PICKER=false`.
- Browser Zod runs `jitless`, so no `Function()` eval probe reaches the strict `script-src` (see §1).
- `frame-ancestors 'none'`, nonce + `strict-dynamic` unchanged.

### Bluesky operator allow-list (`packages/providers/src/transport/http.ts`, `services/connections/runtime.ts`)

- The live transport only reaches allow-listed provider hosts. The Bluesky defaults are `bsky.social`, `public.api.bsky.app` and `*.host.bsky.network`.
- Self-hosted servers are added only through the operator env `BLUESKY_SELF_HOSTED_HOSTS` (exact hostnames), never from user input. A non-listed server is refused before any request (VC).
- App passwords are encrypted. A main account password is refused before any request (C:bluesky).

### Runtime DB-role guard (`packages/db/src/runtime-role.ts`)

- Web (`apps/web/instrumentation.ts`) and worker (`apps/worker/src/main.ts`) call `assertRuntimeDbRole` at boot.
- In production, startup is refused if the role is superuser, bypasses RLS, can create roles or databases, or owns application tables. Outside production it returns warnings (DB).

### Providers (all six new adapters)

- Tokens are never echoed in errors (C:‹p›).
- A lost response after send becomes Unknown and is reconciled, never blindly retried.
- Mock transports only for `mock_` connections, never in production (`setLiveTransportFactoryForTests` throws in production).
- Meta insights permissions (`read_insights`, `instagram_manage_insights`) are requested only when the operator sets `META_REQUEST_INSIGHTS=true` after Meta review. Without them publishing works and analytics shows "permission missing" (9dc2ad7; `contracts/meta.test.ts`).

## 4. Not covered

- No live provider, Google, Notion or real MCP-client run.
- No browser test of the Google Picker, MCP consent/confirm pages or Content Hub UI. The redesigned screens have only render-without-errors smoke tests (plus the publishing, settings and security journeys).
- No penetration test, dependency audit or security certification in this report.
