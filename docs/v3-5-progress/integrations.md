# V3.5 stream C — business integrations — progress (resume point)

Brief: `docs/queue/03f_V3_5_PROMPT.md` §3–9 · contract: "C" row of `docs/V3_5_WORKSTREAMS.md` · guide: `docs/v3-5/INTEGRATIONS.md`.
Migration `030_v35_integrations.sql` — **applied to dev 2026-11-08 (only 030, via `MIGRATIONS_DIR` with a copy of the file so
029/032 stayed unapplied), `pnpm db:roles` re-run, frozen.** No git. Dev lock: `flock -o .data/devserver-v2.lock`.

## Decisions
- **No credentials ⇒ honest states.** Each connector has a full OAuth (or operator-credential) flow reading Setup values; the hub
  shows *Needs app setup* with the missing keys, redirect URI and webhook URL. Everything is exercised on simulated provider
  APIs (`packages/providers/src/<connector>/sim.ts`, durable store `integration_sim_objects`) + locally signed fixtures.
- **Own HTTP transport for business connectors** (`packages/providers/src/biz/transport.ts`): per-connector host allow-list
  (no edit to the shared `transport/http.ts`), PATCH/PUT support, lost-write ⇒ ambiguous. Mailchimp's data-centre host is the
  only dynamic host (validated `^[a-z]{2}\d{1,3}$`).
- **Google Business Profile posts are not a new composer destination** (adding a `Provider` would ripple through every
  publishing map). A GBP local post rides on an existing post's schedule: requested for ≤ 10 explicitly selected locations with
  the count retyped; the worker re-runs `approvalGate` for that exact schedule + the requester's authority when due. Changed
  content ⇒ needs review. Reviews/replies are stream B (interface below).
- **Tasks are tracked in `integration_tasks`** (several per Relay item); tickets, campaigns and contacts use `external_links`
  (one per type per item). For tasks/GBP posts the executors settle reconciled jobs themselves (the generic link path enforces
  one record per type).
- **Slack identities**: explicit link only (one-time token from a verified Slack click, confirmed by the signed-in Relay user).
  Scopes reduced to chat:write, channels:read, groups:read (registry updated). Approve in Slack; Reject opens Relay (reason
  required). Assignments/care escalations only to private channels.
- **Mailchimp signature mode enabled**: format confirmed in the official guide on 2026-11-08 (`X-Mailchimp-Signature:
  t=<ts>,v1=<hex HMAC(secret, "<ts>.<body>")>`); the foundation verifier assumed a separate timestamp header, so stream C
  registers a corrected verifier (URL-key mode stays the baseline). No send/subscribe code exists.
- **Translation cost estimate** = characters sent (incl. Relay's protection markup) × list price (USD 20/M, checked 2026-11-08,
  setting `TRANSLATE_PRICE_PER_MILLION_USD`); free tier not subtracted. Simulated translation returns `[Simulated → xx] <text>`.
- Slack deliveries are their own durable queue table (`slack_deliveries`), not sync jobs (notifications, not business writes).

## Status — done
Contracts `packages/core/src/contracts/v35-integrations.ts`; migration 030; providers (clients + sims) for all seven;
services `packages/services/src/integrations-v35/**` (hub/OAuth/runtime, tasks + webhooks, HubSpot, GBP + Pub/Sub OIDC
verifier, Translation, Slack alerts/interactivity/links, Mailchimp); worker loops; 42 API routes under
`apps/web/app/api/connectors/{hub,oauth,tasks,hubspot,gbp,translate,slack,mailchimp}/**`; UI `/integrations` (hub + per
connector: status, diagnose, pause/resume, reconnect, disconnect, resources, sync rules, settings, history), Slack link page,
embeds in the inbox customer panel (external work, HubSpot ticket, translate) and the composer (Google posts, Mailchimp draft,
tasks); demo seed `scripts/seed-integrations-demo.ts`; screenshots `scripts/integrations-shots.mjs`; docs `docs/v3-5/INTEGRATIONS.md`.

## Verification (2026-11-08)
- Root `tsc` + web typecheck clean; ESLint clean on new web files.
- Unit `tests/unit/v35-integrations.test.ts` 11/11. Integration `tests/integration/v35-integrations.test.ts` 14/14 (incl. stream E action kinds) (+ foundation
  `v35-connectors` 6/6, `setup` 5/5 after adding the seven Setup groups).
- §22: **AT5** (one ticket despite repeats + lost response, reconciled), **AT6** (Asana + monday: push, echo dropped, pull
  without push, conflict ⇒ manual review, external Done never touches approvals/schedules, deletion ⇒ unavailable), **AT7**
  (unsigned/tampered refused, unlinked ⇒ link required, revoked member refused, stale fingerprint refused, other Slack team
  refused, replay refused), **AT8** (draft only, one per post, approved content only, no member writes), **AT9** (off until
  enabled + billing ack, customer-content switch, original kept, no reply attempts, links/mentions/placeholders preserved,
  cached), **AT13** (outage ⇒ retry, rate limit ⇒ throttled with observed reset, revoked ⇒ reconnect + links unavailable),
  GBP posts through schedule/approval, Pub/Sub OIDC checks. E2E `tests/e2e/integrations.spec.ts` (see below).
