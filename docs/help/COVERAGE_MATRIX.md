# Relay documentation coverage matrix

This matrix merges the "Coverage rows" from the four docs streams (`docs/docs-progress/{hc,ug,ig,dv}.md`), checked on
2026-11-09. Each row maps a feature to its code and its documentation. Articles are Help Centre slugs under
`content/help/<section>/`.

**Runbooks are repo-only.** `docs/runbooks/*` and `docs/api/*` are never served by the Help Centre and never included
in the offline bundle.

- Defects found while documenting: [DISCREPANCIES.md](DISCREPANCIES.md).
- External steps: [../FINAL_ACTIVATION_CHECKLIST.md](../FINAL_ACTIVATION_CHECKLIST.md).
- Paths are relative to `apps/web/` (`app/…`, `components/…`) or `packages/` (`services/src/…`, `providers/src/…`,
  `core/src/…`) unless they say otherwise.

## Status legend and counts

| Status | Meaning |
|---|---|
| **Verified** | Available, and verified locally: by tests, by the running app on synthetic data, or by a generated reference with a drift check. App-owned. No live provider is needed |
| **Not live-verified** | Implemented. Exercised only on simulated transports or fixtures, or checked by reading the code, never against a live provider or a production deployment |
| **Needs setup** | Implemented, but it needs configuration, a feature flag, credentials or provider approval before anyone can use it (see the activation checklist) |
| **Unsupported** | Deliberately not supported, or not usable in the product today |
| **Planned** | Planned, not implemented |

| Area | Verified | Not live-verified | Needs setup | Unsupported | Planned | Rows |
|---|---|---|---|---|---|---|
| 1. Pages and actions | 62 | 4 | 8 | 3 | 1 | 78 |
| 2. Roles and permissions | 6 | 0 | 0 | 1 | 0 | 7 |
| 3. Integrations | 1 | 4 | 24 | 0 | 1 | 30 |
| 4. Analytics metrics | 12 | 2 | 0 | 1 | 0 | 15 |
| 5. Configuration | 4 | 1 | 1 | 0 | 0 | 6 |
| 6. API and MCP | 13 | 2 | 4 | 0 | 0 | 19 |
| 7. Background processes | 7 | 1 | 3 | 0 | 0 | 11 |
| 8. Runbooks (repo only) | 0 | 19 | 0 | 0 | 0 | 19 |
| **Total** | **105** | **33** | **40** | **5** | **2** | **185** |

"Verified" for app-owned pages means the streams checked the article against the code. Most pages were also seen in
the running app (UG text dumps of 67 pages). The actions themselves are covered by the existing unit, integration and
E2E suites; the docs streams did not re-run each one end to end. Publishing actions were verified on simulated
destinations only; real network delivery is tracked in the Integrations rows.

## 1. Pages and actions

