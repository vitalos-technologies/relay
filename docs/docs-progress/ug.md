# UG — User + workspace-admin guide (progress)

Status: **done** — 97 articles, `node scripts/docs-check.mjs` passes, screenshots in place (resume point if reopened).
Owner: stream UG. Brief §3, §4, §9 of `docs/queue/04_DOCUMENTATION_PROMPT.md`; format per HC
(`packages/services/src/help/schema.ts`, `node scripts/docs-check.mjs`). No product code changed; no git state changes.

## Articles (slug = file name; `content/help/<section>/`)
- **publishing (19):** use-the-overview, create-a-post, shared-copy-and-channel-versions, add-images-albums-and-video,
  crop-images-for-each-channel, alt-text-and-accessible-media, organise-the-content-library, templates,
  import-posts-from-csv, check-before-sending, publish-now, version-history-and-restore, edit-at-the-same-time,
  recover-unsaved-changes, archive-trash-and-delete, bulk-actions, campaigns-tags-and-owners, brand-rules (needs-setup:
  flag), campaign-links-and-utm (needs-setup: flag).
- **calendar-and-scheduling (9):** use-the-planner, schedule-a-post, time-zones-and-dst, reschedule-pause-or-cancel,
  pause-publishing-in-an-emergency, posting-slots-and-queue, delivery-statuses, retry-or-resolve-a-delivery,
  delivery-history.
- **teams-and-approvals (21):** switch-workspaces-and-brands, roles-and-permissions (matrix generated from
  `authz.ts` PRESET_PERMISSIONS), invite-people, manage-invitations, accept-an-invitation,
  teams-and-delegated-administration, effective-access-and-overlapping-roles, submit-a-post-for-review,
  approve-or-request-changes, approval-policies-and-stages, when-an-approval-is-reset, guests-and-client-reviews,
  suspend-or-remove-a-member, transfer-ownership, reassign-work-and-held-posts, scheduled-posts-when-someone-leaves,
  comments-internal-notes-and-client-comments, tasks-and-deadlines, notifications-and-preferences,
  collaboration-settings, audit-log.
- **account-security (8):** sign-in-and-sign-out, set-up-two-step-verification, recovery-codes-and-lost-factors,
  step-up-verification, manage-sessions, workspace-security-policy, service-accounts-and-api-keys,
  profile-appearance-and-accessibility.
- **inbox-and-care (5; IG owns inbox-channels-by-network, whatsapp-in-the-inbox, google-reviews-in-the-inbox):**
  work-in-the-inbox, reply-and-add-internal-notes (not-live-verified), cases-and-service-levels,
  saved-replies-and-views, link-a-customer-across-channels.
- **listening (3, not-live-verified):** set-up-listening, read-listening-results, listening-alerts-and-dashboards.
- **ai-and-mcp (5, user side; DV owns MCP):** use-the-ai-workspace (needs-setup), ai-help-while-writing-and-replying
  (needs-setup), approved-knowledge-and-brand-voice, automation-rules-and-policies (needs-setup), ai-limits-privacy-and-usage.
- **billing-and-plans (7):** plans-and-features, start-a-free-trial, manage-seats, change-plan-or-cancel,
  invoices-and-payment-details, when-paid-actions-are-paused, usage-and-limits. (Live payments = needs-setup: no Stripe keys.)
- **support (5):** contact-relay-support, track-your-support-requests, support-access, report-a-problem,
  chat-with-relay-from-the-website (needs-setup: widget default off).
- **troubleshooting (9):** troubleshooting-catalogue (A–Z messages → fix), why-cant-i-see-or-do-this, cant-sign-in,
  invitation-link-not-working, publishing-failed, post-not-sent-on-time, upload-failed-or-media-rejected,
  notifications-not-arriving, ai-not-working.
- **administration (6):** settings-reference (every Settings group/sub-setting → permission → article),
  use-the-admin-console, workspace-and-brand-settings, feature-flags, export-workspace-data, inbound-sources.

Total UG: 97 (incl. settings-reference). Audiences: admin only where the reader needs `workspace.manage` (invite, suspend/remove, audit, billing
changes, service accounts, support access, collaboration settings, automation, inbound sources, admin console,
settings reference); everything team managers / brand managers / publishers need is `user`.

