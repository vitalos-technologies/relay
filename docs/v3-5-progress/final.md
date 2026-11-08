# V3.5 stream F — admin + MCP + wiring + final verification (resume point)

Brief §19–23 · contract row "F" of `docs/V3_5_WORKSTREAMS.md` · fix list `docs/v3-5-progress/lead-notes.md` (all items
answered there under "Stream F — status"). **No migration** (033 not needed). Evidence: `evidence/v3-5/final/`.
Final docs: `docs/v3-5/{REQUIREMENTS_MATRIX,CAPABILITY_MATRIX,DATA_MODEL_AND_EVENTS,SECURITY_AND_RETENTION,ADMIN_AND_MCP,
TEST_REPORT,IMPLEMENTATION_GAPS,FINAL_ACTIVATION_CHECKLIST}.md`.

## Decisions
- **content.approved bridge** lives in the collaboration consumer (`engine/notify.ts`, `approval.decided` → outbox
  `content.approved` on inbox-events) instead of the publishing transaction: no publishing-core edit; redelivery may write
  a second row, automation dedupes per rule + approval.
- **Alert/approval triggers** have no conversation ⇒ `TRIGGER_ACTIONS` (notify chosen people, integration jobs) and
  `TRIGGER_INTEGRATION_KINDS` (Slack/Asana/monday; HubSpot needs a case) in the automation contract; enforced in rule
  validation, the engine and the builder UI. Simulated alerts never reach live integrations.
- **Echo detection** = marker in a Relay-written provider field (Asana `external`, monday update text, Slack metadata) AND
  the marker names a real sync job of that installation. Free text is never an echo.
- **MCP**: six new opt-in scopes, 14 tools, drafts only (no send/notify/apply tools); `list_workspaces` accepts any scope;
  `provider_not_configured` → `not_configured`.
- **Admin**: one nav group "Inbox, listening and AI" (Overview + 4 health pages + 3 settings links); each page renders the
  owning stream's service; platform page is installation-wide counts only.
- **Setup details** in the integrations hub are shown only to the instance owner / platform operators (server-side redaction).
- Retention: documented; a configurable per-workspace message-text retention was **not** built (needs a migration and a
  product default) — listed as a gap.

## Nav proposal (not applied — user decision in the copy/IA pass)
Main nav today: Overview, Planner, Create, Content library, Campaigns, Approvals, Inbox, Listening, Assistant, Tasks,
Analytics, Connections, Integrations, Team, Settings (+ Admin group). Proposal:
- **Publish**: Overview, Planner, Create, Content library, Campaigns, Approvals
- **Engage**: Inbox, Listening, Assistant (Automation inside Assistant as today)
- **Insights**: Analytics
- **Workspace**: Tasks, Team, Connections + Integrations merged as "Connections" with two tabs (social accounts, business
  apps), Settings
- Phone bottom bar for people with `inbox.read` and no publishing rights: Overview · Inbox · Create→(hidden) · More;
  for mixed roles keep Planner and put Inbox in place of Approvals when they have no approval rights.

## Status — done
See "Files" and `docs/v3-5/TEST_REPORT.md` for numbers. Web + worker rebuilt and restarted 2026-11-08 (under
`devserver-v2.lock`; worker started with `DATABASE_URL=$WORKER_DATABASE_URL`).

## Activation items (stream F)
Worker restart with all streams (done on dev); MCP clients must re-consent to the new scopes; API-key MCP clients created
before V3.5 must be re-created. Full list: `docs/v3-5/FINAL_ACTIVATION_CHECKLIST.md`.

## Files
- new: `packages/services/src/admin/v35.ts`; `packages/services/src/mcp/tools-v35.ts`; `packages/services/src/inbox/channels-gbp-notify.ts`;
  `apps/web/app/api/admin/{care,integrations}/route.ts`, `apps/web/app/api/platform/care/route.ts`;
  `apps/web/app/(admin)/admin/{care,integrations,listening,ai}/page.tsx`, `apps/web/app/(admin)/admin/platform/care/page.tsx`;
  `scripts/{v35-final-shots.mjs,v35-perf.ts}`; `tests/integration/v35-final.test.ts`; docs listed above (new:
  REQUIREMENTS_MATRIX, SECURITY_AND_RETENTION, ADMIN_AND_MCP, TEST_REPORT, IMPLEMENTATION_GAPS, FINAL_ACTIVATION_CHECKLIST).
- edited (owned by other streams; small, additive): `packages/core/src/contracts/{v35-events,v35-automation,v35-inbox,v35-integrations,mcp}.ts`;
  `packages/services/src/engine/notify.ts` (bridge); `packages/services/src/automation/{engine,rules,install}.ts`;
  `packages/services/src/integrations-v35/{automation.ts,slack/service.ts,core/hub.ts}`; `packages/services/src/connectors/jobs.ts`
  (echo detection, requester re-check); `packages/services/src/inbox/{channels.ts,worker-more.ts}`; `packages/services/src/setup.ts`
  (`canSeeInstanceSetup`); `packages/services/src/product/activity.ts` (care category); `packages/services/src/mcp/{tools,principal}.ts`;
  `packages/providers/src/whatsapp/{inbox,inbox-fake}.ts` (template examples);
  `apps/web/components/{admin/nav.tsx,automation/rule-builder.tsx,integrations-hub/{hub-page,hub-shell,connector-page}.tsx,inbox/{context-panel,whatsapp-template-dialog}.tsx,assistant/classification-chip.tsx,deliveries/delivery-card.tsx}`;
  `apps/web/app/(app)/activity/page.tsx`; tests `tests/unit/{mcp,v2-product}.test.ts`, `tests/integration/{v35-connectors,v35-ai-automation,mcp}.test.ts`,
  `tests/e2e/inbox-more.spec.ts`; docs `docs/v3-5/{CAPABILITY_MATRIX,DATA_MODEL_AND_EVENTS}.md`, `docs/v3-5-progress/lead-notes.md`.
