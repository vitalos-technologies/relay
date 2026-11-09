# Relay implementation discrepancies

These are defects found while writing the docs (streams HC, UG, IG, DV, 2026-11-09), plus the V4/V5 gap entries that
describe defects rather than planned work. The list is deduplicated. Nothing here has been fixed: the articles describe
today's behaviour honestly. Planned gaps stay in the `IMPLEMENTATION_GAPS.md` files. External steps are in
[../FINAL_ACTIVATION_CHECKLIST.md](../FINAL_ACTIVATION_CHECKLIST.md).

**Severity**
- **High:** customer-facing wrong behaviour, or a missed charge or consent.
- **Medium:** misleading UI or copy, a missing guard, or a breach of a project rule.
- **Low:** stale docs or internal issues.

**Fix size:** S = under half a day · M = 1–2 days · L = more.

Paths are relative to `apps/web/` (`app/…`, `components/…`) or `packages/` (`services/src/…`, `providers/src/…`,
`core/src/…`) unless they say otherwise.

## Recommended fix pass

| Order | ID | Fix | Size |
|---|---|---|---|
| 1 | H1 | TikTok comments silently disabled; creator_info interaction flags ignored | M |
| 2 | H2 | WhatsApp utility template charges treated as free | S |
| 3 | H3 | Library alt text never sent to any network | M |
| 4 | H4 | Ownership-transfer accept banner unreachable without `members.read`; no decline/cancel UI | M |
| 5 | H5 | Approvers (pause-only) can resume publishing | S |
| 6 | H6 | Analytics → Channels "Engagements" column always "—" | S |
| 7 | H7 | Connection cards say analytics unavailable for Facebook, Instagram and X | S |
| 8 | M1 | Model ids hard-coded in code (project rule) | M |
| 9 | M19 | MCP `entitlement_required` missing from `MCP_ERROR_CODES` | S |
| 10 | M23 | `/api/v1/drafts` not idempotent | S |
| 11 | M18 | Restricted help articles return HTTP 200 when signed in | S |
| 12 | L9 | E2E `integrations.spec` depends on suite order/state | S |

That's roughly 6–10 engineer-days in total. Rerun `node scripts/docs-api-check.mjs --write` and `pnpm docs:check` after
the fixes, then update the affected articles (they currently document the defects).

## High (7)

| ID | What's wrong | Where | User impact | Fix |
|---|---|---|---|---|
| H1 | The TikTok **Comments** switch shows ON when unset (`allowComment !== false`), but the adapter sends `disable_comment: allowComment !== true`. So comments are **disabled** unless the user toggles the switch. Also, `comment_disabled`/`duet_disabled`/`stitch_disabled` from creator_info are fetched but never used to grey out controls, and photo posts don't limit interactions to Comment, as TikTok's guidelines require | `components/composer/provider-options.tsx:61`; `providers/src/tiktok/adapter.ts:159,252`; `providers/src/tiktok/oauth.ts:64` | Posts go out with comments off against the creator's choice. Risk for the TikTok Direct Post audit | M |
| H2 | A utility template inside the 24-hour window is treated as free. Meta resumed charging on 2026-10-01, so no charge acknowledgement appears for a charged message. Meta's 1,000 free service messages/month aren't modelled. `docs/v3-5/INBOX_NETWORKS.md` "WhatsApp charges" is outdated | `providers/src/whatsapp/inbox.ts:139` | Customers are billed by Meta without the consent step Relay promises | S |
| H3 | Library alt text is never sent. The field says "Sent where the network supports it", but only Pinterest's per-destination option reaches a provider. The LinkedIn and Bluesky adapters read `options.altTexts`, which nothing fills | `app/(app)/library/page.tsx`; `providers/src/linkedin/adapter.ts:189`; `providers/src/bluesky/adapter.ts:120` | Published images lack alt text despite the UI's promise (accessibility) | M |
| H4 | The "Accept ownership" banner lives on `/team`, which says "No access" without `members.read`. An Editor recipient therefore can't accept. There's no UI to decline or cancel (the API `DELETE /api/workspace/ownership-transfers/:id` exists). The UI always keeps the previous owner as Admin, although the service supports `none` | `app/(app)/team/page.tsx:64`; `services/src/lifecycle.ts:321` | Ownership transfers stall until they expire (7 days) | M |
| H5 | Resume isn't gated by `publishing.resume`. Workspace and brand pause and resume both require `pause.emergency` (= `publishing.pause`), so Approvers (pause-only) can also resume | `services/src/workspaces.ts:211`; `services/src/brands.ts:134` | A role meant only to stop publishing can restart it | S |
| H6 | The Channels table "Engagements" column looks up a metric family `engagements`, but engagements is a measure. The column is always "—", while the comparison card below shows totals | `app/(app)/analytics/channels/page.tsx:10,47` | The analytics table looks broken or empty | S |
| H7 | Facebook, Instagram and X declare `canReadMetrics: false`, although their metric fetchers exist and sync reads them. Connection cards say "Analytics: Not available"; MCP `can_read_metrics` and diagnostics repeat it | `providers/src/meta/common.ts:107`; `providers/src/x/adapter.ts:67`; `services/src/mcp/tools.ts:299`; `services/src/gov/diagnostics.ts:118` | Customers are told analytics don't work for the main networks | S |