- Worker: the dev worker started after the container restart (by another stream) includes the stream C executors and loops;
  the stream E automation executors were added afterwards and need one more worker rebuild/restart (lead / stream F). Worker paths are covered by the
  integration tests (they call `runSyncJob`, `processIntegrationEvent`, `dispatchDueGbpPosts`, `collectSlackAlerts`,
  `sendSlackDeliveries` directly). The demo seed runs its jobs inline.

## Shared files edited (small, additive)
`packages/services/src/settings.ts` (7 setting groups / 25 keys), `packages/services/src/setup.ts` (7 Setup groups),
`packages/services/src/connectors/registry.ts` (Asana `workspaces:read`; Slack scopes reduced; Mailchimp host note),
`packages/services/src/connectors/jobs.ts` (form-encoded webhook bodies kept as parsed data — Slack `payload`, Mailchimp form),
`apps/web/app/api/connectors/webhooks/[connector]/route.ts` (one import registering the GBP/Mailchimp verifiers),
`apps/worker/src/main.ts` (one `registerIntegrationWorkers` call + timers), `apps/web/components/shell/app-shell.tsx`
(Integrations nav, `integrations.read`), `apps/web/components/settings-shell/registry.tsx` (Connections → Business
integrations), `apps/web/components/inbox/context-panel.tsx` (ExternalWork + TranslatePanel), `apps/web/components/composer/composer.tsx`
(lazy PostIntegrations card), `tests/integration/setup.test.ts` (expected Setup groups), `packages/services/src/automation/rules.ts`
(stream E file: one side-effect import so the integration executors are registered in the web process).

## Interface for stream B (Google reviews in the inbox)
`listGbpLocations(ctx, { brandId })` / `GET /api/connectors/gbp/locations` (selected locations, v4 names
`accounts/{a}/locations/{l}`), `openGbpConn(integrationId)` (transport + token; simulated for mock installs),
`onGbpNotification(fn)` (verified Pub/Sub review notifications). Inbox channels for GBP use `inbox_channels.integration_id`.
The GBP simulated API (`providers/google-business/sim.ts`) has no review endpoints yet — B adds them in its own sim/adapter.

## For stream E (automation actions)
Executors for E's kinds are registered (`packages/services/src/integrations-v35/automation.ts`), in the worker
(`registerIntegrationWorkers`) and in the web process (one side-effect import added to `services/automation/rules.ts`):
`asana.create_task`, `monday.create_item` (the installation's single selected project/board or
`settings.automation_resource_id`; safe summary + Relay link), `hubspot.create_ticket` (the case's ONE ticket, shared with
the UI; conversations ⇒ "create a case first"; needs default pipeline/stage), `slack.post_message` (minimal alert to this
installation's care-escalation channels via the Slack sender: quiet hours, rate limits, history). **`mailchimp.create_campaign_draft`
is deliberately not registered**: drafts only come from approved posts and automation subjects are cases/conversations, so it
stays "Not available yet". External status never approves/publishes. The running dev worker must be rebuilt/restarted to load them.

## Activation checklist items
1. Asana app (OAuth, scopes above, redirect `<APP_BASE_URL>/api/connectors/oauth/asana/callback`) → `ASANA_CLIENT_ID/SECRET`.
2. monday.com app (OAuth + signing secret) → `MONDAY_CLIENT_ID/SECRET/SIGNING_SECRET`; confirm current `MONDAY_API_VERSION`.
3. HubSpot public app (scopes above; Service Hub portal for tickets) → `HUBSPOT_CLIENT_ID/SECRET`; subscribe app webhooks
   `ticket.propertyChange`, `ticket.deletion` to `/api/connectors/webhooks/hubspot`; marketplace listing only if distributed.
4. Google Business Profile: API access approval (quota 0 until granted), OAuth client → `GBP_CLIENT_ID/SECRET`; optional Pub/Sub
   topic + authenticated push subscription (billed Google Cloud service) → `GBP_PUBSUB_AUDIENCE`, `GBP_PUBSUB_SERVICE_ACCOUNT`.
5. Cloud Translation: project with billing + API enabled, service account with `roles/cloudtranslate.user` →
   `GOOGLE_TRANSLATE_PROJECT_ID`, `GOOGLE_TRANSLATE_SERVICE_ACCOUNT_JSON` (+ `GOOGLE_TRANSLATE_LOCATION` for glossaries);
   confirm list price. A workspace admin must still enable it.
6. Slack app (bot scopes chat:write, channels:read, groups:read; interactivity URL `/api/connectors/webhooks/slack`) →
   `SLACK_CLIENT_ID/SECRET/SIGNING_SECRET`.
7. Mailchimp registered app → `MAILCHIMP_CLIENT_ID/SECRET`; optional signed webhook secret `MAILCHIMP_WEBHOOK_SECRET`.
8. Restart the worker so the stream C executors/loops run (lead / stream F).
9. Live verification per connector with designated test accounts (none done here).

## Next (if resumed)
Admin wiring for integration health is stream F (`integrationHealth`, `slack_deliveries`, `translations` usage); mobile QA
sweep of `/integrations/*` at 320–768 with `MOBILE_QA=1 node scripts/integrations-shots.mjs`.