| Item | Implementation | Documentation | Status |
|---|---|---|---|
| Help Centre home, search, sections | `app/(help)/help/page.tsx`, `components/help/help-search.tsx`, `/api/help/search` | use-the-help-centre | Verified |
| Help article page (sidebar, breadcrumbs, related, sources) | `app/(help)/help/[section]/[slug]/page.tsx` | use-the-help-centre | Verified |
| Contextual help links (44 placements) | `components/help/help-link.tsx` | use-the-help-centre | Verified |
| Offline help bundle | `services/src/help/bundle.ts`, `/api/help/bundle`, `scripts/docs-bundle.mjs` | use-the-help-centre | Verified |
| Admin articles list | `app/(admin)/admin/help/page.tsx` | — | Verified |
| Marketing site, pricing, seat estimate, signup handoff | `app/(marketing)/*`, `components/marketing/*`, `app/signup/**` | plans-and-features, start-a-free-trial | Verified |
| Production self-sign-up and onboarding | `app/signup/**`, `app/onboarding/page.tsx` | create-your-workspace | Needs setup |
| Main nav, top bar, role-based phone bar, ⌘K | `components/shell/*`, `nav-config.ts` | find-your-way-around, switch-workspaces-and-brands | Verified |
| Workspace switcher, brand filter | `components/shell/{workspace-switcher,brand-filter}.tsx` | switch-workspaces-and-brands | Verified |
| Overview cards, banners, lists | `app/(app)/overview/page.tsx` | use-the-overview | Verified |
| Invite member or guest, bulk invite (Care agent missing from dialog) | `app/(app)/team/invitations/page.tsx`, `services/src/auth/invitations.ts` | invite-people | Verified |
| Resend, revoke, expiry of invitations | same | manage-invitations, invitation-link-not-working | Verified |
| Accept invitation | `app/invite/[token]/page.tsx`, `app/login/page.tsx` | accept-an-invitation | Verified |
| Suspend, reactivate, remove + handover | `app/(app)/team/members/[userId]/page.tsx`, `services/src/lifecycle.ts` | suspend-or-remove-a-member | Verified |
| Ownership transfer, last-owner protection | `services/src/lifecycle.ts` | transfer-ownership | Verified |
| Held publications, adoption, reassign work | `app/(app)/team/held/page.tsx`, `services/src/engine/authority.ts`, `app/(admin)/admin/collaboration/reassign` | reassign-work-and-held-posts, scheduled-posts-when-someone-leaves | Verified |
| Approval policy (0–2 stages, quorum, SoD, plan gate) | `components/collab/approval-policy-card.tsx`, `services/src/posts/approval-policy.ts` | approval-policies-and-stages | Verified |
| Submit, approve, request changes, invalidation | `components/composer/action-dialogs.tsx`, `app/(app)/approvals/**` | submit-a-post-for-review, approve-or-request-changes, when-an-approval-is-reset | Verified |
| Guest review portal and shares | `app/review/**`, `services/src/collab/review.ts` | guests-and-client-reviews | Verified |
| Discussions (internal/shared, mentions) | `components/collab/discussion.tsx` | comments-internal-notes-and-client-comments | Verified |
| Tasks | `app/(app)/tasks/page.tsx`, `components/collab/tasks.tsx` | tasks-and-deadlines | Verified |
| Notifications centre and preferences | `app/(app)/notifications`, `components/collab/notification-prefs.tsx` | notifications-and-preferences, notifications-not-arriving | Verified |
| Collaboration settings, notification delivery | `app/(admin)/admin/collaboration/**` | collaboration-settings | Verified |
| Audit log + CSV | `app/(app)/activity/page.tsx`, `/api/activity/export` | audit-log | Verified |
| Sign-in, sessions (30 min idle / 12 h) | `services/src/auth/session.ts`, `app/login` | sign-in-and-sign-out, cant-sign-in | Verified |
| MFA factors, recovery codes, sessions (Keycloak enrolment not run by the docs streams) | `components/security/security-page.tsx` | set-up-two-step-verification, recovery-codes-and-lost-factors, manage-sessions | Verified |
| Workspace security policy | `components/settings/security-policy.tsx`, `services/src/security-policy.ts` | workspace-security-policy | Verified |
| Service accounts and API keys | `components/settings/service-accounts.tsx`, `services/src/service-accounts.ts` | service-accounts-and-api-keys | Verified |
| Profile and appearance | `components/settings/sections.tsx` | profile-appearance-and-accessibility | Verified |
| Create post, drafts, autosave | `app/(app)/compose`, `components/composer/composer.tsx` | create-a-post | Verified |
| Shared copy vs channel versions, provider options | `components/composer/{editors,provider-options}.tsx` | shared-copy-and-channel-versions | Verified |
| Media picker, ordering, limits | `components/composer/media-picker.tsx`, `services/src/media/*` | add-images-albums-and-video, upload-failed-or-media-rejected | Verified |
| Per-channel crops | `components/crops/*` | crop-images-for-each-channel | Verified |
| Alt text: Pinterest per-destination option | `providers/src/pinterest` | alt-text-and-accessible-media | Not live-verified |
| Alt text: Library field sent to networks | `app/(app)/library/page.tsx` (nothing populates `options.altTexts`) | alt-text-and-accessible-media | Unsupported |
| Custom video thumbnail (poster frame is automatic) | `services/src/media/video.ts` | add-images-albums-and-video | Unsupported |
| Content library, templates | `app/(app)/library/page.tsx` | organise-the-content-library, templates | Verified |
| CSV import (512 KB, 200 rows) | `components/import/csv-import-dialog.tsx`, `services/src/imports.ts` | import-posts-from-csv | Verified |
| Preview and readiness preflight | `components/composer/preview.tsx`, `services/src/product/readiness.ts` | check-before-sending | Verified |
| Publish now | `components/composer/action-dialogs.tsx` | publish-now | Verified |
| Schedule, DST, deadline | `components/schedule/schedule-time-field.tsx`, `services/src/posts/scheduling.ts` | schedule-a-post, time-zones-and-dst | Verified |
| Reschedule, cancel | `components/planner/reschedule-dialog.tsx` | reschedule-pause-or-cancel | Verified |
| Emergency pause, workspace and brand (resume gate defect) | `components/shell/emergency-pause.tsx`, `services/src/{workspaces,brands}.ts` | pause-publishing-in-an-emergency | Verified |
| Posting slots and queue | `components/slots/*`, `app/(app)/queue` | posting-slots-and-queue | Verified |
| Evergreen content queue (flag `v31.content_queue`) | `app/(app)/queue` | posting-slots-and-queue | Needs setup |
| Delivery states, retries, unknown/resolve | `core/src/{state-machine,retry}.ts`, `components/deliveries/delivery-card.tsx` | delivery-statuses, retry-or-resolve-a-delivery, publishing-failed, post-not-sent-on-time | Verified |
| Delivery history + CSV | `app/(app)/history/page.tsx` | delivery-history | Verified |
| Version history, conflicts, local recovery | `components/collab/history-panel.tsx`, `components/composer/draft-resilience.tsx` | version-history-and-restore, edit-at-the-same-time, recover-unsaved-changes | Verified |
| Archive and Trash (30 days) | `services/src/data/trash.ts`, `app/(app)/trash` | archive-trash-and-delete | Verified |
| Bulk actions | `components/bulk/bulk.tsx` | bulk-actions | Verified |
| Campaigns, owners, teams, tags | `app/(app)/campaigns`, `components/collab/planning-panel.tsx` | campaigns-tags-and-owners | Verified |
| Brand rules and licences (flag `v31.brand_rules`) | `components/brand-rules/*` | brand-rules | Needs setup |
| Campaign links and UTM (flag `v31.tracked_links`) | `components/links/links.tsx` | campaign-links-and-utm | Needs setup |
| Planner views, filters, conflicts | `app/(app)/planner/page.tsx` | use-the-planner | Verified |
| Inbox queues, assign, statuses, moderation | `components/inbox/{inbox-app,thread}.tsx` | work-in-the-inbox | Not live-verified |
| Inbox reply modes, notes, reply window | `components/inbox/thread.tsx` | reply-and-add-internal-notes | Not live-verified |
| Cases and service levels | `components/inbox/context-panel.tsx`, `services/src/inbox/cases.ts` | cases-and-service-levels | Verified |
| Saved replies, saved views, identity linking, CSAT | `components/inbox/{settings,saved-views-panel,identity-panel,csat-panel}.tsx` | saved-replies-and-views, link-a-customer-across-channels | Verified |
| Listening on connected sources (searches, results, alerts, dashboards) | `components/listening/*` | set-up-listening, read-listening-results, listening-alerts-and-dashboards | Not live-verified |
| Broad listening (X, Reddit, news, web) | none (no adapters) | set-up-listening | Unsupported |
| AI workspace (5 workflows + Ask, action review) | `components/ai-workspace/*`, `services/src/ai-workflows` | use-the-ai-workspace | Needs setup |
| In-context assistant | `components/assistant/*` | ai-help-while-writing-and-replying | Needs setup |
| Brand voice, approved knowledge | `components/settings/sections.tsx`, ai-workspace knowledge | approved-knowledge-and-brand-voice | Verified |
| Automation policies, rules, emergency stop (AI replies need key) | `components/automation/*` | automation-rules-and-policies | Verified |
| AI limits, privacy, usage | `services/src/product/budgets.ts`, `services/src/ai/usage.ts` | ai-limits-privacy-and-usage, ai-not-working | Verified |
| Plans, allowances, seats, trial | `core/src/contracts/v4-plans.ts` | plans-and-features, start-a-free-trial | Verified |
| Billing: change, cancel, resume, invoices, payment (Stripe test double only) | `components/billing/billing-settings.tsx` | manage-seats, change-plan-or-cancel, invoices-and-payment-details | Needs setup |
| Paid actions paused / held work | `components/entitlements/*` | when-paid-actions-are-paused | Verified |
| Usage and budgets | `components/entitlements/workspace-usage.tsx`, `components/integrations/budgets-settings.tsx` | usage-and-limits | Verified |
| Contact support, My requests, support access, problem reports | `components/support/{customer,share-report}.tsx`, `app/(admin)/admin/security/support` | contact-relay-support, track-your-support-requests, support-access, report-a-problem | Verified |
| Marketing support widget (off by default) | `components/support-widget/*`, `services/src/support/widget*.ts` | chat-with-relay-from-the-website | Needs setup |
| Settings registry (every group/item) | `components/settings-shell/registry.tsx` | settings-reference | Verified |
| Admin console navigation | `components/admin/nav.tsx` | use-the-admin-console | Verified |
| Workspace general, time zone, brands, publishing defaults | `components/settings/sections.tsx` | workspace-and-brand-settings | Verified |
| Feature flags | `core/src/contracts/v31-gov.ts` | feature-flags | Verified |
| Data export (handover ZIP/JSON) | `components/product/brand-product-settings.tsx` | export-workspace-data | Verified |
| Self-service account/workspace deletion, personal-data export | none | `docs/runbooks/data-export-and-deletion.md` | Planned |
| Troubleshooting catalogue (messages → fix) | across the app | troubleshooting-catalogue, why-cant-i-see-or-do-this | Verified |

