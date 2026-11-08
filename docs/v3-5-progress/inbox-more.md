# V3.5 stream B — remaining inbox capabilities (resume point)

Brief §10–13 (+ §22 AT 1, 2, 3, 4, 12, 13, 15) · contract row "B" in `docs/V3_5_WORKSTREAMS.md`.
Migration `029_v35_inbox_more.sql` — **applied to dev 2026-11-08, frozen** (applied alone via `MIGRATIONS_DIR`, then
`pnpm db:roles`). Docs: `docs/v3-5/INBOX_NETWORKS.md` (+ Relay column of `CAPABILITY_MATRIX.md`).
Evidence: `evidence/v3-5/inbox-more/` (checkpoints in `checkpoints/`).

## Decisions
- **Adapters** implement the foundation `InboxAdapter` plus optional extras (`poll`, `moderationActions`/`moderate`,
  `resolveAttachment`, `listTemplates`) added to `contracts/v35-inbox.ts` (additive, optional). Registered in
  `inbox-registry.ts`. Instagram, WhatsApp, Google reviews, YouTube, Bluesky, Telegram, Threads are built; X, LinkedIn,
  TikTok are shown as **needs provider approval** (no access) — no adapter.
- **Channel runtime** (`inbox/channels-runtime.ts`): one place resolves credentials + transport for social-connection
  channels and for integration-backed channels (WhatsApp, GBP). Live → live transport (`buildAdapterContext`); simulated
  (`mock_`) → `inboxMockTransport` (inbox fakes first, then the publishing fake). No fallback either way.
- **WhatsApp** = business integration `whatsapp` (connect form verifies the number at Meta first; token in the vault).
  Inbound via the foundation connector ingress + `registerInboundHandler('whatsapp')`. Templates cached on the channel
  (refresh = explicit provider call); charge shown + acknowledged; Unknown sends confirmed by the status webhook marker
  `relay-attempt:<id>` (the ingress treats `relay:<uuid>` bodies as echoes, so a different prefix is used).
- **Google reviews**: channel per selected location of the GBP integration (C owns OAuth + selection). Replies address
  the full review name (contains the location) ⇒ a reply can only reach that location (AT4). Owner reply versions are
  separate messages (`reply:<id>@<updateTime>`); delete = owner reply only. Inbound by polling; for Pub/Sub, C's verified
  handler can call `pollChannel(channelId)` or feed `reviewItems()` (exported) — **dependency on C**.
- **Telegram ownership plan** (check → explicit confirmation → re-check → setWebhook to a per-channel URL + encrypted secret;
  release only Relay's webhook; never getUpdates). Updates persisted in `inbox_inbound_events` before the 200 and processed
  via new outbox event `inbox.inbound_received` (hook on the inbox-events queue) + a sweep.
- **Polling** with `integration_cursors.channel_id` (scope `inbox:poll`), per-adapter intervals, backoff, ingest only into
  the polled channel (`ingestItems(..., { channelId })`).
- **CSAT** = a normal send (requestReply) + only explicit 1–5 answers; **identity linking** needs `cases.manage`.
- **Realtime** = `/api/inbox/stream` (SSE like collab, access re-checked every 15 s). Polling kept as fallback (slower).
- Lead's UI notes addressed: Channels page rebuilt — "Add channel" → network → account (simulated option secondary,
  dev only), full-width brand select in the dialog, capability table "Built *" with the footnote "Built and testable with
  simulated accounts. Live use needs the network's approval first."

## Status
- Done: providers (7 adapters + fakes), services (runtime, integration channels, WhatsApp, Telegram, polling, simulate,
  moderation, attachments, identity, CSAT, worker module), API routes (18), UI (channels settings, template dialog,
  moderation + attachments + ratings in the thread, identity + CSAT panels, saved views, SSE, @mentions), demo seed,
  shots script, unit + integration + E2E specs, docs.
- Worker: after the container restart (2026-11-08 03:13) stream B started web + worker under the v2 lock; the running
  worker includes stream B (`registerInboxMoreWorkers`). Replies on the new networks now go through the new
  `dispatchReply` (E2E: Google review reply → "Sent (simulated)").

## Verification (2026-11-08)
- `tsc` clean (repo + web); ESLint clean on new/edited web files; worker bundle builds.
- Unit + contracts **559/559** (incl. `tests/unit/v35-inbox-more.test.ts` 7).
- Integration (disposable DBs) **478/478, 58 files** (incl. `v35-inbox-more` 14, foundation `v35-inbox` 8, `v35-connectors` 6).
- E2E (production build on :3000, worker with B code): `inbox-more.spec.ts` + foundation `inbox.spec.ts` **8 passed, 2 skipped**
  (desktop-only skips of the @mobile tests).
