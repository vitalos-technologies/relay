# V4 baseline (brief §1) — verified 2026-11-08

Inspection of the repository before V4 (brief `docs/queue/03g_V4_PROMPT.md`). "Exists" means present in code; it does not
mean V4-ready. File references are to the tree at the V3.5 stream F commit.

| Brief §1 item | State | Where | V4 gap |
|---|---|---|---|
| `/admin` Platform and Workspace modes | **Exists** | Mode by path (`components/admin/admin-shell.tsx:39`); operators in `platform_operators` (026), `loadOperatorRole()` (`services/admin/platform.ts:32`), `platformRoute()` (`apps/web/lib/api.ts:157`, non-operators get 404), `requirePlatform(p,'operator'|'support')`, `requireFresh(p)` step-up (300 s); nav `components/admin/nav.tsx` (`WORKSPACE_NAV`, `PLATFORM_NAV`) | Only two staff roles (`operator`, `support`); no billing staff role; no Platform Support inbox, Plans/Billing, Entitlements or Trials pages |
| Workspace-local problem reports | **Exists** | `support_reports` (022); `services/gov/release.ts` (`createSupportReport` any member, `redactText`, `safeRoute`, opt-in redacted draft excerpt); `api/support/reports`; `components/support/support.tsx` "Report a problem"; admin list `admin/security/reports` | Never reaches Relay staff; no browser family / error code; no status endpoint; no rate limit; idempotency key ignored; admin list reads a `reporter_email` the API doesn't return |
| Platform workspace management | **Partial** | `workspaces.state active|suspended`, `suspended_*` (026); `listPlatformWorkspaces`, `platformWorkspace` (metadata only), `suspendWorkspace`/`reactivateWorkspace` (operator + fresh, pauses deliveries, both audits), dispatch concurrency, flags, accounts | No plan/billing/trial columns, no lifecycle history, no closure flow (`lifecycle.ts` is *member* lifecycle) |
| Time-limited owner-approved support access | **Exists (solid)** | `support_access_grants` (026; already has free-text `ticket_ref`, read-only, 15–1440 min, 24 h request expiry); `services/admin/support-access.ts` (request → owner `decideSupportAccess` with step-up → viewer grant with `expires_at` → `endSupportAccessTx`); expiry enforced per request in `loadUserAuthz`; SSE streams re-check access; both audits; banners | No owner notification on request; lazy sweep only (worker doesn't run it); `ticket_ref` not a foreign key; scope fixed to read |
| Subscription / payment-provider code | **Absent** | Only integration cost acknowledgements (030). `admin/usage` shows "no billing system yet" | Everything: plans, prices, subscriptions, invoices, trials, provider, webhooks, entitlements |
| Usage limits (reusable) | **Exists** | `product/budgets.ts` meters `ai.tokens`, `x.write`, `x.read`, `storage.bytes`, `exports.count` with atomic `reserveUsage`/`settleUsage`/`consumeUsage`, 50/80/100 % notifications; caps in `workspaces.limits`; owner edits caps (`product/usage-admin.ts`) | Caps are customer-set; V4 needs a plan-derived ceiling the platform controls |
| Notifications and email | **Exists, workspace-bound** | `email.ts` (`sendMail`, SMTP, never throws); `notifications` (`workspace_id NOT NULL`, `UNIQUE(user_id, dedupe_key)`, email state machine, re-checked permission); `collab/notifications.ts` `deliverNotification` (prefs, dedupe, realtime, email retry ×3, `not_configured`); outbox → pg-boss (`uuidv5` job ids, dead after 10) | `engine/notify.ts` drops events with no workspace; staff without a workspace can't get in-app notifications; `Requirement` needs a brand; no support event types |
| Shared V3.5 conversation components | **Exists, decoupled** | `components/conversation/composer.tsx` (modes with `audience public|private|internal`, internal = dashed amber + lock) and `timeline.tsx` (message/note/pending/system) | Audience lines are hard-coded inbox wording → make a prop |
| Attachments | **Partial** | `storage.ts` private bucket, `presignUpload` (POST policy, size range), `signedGetUrl`; `media/process.ts` magic-byte sniff; `inbox/attachments.ts` allow-list + sniff + `attachment` disposition | No malware scanning (quarantine = validation pending); no non-brand store for tickets |
| Rate limit / idempotency | **Exists** | `ratelimit.ts` `takeShared`, `enforceRateLimit`, `clientIp`; `idempotency.ts` `beginIdempotent`/`completeIdempotent` | `idempotency_keys.workspace_id NOT NULL` → unusable for platform-scope actions |
| Audit | **Exists** | `audit()` → `audit_events`; `platformAudit()` → `platform_audit_events`; both append-only for app/worker roles; workspace-touching changes write both | — |

## Conventions V4 follows
- Routes: `route()` / `platformRoute()` from `apps/web/lib/api.ts`, one-line header comment, `parseJson(req, z.unknown())`.
- Contracts in `packages/core/src/contracts/*.ts` are types + const enums only; Zod lives in services.
- Services: `fn(ctx, …, raw)` → `requireAction` → `schema.parse` → `withTx` with `audit()` inside; every query scoped by
  `workspace_id`; cross-tenant ⇒ `notFound()`. Platform services: `requirePlatform` (+ `requireFresh`) + `platformAudit`.
- Tests: `tests/integration/helpers.ts` (`tenant()`, `v2Ctx`, `addMember`), platform ctx as in `v31-admin.test.ts:67`;
  E2E `tests/e2e/helpers.ts` (`signIn`, `api`), `owner@demo.social-lite.test` is the seeded operator.

## V4 decisions that follow from the baseline
- **No billing provider exists** → Stripe Billing (hosted Checkout + Customer Portal) behind a `BillingProvider` interface,
  with a deterministic test double and locally signed webhook fixtures; no keys in this environment.
- **Prices:** the user has since queued V5 (`docs/queue/03h_V5_PROMPT.md`), which fixes the public catalogue at
  **Standard £10 / Professional £25 per billable user per month (GBP), 14-day free trial, no card required**. V4 builds the
  catalogue with these two plans instead of placeholder test prices; no annual option is offered (V5: "no invented annual
  discount"), although the catalogue model supports intervals.
- Support tickets reuse the conversation components and the notification pipeline, extended to platform staff (staff
  notifications without a workspace) and platform-scope idempotency.
- Staff roles gain `billing` (billing powers without customer content) alongside `operator` and `support`.