## 2. Roles and permissions

| Item | Implementation | Documentation | Status |
|---|---|---|---|
| Role presets and permission matrix (generated, drift check `scripts/docs-role-matrix.ts --check`) | `core/src/authz.ts` | roles-and-permissions | Verified |
| Effective access, grants with expiry, restrictions | `app/(app)/team/members/[userId]/page.tsx`, `services/src/members.ts` | effective-access-and-overlapping-roles | Verified |
| Connection-scoped grants (API and policy only; the Team UI offers workspace/brand only) | `core/src/authz.ts` (`connection_id`) | effective-access-and-overlapping-roles | Unsupported |
| Teams, managers, delegation ceilings | `app/(app)/team/teams/**`, `services/src/teams.ts` | teams-and-delegated-administration | Verified |
| Step-up for sensitive permissions | `core/src/authz.ts` SENSITIVE_PERMISSIONS | step-up-verification | Verified |
| Guests (client reviewers, expiring) | `services/src/collab/review.ts` | guests-and-client-reviews | Verified |
| Help Centre audience filtering (public/user/admin/developer, guests) | `services/src/help/access.ts`, `library.ts` | use-the-help-centre | Verified |

## 3. Integrations

| Item | Implementation | Documentation | Status |
|---|---|---|---|
| Connect, select destinations, reconnect, pause, disconnect | `services/src/connections/{manage,oauth}.ts`, `app/(app)/accounts/**` | connect-social-accounts | Not live-verified |
| Connection states and fixes | `lib/client/{capability-state,connection-fix}.ts` | connection-status-and-fixes | Verified |
| Network app setup (Setup page) | `services/src/settings.ts`, `connections/manage.ts` | set-up-social-network-apps | Needs setup |
| Limits per network | `providers/src/*/adapter.ts` | network-limits-at-a-glance | Not live-verified |
| Instagram (image, carousel ≤ 20, Reel; insights; DMs/comments) | `providers/src/meta/{instagram,carousel,metrics,inbox-instagram}.ts` | instagram | Needs setup |
| Facebook Page (text/link, photos ≤ 10, video; insights; Messenger) | `providers/src/meta/{facebook,facebook-media,metrics,inbox}.ts` | facebook | Needs setup |
| Telegram (text + buttons, photo, album, video; bot inbox) | `providers/src/telegram/*` | telegram | Not live-verified |
| X (text, ≤ 4 images, video; billed reads; budgets) | `providers/src/x/*`, `services/src/engine/budget.ts` | x-twitter | Needs setup |
| TikTok (direct / inbox handoff / manual) | `providers/src/tiktok/*` | tiktok | Needs setup |
| YouTube (video; release modes; analytics; comments) | `providers/src/youtube/*`, `services/src/engine/provider-scheduling.ts` | youtube | Needs setup |
| LinkedIn (member + organisation) | `providers/src/linkedin/*` | linkedin | Needs setup |
| Threads (text, image, video, carousel; replies) | `providers/src/threads/*` | threads | Needs setup |
| Pinterest (boards; trial vs standard) | `providers/src/pinterest/*` | pinterest | Needs setup |
| Bluesky (app password; text + ≤ 4 images; inbox) | `providers/src/bluesky/*` | bluesky | Not live-verified |
| Content sources: authorise, select, snapshots, access loss | `services/src/content-hub/*`, `components/content-hub/*` | content-sources-overview, google-drive-and-docs, notion, refresh-imported-content | Needs setup |
| Content exports (Doc, Drive file, Notion page) | `services/src/content-hub/exports.ts` | export-to-google-docs-drive-and-notion | Needs setup |
| Notion writeback | `services/src/content-hub/writeback.ts` | notion-writeback | Needs setup |
| Business apps hub (connect, resources, sync rules, history) | `services/src/integrations-v35/core/*`, `components/integrations-hub/*` | business-apps-overview | Needs setup |
| Asana | `services/src/integrations-v35/asana`, `providers/src/asana` | asana | Needs setup |
| monday.com | `integrations-v35/monday` | monday-com | Needs setup |
| HubSpot | `integrations-v35/hubspot` | hubspot | Needs setup |
| Slack | `integrations-v35/slack` | slack | Needs setup |
| Mailchimp | `integrations-v35/mailchimp` | mailchimp | Needs setup |
| Google Business Profile (posts, metrics) | `integrations-v35/gbp` | google-business-profile | Needs setup |
| Cloud Translation | `integrations-v35/translate` | cloud-translation | Needs setup |
| TipSignal inbound drafts | `components/integrations/integrations-settings.tsx` | inbound-sources | Needs setup |
| Inbox capabilities per network | `services/src/inbox/capabilities.ts` | inbox-channels-by-network | Needs setup |
| WhatsApp channel and charges | `providers/src/whatsapp/inbox.ts`, `services/src/inbox/channels-whatsapp.ts` | whatsapp-in-the-inbox | Needs setup |
| Google reviews in the Inbox | `providers/src/google-business/inbox.ts` | google-reviews-in-the-inbox | Needs setup |
| X, LinkedIn, TikTok inbox channels | none (no adapter) | inbox-channels-by-network | Planned |