## Drift guard (new file, for the lead to wire into CI)
`scripts/docs-role-matrix.ts` regenerates the two matrix tables in `roles-and-permissions.md` from `authz.ts`;
`npx tsx scripts/docs-role-matrix.ts --check` exits 1 when the article is stale (passes today). Suggest adding it next to
`pnpm docs:check` in `.github/workflows/ci.yml` (lead/HC own CI).

## Suggested `<HelpLink>` placements for HC (slugs exist)
| Place | Slug |
|---|---|
| Team → member → Effective access / Restrictions | effective-access-and-overlapping-roles |
| Team → Invitations (Invite dialog) | invite-people |
| Team → Teams / team page "What managers can grant" | teams-and-delegated-administration |
| Team → Held | reassign-work-and-held-posts |
| Member page Suspend/Remove dialog | suspend-or-remove-a-member |
| Member page "Make owner" | transfer-ownership |
| Schedule / Reschedule dialog (deadline, time zone) | schedule-a-post (+ time-zones-and-dst) |
| Publish now dialog | publish-now |
| Composer Readiness card | check-before-sending |
| Composer media "About media" | add-images-albums-and-video |
| Library alt-text field | alt-text-and-accessible-media |
| Delivery card (Unknown / Retry / Resolve) | retry-or-resolve-a-delivery |
| Emergency pause dialog / Publishing paused banner | pause-publishing-in-an-emergency |
| Review panel "Reset — the post changed" / approval "Invalidated" banner | when-an-approval-is-reset |
| Review shares (Client guest) | guests-and-client-reviews |
| Discussion "About discussions" | comments-internal-notes-and-client-comments |
| Tasks page "About tasks" | tasks-and-deadlines |
| Trash page / Move to Trash dialog | archive-trash-and-delete |
| Version history panel | version-history-and-restore |
| Conflict dialog "Someone else saved a newer version" | edit-at-the-same-time |
| CSV import dialog | import-posts-from-csv |
| Bulk preview | bulk-actions |
| Settings → Workspace → Plan and billing | plans-and-features / change-plan-or-cancel |
| "Paid actions paused" strip | when-paid-actions-are-paused |
| Settings → Operations → Usage and limits; Admin → Usage | usage-and-limits |
| Settings → Operations → Feature flags | feature-flags |
| Settings → Operations → Data export | export-workspace-data |
| Settings → Publishing → Defaults | workspace-and-brand-settings |
| Settings → Publishing → Safety rules | check-before-sending |
| Settings → Inbox → Service levels / Saved replies | cases-and-service-levels / saved-replies-and-views |
| Settings → Listening → Sources | set-up-listening |
| Settings → AI and automation → Brand voice / Inbound sources | approved-knowledge-and-brand-voice / inbound-sources |
| Settings → Developer → API and service accounts | service-accounts-and-api-keys |
| Assistant ("AI is not set up" banner) / Automation | use-the-ai-workspace / automation-rules-and-policies |
| Help → Contact support / My requests | contact-relay-support / track-your-support-requests |
| Admin → Security and audit → Support access | support-access |
| Audit log page | audit-log |
| Security page (sessions) | manage-sessions |
| Workspace security policy | workspace-security-policy |
| Notifications page / bell "All notifications" | notifications-and-preferences |
| Planner header | use-the-planner |
| Overview "Needs attention" (HC placed delivery-statuses) | delivery-statuses |
| Sign-in error page | cant-sign-in |
| Invite acceptance page errors | invitation-link-not-working |

## Glossary terms for HC (definitions as used in UG articles)
Base content (shared copy) · Channel version / destination version (inherited vs custom) · Destination · Delivery ·
Revision (frozen copy sent/approved) · Deadline (publish-before window; expires instead of posting late; default 15 min) ·
Unknown / not confirmed · Manual handoff · Held (authority hold) · Adopt · Partial success · Simulated destination ·
Approval policy · Stage · Quorum · Separation of duties · Invalidated review · Guest (client reviewer, expiring) ·
Review share · Internal note vs shared comment · Restriction (deny) · Effective access · Scope (workspace/brand/connection) ·
Step-up (fresh verification) · Recovery code · Service account · Posting slot · Content queue (evergreen) · Brand rules
(mandatory/advisory) · Billable user / seat · Restricted (paid actions paused) · Allowance · Budget (safety cap) ·
Case · Service level (SLA) · Saved reply · Listening search · Unique mention · Share of voice · Coverage · Approved knowledge ·
Automation policy · Emergency stop · Support access.