- Screenshots: `evidence/v3-5/inbox-more/checkpoints/` (12 screens × light/dark, 1440, DPR 2) + 390 px set
  (`evidence/v3-5/inbox-more/*-390-*.png`).
- Mobile QA: stream B 12 screens × 320/360/390/430/768/1024/1440 and foundation 8 screens × the same widths — **0**
  page-level horizontal scroll (a 320 px overflow from long channel labels in list rows was fixed).

## Next / open
- Pub/Sub review notifications: C's handler → `pollChannel` (see above).
- Instagram mentions (field `mentions` needs lookups) and Threads mentions: not built (capability says so).
- Telegram: `removeChannel` (foundation) does not release the webhook — release it first in the dialog (documented).
- X / LinkedIn / TikTok inbox: blocked on provider access.

## Activation checklist items (stream B)
1. Deploy web + worker builds that include stream B (dev already runs them).
2. Meta App Review: `instagram_manage_messages`, `instagram_manage_comments` (+ Human Agent feature); subscribe the app's
   Instagram webhook (`messages`, `comments`) to `/api/webhooks/meta`.
3. WhatsApp: WABA + registered number + Business verification + payment method; system-user token; webhook
   `whatsapp_business_account/messages` → `/api/connectors/webhooks/whatsapp` (verify token + `META_APP_SECRET`);
   approved templates; optional rate card per channel.
4. Google Business Profile API access approval; stream C's connector; verified locations.
5. YouTube: `youtube.force-ssl` granted (reconnect existing channels); quota budget for replies.
6. Bluesky: app password with DM access for DMs.
7. Telegram: HTTPS `APP_BASE_URL`; owner runs Check → Claim per bot (only when no other consumer).
8. Threads: App Review `threads_read_replies`, `threads_manage_replies`; add them to the Threads OAuth scopes.
9. X (paid API), LinkedIn (Community Management API), TikTok (API for Business): provider access before any adapter.

## Files
- new: `packages/db/migrations/029_v35_inbox_more.sql`; `packages/providers/src/shared/inbox.ts`;
  `packages/providers/src/meta/inbox-instagram{,-fake}.ts`; `packages/providers/src/whatsapp/inbox{,-fake}.ts`;
  `packages/providers/src/google-business/inbox{,-fake}.ts`; `packages/providers/src/{youtube,bluesky,telegram,threads}/inbox{,-fake}.ts`;
  `packages/services/src/inbox/{channels-runtime,channels-integration,channels-whatsapp,channels-telegram,channels-poll,channels-simulate,moderation,attachments,identity,csat,worker-more}.ts`;
  `apps/web/app/api/inbox/{channels/integration,integrations/[id]/accounts,whatsapp/connect,channels/[id]/{templates,rates,telegram,poll,csat},telegram/[id],messages/[id]/{moderate,attachments/[idx]},conversations/[id]/{customer,customer/link,customer/unlink,csat},customers,csat/report,stream}/route.ts`;
  `apps/web/components/inbox/{channels-settings,whatsapp-template-dialog,identity-panel,csat-panel,saved-views-panel}.tsx`, `realtime-stream.ts`;
  `scripts/{seed-inbox-more-demo.ts,inbox-more-shots.mjs}`; `tests/unit/v35-inbox-more.test.ts`;
  `tests/integration/v35-inbox-more.test.ts`; `tests/e2e/inbox-more.spec.ts`; `docs/v3-5/INBOX_NETWORKS.md`; this file.
- edited (inbox core, noted): `packages/core/src/contracts/v35-inbox.ts` (optional adapter extras, DTO fields, ReplyRequest
  template/acknowledge_charge, ChannelOptions); `packages/services/src/inbox/{replies,ingest,channels,conversations,simulate,capabilities,shared,index}.ts`;
  `packages/providers/src/meta/{inbox,inbox-fake}.ts` (FB moderation, IG routing, exported classifiers);
  `apps/web/components/inbox/{thread,context-panel,inbox-app,settings,labels}.tsx|ts`; `apps/web/components/conversation/{composer,timeline}.tsx`
  (generic: mentions + footnote; header/actions slots).
- edited (shared, small/additive): `packages/providers/src/inbox-registry.ts` (adapters, PROVIDER_CHANNEL, INTEGRATION_CHANNEL,
  inboxMockTransport); `packages/providers/src/transport/http.ts` (`mybusiness.googleapis.com`); `packages/providers/src/meta/{graph,fake}.ts`
  (DELETE support); `packages/core/src/contracts/v35-events.ts` (event `inbox.inbound_received`); `packages/services/src/webhooks.ts`
  (Instagram → inbox); `apps/worker/src/main.ts` (one `registerInboxMoreWorkers` call); `docs/v3-5/CAPABILITY_MATRIX.md` (Relay column).