## 4. Analytics metrics

| Item | Implementation | Documentation | Status |
|---|---|---|---|
| Analytics views, filters, compare, dataset | `app/(app)/analytics/**`, `services/src/analytics/{query,filters}.ts` | use-analytics | Verified |
| Measures (17), combination rules, states | `services/src/analytics/{registry,semantics}.ts` | analytics-metric-dictionary | Verified |
| Native metrics per network (55 definitions) | `services/src/analytics/registry.ts`, `providers/src/*/metrics.ts` | metrics-by-network | Not live-verified |
| Lifetime-by-publish-date basis; reach ≠ unique | `semantics.ts`, `query.ts` | lifetime-totals-and-reach | Verified |
| Refresh cadence, delays, coverage, stale (48 h), retention | `analytics/{cadence,retention,index}.ts` | data-status-and-freshness | Verified |
| Engagement rate and comparisons | `semantics.ts`, `query.ts` | engagement-rate-and-comparisons | Verified |
| Content table, drawer, channel comparison (Engagements column defect) | `app/(app)/analytics/{content,channels}/page.tsx` | content-and-channel-rankings | Verified |
| Video analytics | `app/(app)/analytics/video/page.tsx` | video-and-audience-analytics | Verified |
| Followers and audience breakdowns (never fetched; demo data only) | `app/(app)/analytics/audience/page.tsx` | video-and-audience-analytics | Unsupported |
| Workflow reporting | `app/(app)/analytics/workflow/page.tsx` | workflow-reporting | Verified |
| Exports (CSV, PDF → HTML fallback) and saved reports | `services/src/analytics/{reports,render,pdf}.ts` | analytics-exports-and-reports | Verified |
| API-only analytics: best time, saved reports, report export to Google/Notion, campaign/team filters | `/api/analytics/{best-time,reports}` | analytics-exports-and-reports, engagement-rate-and-comparisons | Verified |
| Calculated insights; AI `explain_analytics` needs a key | `query.ts`, `services/src/assistant/{prompt,retrieval}.ts` | calculated-insights-and-ai | Verified |
| Overview tiles, SLA, CSAT, listening counts | `app/(app)/overview/page.tsx`, `core/src/contracts/{v35-listening,v35-sla}.ts` | other-metrics-in-relay | Verified |
| GBP location metrics, Mailchimp campaign report | `providers/src/{google-business,mailchimp}/client.ts` | other-metrics-in-relay | Not live-verified |