## Coverage rows (page / action / role → implementation → article → verification)
Verification: **C** = checked against code; **U** = seen in the running app (text dump / screenshot, synthetic seeds);
**P** = needs provider credentials/approval, not live-verified.

| Page / action | Implementation | Article | Ver. |
|---|---|---|---|
| Role presets + permission matrix | packages/core/src/authz.ts (PRESET_PERMISSIONS, WORKSPACE_ONLY, SENSITIVE_PERMISSIONS, evaluate, canDelegate) | roles-and-permissions | C (generated) |
| Workspace switcher, brand filter, ⌘K search | components/shell/{workspace-switcher,brand-filter,command-menu}.tsx | switch-workspaces-and-brands | C |
| Grouped nav + role-based phone bar (D28/D29) | components/shell/nav-config.ts | use-the-overview, switch-workspaces-and-brands | C |
| Overview cards/banners/lists | app/(app)/overview/page.tsx | use-the-overview | C |
| Invite member/guest, bulk invite | app/(app)/team/invitations/page.tsx, services/auth/invitations.ts | invite-people | C |
| Resend/revoke/expiry | same | manage-invitations, invitation-link-not-working | C |
| Accept invitation | app/invite/[token]/page.tsx, app/login/page.tsx | accept-an-invitation | C |
| Teams, managers, delegation ceilings, archive | app/(app)/team/teams/**, services/teams.ts | teams-and-delegated-administration | C |
| Effective access, add grant (expiry), restrictions | app/(app)/team/members/[userId]/page.tsx, services/members.ts | effective-access-and-overlapping-roles | C |
| Suspend / reactivate / remove + handover | same + services/lifecycle.ts | suspend-or-remove-a-member | C |
| Ownership transfer + last-owner protection | services/lifecycle.ts (TRANSFER_TTL 7 d, assertNotLastOwner) | transfer-ownership | C |
| Held publications + adoption | app/(app)/team/held/page.tsx, services/engine/authority.ts | reassign-work-and-held-posts, scheduled-posts-when-someone-leaves | C |
| Admin → Reassign work | app/(admin)/admin/collaboration/reassign | reassign-work-and-held-posts | C |
| Approval policy (0–2 stages, quorum, roles, teams, guests, SoD, weakening step-up, plan gate) | components/collab/approval-policy-card.tsx, services/posts/approval-policy.ts | approval-policies-and-stages | C |
| Submit / approve / request changes / invalidation | components/composer/action-dialogs.tsx, app/(app)/approvals/**, services/posts/{scheduling,service}.ts | submit-a-post-for-review, approve-or-request-changes, when-an-approval-is-reset | C |
| Guest review portal + shares | app/review/**, components/collab/review-shares.tsx, services/collab/review.ts | guests-and-client-reviews | C |
| Discussions (internal/shared, mentions, anchors, visibility change) | components/collab/discussion.tsx | comments-internal-notes-and-client-comments | C |
| Tasks | app/(app)/tasks/page.tsx, components/collab/tasks.tsx | tasks-and-deadlines | C |
| Notifications centre + prefs | app/(app)/notifications, components/collab/notification-prefs.tsx | notifications-and-preferences, notifications-not-arriving | C |
| Collaboration settings, notification delivery | app/(admin)/admin/collaboration/** | collaboration-settings | C |
| Audit log + CSV | app/(app)/activity/page.tsx, api/activity/export | audit-log | C |
| Sign-in, sessions 30 min / 12 h | services/auth/session.ts, app/login | sign-in-and-sign-out, cant-sign-in | C |
| MFA factors, recovery codes, sessions | components/security/security-page.tsx (Keycloak AIA) | set-up-two-step-verification, recovery-codes-and-lost-factors, manage-sessions | C; factor enrolment itself not exercised (Keycloak flow) |
| Step-up | authz.ts SENSITIVE_PERMISSIONS, lifecycle/grants step-up checks | step-up-verification | C |
| Workspace security policy (defaults 72 h, 5 min, 30/90 d) | components/settings/security-policy.tsx, services/security-policy.ts | workspace-security-policy | C |
| Service accounts + keys (5/account, ≤1 y, rotate/revoke/disable, owner suspension) | components/settings/service-accounts.tsx, services/service-accounts.ts | service-accounts-and-api-keys | C |
| Profile, appearance | components/settings/sections.tsx | profile-appearance-and-accessibility | C |
| Create post, drafts, autosave | app/(app)/compose, components/composer/composer.tsx | create-a-post | C |
| Base content vs variants, provider options | components/composer/{editors,provider-options}.tsx | shared-copy-and-channel-versions | C |
| Media picker, ordering, limits (20 MB img, 300 MB/15 min video) | components/composer/media-picker.tsx, services/media/{process,video}.ts | add-images-albums-and-video, upload-failed-or-media-rejected | C |
| Crops | components/crops/* | crop-images-for-each-channel | C |
| Alt text | app/(app)/library/page.tsx, providers/pinterest | alt-text-and-accessible-media | C (gap reported) |
| Library, templates | app/(app)/library/page.tsx | organise-the-content-library, templates | C |
| CSV import (512 KB, 200 rows) | components/import/csv-import-dialog.tsx, services/imports.ts | import-posts-from-csv | C |
| Preview + readiness preflight | components/composer/preview.tsx, services/product/readiness.ts, core/validation.ts | check-before-sending | C |
| Publish now | action-dialogs.tsx PublishNowDialog | publish-now | C |
| Schedule / DST / deadline | components/schedule/schedule-time-field.tsx, services/posts/scheduling.ts | schedule-a-post, time-zones-and-dst | C |
| Reschedule / cancel | components/planner/reschedule-dialog.tsx, deliveries-panel.tsx, scheduling.ts | reschedule-pause-or-cancel | C |
| Emergency pause (workspace/brand) | components/shell/emergency-pause.tsx, services/{workspaces,brands}.ts | pause-publishing-in-an-emergency | C |
| Posting slots, queue, evergreen queue (flag) | components/slots/*, app/(app)/queue | posting-slots-and-queue | C |
| Delivery states, retries (5 attempts), unknown/resolve | core/{state-machine,retry}.ts, components/deliveries/delivery-card.tsx, engine/manual.ts | delivery-statuses, retry-or-resolve-a-delivery, publishing-failed, post-not-sent-on-time | C |
| History + CSV | app/(app)/history/page.tsx | delivery-history | C |
| Version history, conflicts, local recovery | components/collab/history-panel.tsx, composer/draft-resilience.tsx, settings/draft-recovery.tsx | version-history-and-restore, edit-at-the-same-time, recover-unsaved-changes | C |
| Archive / Trash (30 d) | services/data/trash.ts, app/(app)/trash | archive-trash-and-delete | C |
| Bulk actions | components/bulk/bulk.tsx | bulk-actions | C |
| Campaigns, owners, teams, tags | app/(app)/campaigns, components/collab/planning-panel.tsx | campaigns-tags-and-owners | C |
| Brand rules + licences (flag) | components/brand-rules/* | brand-rules | C |
| Campaign links/UTM (flag) | components/links/links.tsx | campaign-links-and-utm | C |
| Planner views/filters/conflicts (15 min) | app/(app)/planner/page.tsx | use-the-planner | C |
| Inbox queues, assign, statuses, moderation | components/inbox/{inbox-app,thread}.tsx | work-in-the-inbox | C; P for live networks |
| Reply modes, notes, results, reply window | components/inbox/thread.tsx, labels.ts | reply-and-add-internal-notes | C; P |
| Cases + SLAs (SLA edit = Professional) | components/inbox/{context-panel,settings}.tsx, services/inbox/cases.ts | cases-and-service-levels | C |
| Saved replies, saved views, identity linking, CSAT | components/inbox/{settings,saved-views-panel,identity-panel,csat-panel}.tsx | saved-replies-and-views, link-a-customer-across-channels | C |
| Listening sources/searches/results/alerts/dashboards | components/listening/* | set-up-listening, read-listening-results, listening-alerts-and-dashboards | C; broad listening = unsupported |
| AI workspace (5 workflows + Ask), action review | components/ai-workspace/*, services/ai-workflows | use-the-ai-workspace | C; P (no AI provider key) |
| In-context assistant | components/assistant/* | ai-help-while-writing-and-replying | C; P |
| Brand voice, approved knowledge | settings/sections.tsx (voice), ai-workspace knowledge | approved-knowledge-and-brand-voice | C |
| Automation policies/rules/stop | components/automation/* | automation-rules-and-policies | C; P for AI replies |
| Plans, allowances, seats, trial | core/contracts/v4-plans.ts | plans-and-features, start-a-free-trial | C |
| Billing settings (change, cancel, resume, invoices, payment) | components/billing/billing-settings.tsx | manage-seats, change-plan-or-cancel, invoices-and-payment-details | C; P (Stripe test double only) |
| Restriction / held work | docs/v4/FAILED_PAYMENT_AND_DOWNGRADE.md ↔ components/entitlements/* | when-paid-actions-are-paused | C |
| Usage + budgets | components/entitlements/workspace-usage.tsx, integrations/budgets-settings.tsx | usage-and-limits | C |
| Contact support, My requests, support access, problem reports | components/support/{customer,share-report}.tsx, admin/security/support | contact-relay-support, track-your-support-requests, support-access, report-a-problem | C |
| Marketing support widget | components/support-widget/* | chat-with-relay-from-the-website | C; widget off by default |
| Settings registry (every group/item) | components/settings-shell/registry.tsx | settings-reference | C |
| Admin console nav | components/admin/nav.tsx | use-the-admin-console | C |
| Workspace general/time zone, brands, publishing defaults | components/settings/sections.tsx | workspace-and-brand-settings | C |
| Feature flags | core/contracts/v31-gov.ts FEATURE_FLAGS, support.tsx | feature-flags | C |
| Data export (handover ZIP/JSON) | components/product/brand-product-settings.tsx | export-workspace-data | C |
| TipSignal inbound | components/integrations/integrations-settings.tsx | inbound-sources | C; P (signing secret) |
| Not covered by UG (owned elsewhere) | Connections/networks, content sources, business apps, analytics (IG); MCP, /setup instance setup, /operations queues (DV) | — | — |

## Discrepancies found (reported, not fixed)
1. **"Editors can publish"** switch (Settings → Publishing → Defaults, `sections.tsx`) is still shown with "Off: editors
   submit for review." but grants nothing since V2 (`posts/scheduling.ts`: "brands.editors_can_publish no longer grants
   anything"). Misleading control; documented as a no-op.
2. **Library alt text is never sent to a network.** The field's info says "Sent where the network supports it." Only the
   Pinterest per-destination **Alt text** option reaches a provider; LinkedIn/Bluesky adapters read `options.altTexts`,
   which nothing populates. Documented honestly in alt-text-and-accessible-media.
3. **Invite dialog can't invite a Care agent** (`team/invitations/page.tsx` MEMBER_ROLES lacks `care_agent`, while
   GRANT_ROLES/TEAM_ROLES include it). Workaround documented.
4. **Ownership transfer UI gaps:** the "Accept ownership" banner lives on `/team`, which returns "No access" for users
   without `members.read`, so e.g. an Editor recipient can't accept in the UI; no UI to cancel/decline a pending transfer
   (API `DELETE /api/workspace/ownership-transfers/:id` exists); previous owner always kept as Admin (hard-coded).
5. **Resume isn't gated by `publishing.resume`:** workspace and brand pause/resume both use `pause.emergency`
   (= `publishing.pause`), so Approvers (pause-only) can also resume (`services/workspaces.ts`, `services/brands.ts`).
6. **CSV import** unknown-destination message lists only "instagram, facebook, telegram or x" (10 providers accepted);
   `scheduled_local_time` is stored as `suggested_time` in `posts.source` but never shown or used.
7. **Queue toast** "No posting slots — Add one in Settings → Slots." — the path is Settings → Publishing → Posting slots.
8. **Login page** network row: 4 icons with aria-label "Supported networks: Instagram, Facebook, Telegram and X" — 10
   networks exist.
9. **Real organisation name in synthetic/demo copy:** listening search form placeholder "Vitalos", "Vitalos, Vitalos Café,
   #vitalos"; Demo Workspace brand "Vitalos (demo)". Avoided in screenshots (used Relay Showcase).
10. **Earlier docs are stale (code wins):** `docs/PERMISSIONS_MATRIX.md` lacks care_agent and V3.5/V4 permissions;
    `docs/USER_LIFECYCLE.md` §7.6 says a removed member's service accounts keep working — `removeMember` now disables them
    and revokes keys unless reassigned; DECISIONS D3 (single-stage, self-approval) superseded by V2 0–2 stage policies
    with optional separation of duties.
11. **No custom video thumbnail** (brief §3 lists thumbnails): poster frame is extracted automatically; documented as a limitation.
12. **Connection-scoped grants** are supported by policy and API (`connection_id`) but the Team UI only offers workspace/brand.
13. Audit log page/nav gate on `workspace.settings` (= `workspace.manage`) rather than `audit.read`; same presets today,
    so no visible effect.
14. **Notification time zone default:** stored default is `UTC` (`collab/notifications.ts`), which isn't in the
    `allTimeZones()` option list, so Settings → Personal → Notifications shows *Africa/Abidjan* (first option) until the
    person saves; saving without changing it stores Africa/Abidjan (same offset, but misleading). Seen in the running app.

## Verification in the running app (2026-11-09, production build on :3000, synthetic seeds)
- **Text dumps** (owner, Demo Workspace; session inserted as in `scripts/v4-final-shots.mjs`): 67 pages — Overview,
  Planner, Create, Library, Campaigns, Approvals, Inbox, Listening, Assistant, Automation, Tasks, Team (+ Invitations,
  Teams, Held posts), Connections, Notifications, Security, Audit log, Trash, History, Queue, Setup, Operations, Help
  (+ Contact, Requests), every `/settings/<group>/<item>`, and Admin overview / collaboration / usage / support access /
  people / approvals / AI / care / publishing / setup / content. UI labels in articles were corrected from these
  (e.g. "Held posts" tab, "Create draft", "From Drive or Notion", "New" service account, "General question" support
  category, "Free guests 1 (up to 5)", feature flags "Off · default", hidden Brand rules / Campaign links while flags off).
- **Screenshots** (1440 px unless noted, light, deviceScaleFactor 1, "Relay Showcase" workspace unless noted; the demo
  strip hidden at capture time as in D27), all with alt text in the articles:
  `apps/web/public/help/img/publishing/{overview-dashboard,composer-with-deliveries,content-library}.png`,
  `calendar-and-scheduling/{planner-week,planner-phone (390 px),schedule-dialog}.png`,
  `teams-and-approvals/{approvals-list,review-detail,approval-policy,invite-dialog,notification-settings}.png`,
  `account-security/security-page.png` (E2E Workspace), `billing-and-plans/plan-and-billing.png` (E2E Billing, test mode),
  `inbox-and-care/inbox.png`, `ai-and-mcp/ai-workspace.png`, `support/contact-support.png`.
  Discarded: member effective-access, first invite dialog, listening, first inbox (E2E/Demo data with hash names or the
  real-organisation demo brand); no listening/effective-access screenshot ships.
- **Not verified in the running app** (code-checked only): role-specific views (editor, care agent, guest portal,
  team manager) — only the owner view was dumped; performing actions end to end (scheduling, approving, retry/resolve,
  suspend/remove, ownership transfer, adoption, bulk actions, CSV import, trash/restore) — relied on code + existing E2E
  suites; Keycloak factor enrolment/recovery; email delivery; live networks and inbox channels (P); Stripe checkout/portal
  (test double only); AI model output (no provider key); support widget (off by default); optional features behind flags
  (brand rules, campaign links, content queue, onboarding checklist, release notes, diagnostics) — off in the seeds.