## Medium (24)

| ID | What's wrong | Where | User impact | Fix |
|---|---|---|---|---|
| M1 | **Model ids hard-coded in code**, against the project rule (no model names outside commit trailers): the `AI_MODEL` default, a fallback-model set and a per-model price table | `services/src/config.ts:41`; `services/src/ai/client.ts:33`; `services/src/ai/usage.ts:15-20` | None visible. It breaks the user's rule, and model changes need a code release | M |
| M2 | Meta requires `ads_management`/`ads_read` when the Page role comes from Business Manager; Relay doesn't request them. The Facebook Login for Business `config_id` gap is still open | `providers/src/meta/*` (OAuth scopes) | Publishing or insights fail as "Missing permission" for Business-Manager Pages | M |
| M3 | Threads' 5-link limit (enforced since 2025-12-22) isn't validated | `providers/src/threads/adapter.ts` | Fails at publish instead of in the composer | S |
| M4 | TikTok's 1080p photo maximum isn't validated (no max image dimension in `TIKTOK_CONSTRAINTS`) | `providers/src/tiktok/*` | Fails at publish instead of in the composer | S |
| M5 | Instagram `views` and `total_interactions` are registered as `available` with a 24 h delay. Meta marks them "in development", with delays up to 48 h | `services/src/analytics/registry.ts` | Freshness and coverage labels are too optimistic | S |
| M6 | The Mailchimp report shows 0 for missing values (`?? 0`), against the "missing is never 0" rule | `components/integrations-hub/post-integrations.tsx:109` | Fake zeros | S |
| M7 | Facebook reactions by type show as several unlabelled "Reactions" values (`m.name` without `m.dimension`) | `app/(app)/analytics/content/page.tsx:129` | Confusing duplicate rows in the post drawer | S |
| M8 | Content hub copy points to a non-existent "Settings → Sources" (the real path is Settings → Connections → Google Drive and Docs / Notion) | `components/content-hub/content-hub-panel.tsx:104` (+ comments in `content-hub/index.ts`, `source-connections.tsx`) | Dead-end instruction | S |
| M9 | The "Editors can publish" switch is still shown ("Off: editors submit for review") but has granted nothing since V2 | `components/settings/sections.tsx:188`; `services/src/posts/scheduling.ts:135` | Admins think they changed a permission | S |
| M10 | The invite dialog can't invite a Care agent (`MEMBER_ROLES` lacks `care_agent`; grant and team role lists include it) | `app/(app)/team/invitations/page.tsx:18` | A workaround is needed (invite, then grant) | S |
| M11 | The CSV import error lists only "instagram, facebook, telegram or x" (10 networks are accepted). `scheduled_local_time` is stored as `suggested_time` but never shown or used | `services/src/imports.ts:60` | Misleading error; a silently ignored column | S |
| M12 | The queue toast says "Add one in Settings → Slots"; the real path is Settings → Publishing → Posting slots | `components/slots/queue-button.tsx:30` | Dead-end instruction | S |
| M13 | The login page shows 4 network icons labelled "Supported networks: Instagram, Facebook, Telegram and X"; 10 are supported | `app/login/page.tsx:68` | Undersells the product; wrong screen-reader text | S |
| M14 | A real organisation name appears in synthetic copy: listening placeholders "Vitalos…" and the Demo Workspace brand "Vitalos (demo)" | `components/listening/search-form.tsx:72,81`; demo seed | Real brand in demo and placeholder data | S |
| M15 | The notification time zone's stored default is `UTC`, which isn't in the option list. The form shows *Africa/Abidjan* and saves it unchanged | `services/src/collab/notifications.ts:55` | A misleading time zone in settings | S |
| M16 | Overview says **Not confirmed** for the state the delivery badges call **Unknown — needs review** | `app/(app)/overview/page.tsx:32` | Two labels for one state | S |
| M17 | `reschedule()` for an over-limit account relies on the dispatch-time hold instead of refusing up front (V4 gap) | `services/src/posts/scheduling.ts` | The user learns at send time, not when rescheduling | S |
| M18 | Signed-in readers outside an article's audience get "Article not available" with **HTTP 200** (the shell's Suspense streams before `notFound()`). Signed out, it's a real 404. No content leaks | `app/(help)/help/[section]/[slug]/page.tsx:43` | Wrong status for crawlers and tools | S |
| M19 | `toToolError` can return `entitlement_required`, but it's missing from `MCP_ERROR_CODES`, so the generated error list omits it | `core/src/contracts/mcp.ts:129`; `services/src/mcp/principal.ts:118` | MCP clients can't anticipate a real error code | S |
| M20 | MCP `resources/list` lists brand-guidelines resources to principals that can't read them (`resources/read` → -32002). Seen live | `services/src/mcp/resources.ts:93` | Clients see resources that then fail | S |
| M21 | MCP `list_workspaces` reports all 13 scopes for API keys, although the service account's role limits the effective power (e.g. `integration` = drafts only) | `services/src/mcp/tools.ts` | Misleading capability report | S |
| M22 | The reference Keycloak `relay-mcp` client offers only the 7 V3 scopes; `inbox.*`, `cases.manage`, `listening.read` and `ai.prepare` can't be requested over OAuth | `infra/keycloak/social-lite-realm.json` | V3.5 MCP tools are unusable via OAuth on the reference realm | S |
| M23 | `/api/v1/drafts` reads no `Idempotency-Key`; MCP `create_draft` is idempotent | `app/api/v1/drafts/route.ts` | A retried script request creates duplicate drafts | S |
| M24 | `.env.example` lacks 92 env vars that code reads, including production-relevant ones (Stripe, KMS, MCP, `META_WEBHOOK_VERIFY_TOKEN`, `ALLOW_SELF_SERVE_WORKSPACES`), and its header still says "Social Lite" | `.env.example:1` | Deployments can miss config (prod boot catches some) | S |