## 5. Configuration

| Item | Implementation | Documentation | Status |
|---|---|---|---|
| 124 environment variables (92 not in `.env.example`) | `services/src/config.ts`, `settings.ts`, `mcp/config.ts`, `billing/provider.ts` | environment-variables (enforced by `scripts/docs-api-check.mjs`) | Verified |
| Production fail-closed rules | `services/src/config.ts` `assertProductionSafe` | environment-variables; `docs/runbooks/deployment-and-configuration.md` | Verified |
| Setup page (installation-wide, protected) | `services/src/setup.ts` | environment-variables; `docs/runbooks/deployment-and-configuration.md` | Not live-verified |
| Clean-environment local setup (install → migrate → seed → web + worker) | `scripts/dev.sh`, `packages/db` | local-development-setup | Verified |
| Docs check, role-matrix drift check, API/MCP drift check in CI | `scripts/docs-check.mjs`, `scripts/docs-role-matrix.ts`, `scripts/docs-api-check.mjs`, `.github/workflows/ci.yml` | testing-and-contributing | Verified |
| Production identity provider and self-registration | `infra/keycloak/social-lite-realm.json` (reference), `services/src/auth/oidc.ts` | authentication-and-authorization; `docs/runbooks/keycloak-and-self-registration.md` | Needs setup |