## Low (14)

| ID | What's wrong | Where | User impact | Fix |
|---|---|---|---|---|
| L1 | Stale older docs (code wins):<br>• `docs/PERMISSIONS_MATRIX.md` lacks care_agent and the V3.5/V4 permissions.<br>• `docs/USER_LIFECYCLE.md` §7.6 says a removed member's service accounts keep working.<br>• DECISIONS D3 is superseded.<br>• `docs/ARCHITECTURE.md` says the idle timeout is 2 h (it's 30 min).<br>• `docs/DEPLOYMENT.md` and `OPERATIONS.md` predate V3–V5.<br>• `docs/V3_CONTENT_INTEGRATIONS.md` has an old Sources path and Notion rate limit.<br>• `docs/v3-5/CAPABILITY_MATRIX.md` lists Slack `users:read*`.<br>• Migration 034's comment says "no visitor flow" | listed | Readers of the old docs get wrong facts | M |
| L2 | 17 route files have no header comment, so they show "(no description in code)" in the API reference | `/api/approvals/{id}/approve`, `/reject`, `/api/dashboard`, `/api/deliveries/{id}/{resolve,retry}`, `/api/health`, `/api/history`, `/api/history/export.csv`, `/api/meta/data-deletion/status`, `/api/ops`, `/api/planner`, `/api/posts/{id}/{archive,deliveries,duplicate,validate}`, `/api/schedules/{id}/{cancel,reschedule}` | Thin API docs | S |
| L3 | `LIMITS.step_up_seconds` is `[60, 3600]`, but normalisation clamps to `[30, 3600]` | `services/src/security-policy.ts:30` | None visible | S |
| L4 | The `authz.ts` header says restriction → assurance → grants, but `evaluate()` checks grants before assurance. A user with neither gets `no_grant`, not `mfa_required` | `core/src/authz.ts` | Slightly misleading denial reason | S |
| L5 | The audit log page and nav gate on `workspace.settings`, not `audit.read`. The presets are the same today | `app/(app)/activity/page.tsx` | None today | S |
| L6 | The YouTube options `notifySubscribers` and `categoryId` exist in the adapter but have no UI | `providers/src/youtube/adapter.ts:50` | The options can't be used | S |
| L7 | Pre-existing lint errors (`react-hooks/set-state-in-effect`) | `components/settings-shell/settings-shell.tsx:31`; `components/shell/user-menu.tsx:24` | None | S |
| L8 | E2E tests don't run in CI | `.github/workflows/ci.yml` | Regressions caught late | M |
| L9 | E2E `integrations.spec` depends on order and state: it fails in the full suite and passes 5/5 alone (earlier cause: a simulated Asana install left in `reconnect_required` by another spec) | `tests/e2e/integrations.spec.ts` | A flaky full-suite signal | S |
| L10 | The `security.spec` back-channel logout test needs its own user isolation (open since Collaboration; HANDOFF) | `tests/e2e/security.spec.ts` | A flaky full-suite signal | S |
| L11 | The `v31-analytics-summary` integration test sometimes fails under full-suite load and passes alone | `tests/integration/v31-analytics-summary*` | A flaky signal | S |
| L12 | Contributor articles (`local-development-setup`, `environment-variables`, `data-model-and-migrations`) are `audience: developer`, so every signed-in member sees them. They contain no secrets; `admin` may suit them better | `content/help/developers/*` | Internal detail exposed to members | S |
| L13 | No KEK re-wrap tool: old key ids must stay configured until every blob is rewritten (`crypto.ts` says "rewrap lazily") | `services/src/crypto.ts` | Key rotation can't retire old keys | M |
| L14 | The web image never copied `apps/web/public`, so brand and marketing files would 404 in the image. **HC added the COPY** (plus `content/help`); no image has been built yet | `infra/docker/Dockerfile` | Fixed in the tree; needs an image build to confirm | S |

## Not included (planned gaps, tracked elsewhere)

These are tracked as planned work, not defects:
- custom video thumbnails
- connection-scoped grants in the Team UI
- followers and audience breakdowns (never fetched)
- API-only analytics features
- provider-side revocation beyond X, Slack, Google and Notion
- MCP sessions in process memory (needs sticky routing)
- self-service deletion and export
- an installation-wide AI kill switch
- annual billing, the refund button, inbound email replies
- the widget inside the app

See `docs/v4/IMPLEMENTATION_GAPS.md`, `docs/v5/IMPLEMENTATION_GAPS.md` and
[COVERAGE_MATRIX.md](COVERAGE_MATRIX.md) (rows marked Unsupported or Planned).