## 6. API and MCP

| Item | Implementation | Documentation | Status |
|---|---|---|---|
| Member API routes (610 handlers incl. 26 public) | `app/api/**/route.ts` | api-route-reference (generated), api-conventions | Verified |
| Live-probed guards: auth, CSRF/origin/workspace, error envelope, keyset pagination, health/ready | same | api-conventions | Verified |
| Platform-operator routes (61 handlers) | `app/api/platform/**` | `docs/api/routes.md`, `docs/api/openapi.json` (repo only) | Verified |
| `/api/v1` API-key routes (`drafts`, `me`; drafts not idempotent) | `app/api/v1/**` | api-conventions, service-accounts-and-api-keys | Verified |
| Widget routes (10) | `app/api/widget/**` | webhooks (widget section) | Needs setup |
| MCP core reads: `list_workspaces`, `list_brands`, `list_connections`, `get_capabilities`, `search_content`, `get_post`, `list_calendar` | `services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | Verified |
| MCP drafts and sources: `create_draft`, `update_draft`, `list_sources`, `preview_source`, `import_source_to_draft`, `get_import_status` | `tools.ts` | mcp-tool-reference, mcp-server | Verified |
| MCP review and publishing: `validate_post`, `submit_for_review`, `get_review_status`, `prepare_publication`, `commit_publication`, `get_delivery_status`, `cancel_schedule`, `pause_brand` | `tools.ts` | mcp-tool-reference, mcp-worked-examples | Verified |
| MCP analytics (tested): `analytics_overview`, `create_report_export`, `get_job_status` | `tools.ts` | mcp-tool-reference, mcp-worked-examples | Verified |
| MCP analytics (live only, no test): `get_metric_definitions`, `get_data_coverage` | `tools.ts` | mcp-tool-reference | Verified |
| MCP `query_analytics` (no test; only the denial path seen live) | `tools.ts` | mcp-tool-reference, mcp-worked-examples | Not live-verified |
| MCP data and governance: `search`, `get_draft_recovery_status`, `preview_bulk_action`, `get_bulk_job_status`, `get_brand_rules`, `get_integration_diagnostics` | `mcp/tools-data.ts`, `mcp/tools-gov.ts` | mcp-tool-reference | Verified |
| MCP inbox, cases, listening (tested): `list_conversations`, `get_conversation`, `draft_reply`, `assign_conversation`, `create_case`, `update_case`, `list_listening_searches`, `query_listening`, `list_listening_alerts` | `mcp/tools-v35.ts` | mcp-tool-reference | Verified |
| MCP untested: `list_cases`, `get_case`, `get_listening_alert`, `get_ai_result` | `mcp/tools-v35.ts` | mcp-tool-reference | Not live-verified |
| MCP `prepare_with_ai` | `mcp/tools-v35.ts` | mcp-tool-reference | Needs setup |
| MCP resources (4; guidelines over-advertised) and prompts (2) | `mcp/resources.ts` | mcp-tool-reference, mcp-server | Verified |
| MCP auth: API keys, revocation, protected-resource metadata, 401 challenge | `mcp/{auth,server,registry}.ts` | mcp-server | Verified |
| MCP OAuth with real clients (only JWT-override tests so far) | `mcp/auth.ts`; production IdP | mcp-server; `docs/runbooks/mcp-connection-and-auth-failures.md` | Needs setup |
| MCP V3.5 scopes over OAuth (the local realm has only the 7 V3 scopes) | `infra/keycloak/social-lite-realm.json` | mcp-server | Needs setup |

## 7. Background processes

| Item | Implementation | Documentation | Status |
|---|---|---|---|
| Outbox → pg-boss dispatcher, dead letters | `services/src/engine/outbox-dispatcher.ts`, `apps/worker/src/main.ts` | background-jobs-and-media | Verified |
| Claim loops, leases, fencing, sweeps, reconcile | `engine/{claim,process,reconcile}.ts` | publishing-engine-and-delivery-states | Verified |
| Delivery state machine | `core/src/state-machine.ts` | publishing-engine-and-delivery-states | Verified |
| Workload classes and pools | `services/src/workload/policy.ts` | background-jobs-and-media | Not live-verified |
| Periodic loops (heartbeat … retention) | `apps/worker/src/main.ts` | background-jobs-and-media | Verified |
| Media image/video pipeline | `services/src/media/*` | background-jobs-and-media | Verified |
| Analytics sync, ingest, rollups, retention (simulated providers) | `services/src/analytics/*` | analytics-ingestion | Verified |
| Content Hub import, refresh, writeback, export | `services/src/content-hub/*` | content-source-imports-and-exports | Needs setup |
| Webhooks (providers, connectors, Stripe, Notion, Drive, TipSignal, Meta callbacks) | `services/src/webhooks.ts`, `connectors/*`, `billing/webhooks.ts`, `content-hub/webhooks.ts`, `meta-callbacks.ts` | webhooks | Needs setup |
| Billing sweeps and reconciliation | `services/src/billing/reconcile.ts` | webhooks | Needs setup |
| Widget abuse controls (rate buckets, honeypot, time trap, block) | `services/src/support/widget*.ts` | webhooks (widget section) | Verified |

## 8. Runbooks (repo only)

All runbooks were written from code. None has been exercised against a production deployment, because none exists.

| Item | Implementation | Documentation | Status |
|---|---|---|---|
| Deploy, configure, roll back | `services/src/config.ts`, `setup.ts`, `infra/docker/Dockerfile` | `docs/runbooks/deployment-and-configuration.md` | Not live-verified |
| Health and monitoring | `/api/health`, `/api/ready`, worker `/health` | `docs/runbooks/health-and-monitoring.md` | Not live-verified |
| Worker and queue failures | `engine/outbox-dispatcher.ts`, `apps/worker/src/main.ts` | `docs/runbooks/worker-and-queue-failures.md` | Not live-verified |
| Expired provider auth | `services/src/connections/*` | `docs/runbooks/expired-provider-auth.md` | Not live-verified |
| Rate limits and budgets | `engine/budget.ts`, `product/budgets.ts` | `docs/runbooks/rate-limits-and-budgets.md` | Not live-verified |
| Failed and ambiguous publications | `engine/{process,reconcile}.ts` | `docs/runbooks/failed-and-ambiguous-publications.md` | Not live-verified |
| Media processing failures | `services/src/media/*` | `docs/runbooks/media-processing-failures.md` | Not live-verified |
| Source sync failures (content, analytics, business apps) | `content-hub/*`, `analytics/*`, `integrations-v35/*` | `docs/runbooks/source-sync-failures.md` | Not live-verified |
| MCP connection and auth failures | `services/src/mcp/*` | `docs/runbooks/mcp-connection-and-auth-failures.md` | Not live-verified |
| Emergency pause | `services/src/{workspaces,brands}.ts` | `docs/runbooks/emergency-pause.md` | Not live-verified |
| Migration and rollback | `packages/db/migrations`, `scripts/migration-rehearsal.sh` | `docs/runbooks/migration-and-rollback.md` | Not live-verified |
| Backup, restore, reconciliation | `engine/reconcile.ts` | `docs/runbooks/backup-restore-and-reconciliation.md` | Not live-verified |
| Key rotation and security incidents | `services/src/crypto.ts` | `docs/runbooks/key-rotation-and-security-incidents.md` | Not live-verified |
| Data export and deletion; Meta deletion callbacks | `services/src/meta-callbacks.ts`, `app/api/meta/*` | `docs/runbooks/data-export-and-deletion.md` | Not live-verified |
| Billing webhooks and reconciliation | `billing/{webhooks,reconcile}.ts` | `docs/runbooks/billing-webhooks-and-reconciliation.md` | Not live-verified |
| Support widget abuse | `support/widget*.ts` | `docs/runbooks/support-widget-abuse.md` | Not live-verified |
| AI budget exhaustion | `ai/usage.ts`, `product/budgets.ts` | `docs/runbooks/ai-budget-exhaustion.md` | Not live-verified |
| Keycloak and self-registration | `auth/oidc.ts`, `infra/keycloak/*` | `docs/runbooks/keycloak-and-self-registration.md` | Not live-verified |
| Container restart recovery | `infra/compose.yaml`, `scripts/dev.sh` | `docs/runbooks/container-restart-recovery.md` | Not live-verified |
