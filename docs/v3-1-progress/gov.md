# V3.1 stream GOV — progress (resume point)

Brief: `docs/queue/03b_V3_1_PROMPT.md` §7, §12–§17. Contract: `docs/V3_1_WORKSTREAMS.md`.
Migration `022_v31_gov.sql` was APPLIED to dev by the lead → **FROZEN**. Any further schema goes in `024_v31_gov_more.sql` (additive). None needed so far.

## Status
- [x] 022 migration (tables below)
- [x] contracts `packages/core/src/contracts/v31-gov.ts`
- [x] services `packages/services/src/gov/**`
- [x] enforcement hooks: `posts/scheduling.ts` (createScheduleTx → `enforceBrandRules`), `product/readiness.ts` (`brand_rules` check + `brand_rules` field), `posts/service.ts` validatePost (`brand_rules` field), `ai/fidelity.ts` (`promise_language`)
- [x] dispatch version guard: `engine/claim.ts` `dispatchEnabled(db, version)` + `dispatchVersionAllowed`; `apps/worker/src/main.ts` passes `VERSION` (3 call sites)
- [x] API routes (below)
- [x] MCP: `mcp/tools-gov.ts` (get_brand_rules, get_integration_diagnostics), MCP_TOOLS + unit count 33, `docs/V3_MCP_GUIDE.md`
- [x] tests: unit `tests/unit/v31-gov.test.ts` (19), integration `tests/integration/v31-gov.test.ts` (19)
- [x] verified 08:59 UTC: root tsc clean except PERF's scripts/load-test-isolation.ts; pnpm test 479/479; integration 364/364 (two earlier runs hit transient failures while other streams edited engine/migrations mid-run; not reproducible)
- [ ] next (optional): engine hold for schedules with open mandatory reviews (needs lead decision; today: listed + preflight fails, dispatch unchanged)

## Migration 022 contents
brand_profiles, brand_rules, brand_rule_reviews, asset_governance, content_provenance, content_reuse_policy, content_queues,
content_queue_items, utm_defaults, tracked_links, tracked_link_clicks_daily, feature_flags (+6 seed rows, all off),
workspace_feature_flags, support_reports, release_note_reads, onboarding_progress. Additive only.

## API (for the UI stream; types in `@social-lite/core/contracts/v31-gov`)
| Route | Purpose | Permission |
|---|---|---|
| GET/PATCH `/api/brands/:id/profile` | BrandProfileDto (+impact on PATCH) | brands.read / brands.manage |
| GET/POST `/api/brands/:id/rules` | list / add BrandRuleDto → {rule, impact} | brands.read / brands.manage |
| PATCH/DELETE `/api/brand-rules/:id` | edit / archive → {rule?, impact} | brands.manage |
| GET `/api/brands/:id/rule-reviews?status=` | BrandRuleReviewDto[] (affected drafts/schedules) | content.read |
| POST `/api/rule-reviews/:id/decision` | {decision: keep\|will_edit\|cancel_schedule} | keep(schedule)=content.schedule, else content.edit |
| POST `/api/posts/:id/brand-check` | BrandCheckResult {ok, mandatory, advisory} | content.read |
| (existing) POST `/api/posts/:id/validate`, `/readiness` | now include `brand_rules`; readiness check key `brand_rules` | — |
| GET/PATCH `/api/assets/:id/governance` | AssetGovernanceDto | assets.read / assets.manage |
| GET `/api/brands/:id/asset-governance` | assets needing attention | assets.read |
| POST `/api/posts/:id/reuse` | {mode: reuse\|duplicate} → ReuseResult | content.create + content.read |
| GET `/api/posts/:id/provenance` | {derived_from, derivatives} | content.read |
| GET/PUT `/api/posts/:id/evergreen` | ReuseEligibility | content.read / content.edit |
| GET `/api/posts/:id/similar?days=` | SimilarPostWarning[] | content.read |
| GET/POST/PATCH `/api/brands/:id/content-queue` | ContentQueueDto / add {post_id} / {paused, reason} | content.read / content.edit / publishing.pause\|resume |
| POST `/api/brands/:id/content-queue/next` (Idempotency-Key) | schedule first eligible item into next slot | content.schedule (or submit on approval brands) |
| DELETE `/api/content-queue/items/:id` | remove queued item | content.edit |
| GET/PUT `/api/brands/:id/utm-defaults?campaign_id=` | UtmDefaultsDto | brands.read / brands.manage |
| POST `/api/links/preview` | LinkPreview | content.read |
| GET/POST `/api/links` · POST `/api/links/:id/disable` | TrackedLinkDto | content.read / content.edit |
| GET `/api/l/:code` (public) | 302 to stored destination, else 404 | — |
| GET `/api/campaigns/:id/measurement` | CampaignMeasurement (4 separate families) | analytics.read |
| GET `/api/integrations/diagnostics?brand_id=&connection_id=` | IntegrationDiagnosticsResponse (read-only) | connections.read |
| GET `/api/feature-flags` · PUT `/api/feature-flags/:key` | FeatureFlagsResponse / {enabled: bool\|null} | member / workspace.manage |
| GET/POST `/api/support/reports` | SupportReportDto (redacted) | audit.read / member |
| GET/POST `/api/release-notes` | ReleaseNotesResponse / {version} seen | member |
| GET/PATCH `/api/onboarding` | OnboardingState / {dismissed?, acknowledge?, unacknowledge?} | member |

## Behaviour notes
- **Mandatory vs advisory**: each finding carries its own severity. Mandatory → `validation_failed` with `details.reason='brand_rules'`, `details.brand_rules` (submit, schedule, publish now, queue). Advisory never blocks. Legacy `brands.voice.prohibited` = advisory (V1 UI only warned).
- **Rule changes** (rule/profile/asset governance) bump `brand_profiles.rules_version`, re-evaluate up to 500 drafts + 500 live schedules, and open one review per affected post. Content, revisions, schedules and deliveries are never modified. Decisions are explicit and audited.
- **TipSignal**: posts with `source.kind='tipsignal'` are checked against the validated event (`draftText` of the source event): every date/time/probability/score/result/name/link must survive; invented numbers, altered facts and promise language ("guaranteed", "sure win", "will win" …) are mandatory findings; a pick due after kick-off is refused. AI suggestions now also flag `promise_language` (block when the source has a probability or strict).
- **Reuse/queue**: evergreen is explicit; time-sensitive signals (TipSignal source or ancestry, dates/times, scores, percentages, ended campaign, expired content, promo tag without end date, expired asset) make content ineligible. A queue item is consumed once; a scheduled/published post can never be re-queued (unique index + `already_used`). Reuse = a new draft with provenance.
- **Links**: no open redirect (code-only lookup, stored destination re-validated at redirect time; unknown/disabled → 404). Clicks = daily counter, no IP/UA. Website events = `not_configured`; conversions = `unavailable`.
- **Diagnostics**: stored state only; integration test asserts outbox/deliveries/attempts/schedules/mock-provider/sync counters unchanged and no ciphertext in output.

## Rollout: one dispatching scheduler version (§16)
Delivery claims are atomic and fenced (a delivery is never sent twice), but two worker builds must not both dispatch during a rolling deploy:
1. Before deploying version N+1: `INSERT INTO system_flags(key,value,updated_by) VALUES ('dispatch_version','"<N>"','ops') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;` (or `setDispatchVersion('<N>', 'ops')`). Workers report their version (`APP_VERSION`) in `worker_heartbeats`.
2. Start N+1 workers: they run, but `dispatchEnabled(_, VERSION)` is false for them, so they never claim (claim loop, delivery-due queue, reconcile).
3. When N+1 is healthy, switch the pin to `"<N+1>"` in one statement; N workers stop claiming on their next loop (≤ a few seconds). In-flight N claims finish under their lease + fence.
4. Stop N workers; delete the `dispatch_version` row (absent = any version). Rollback = set the pin back to `"<N>"`.
Migrations stay additive (expand → migrate → contract) so both versions run against the same schema; GOV's 022 only adds tables.

## Files
- `packages/db/migrations/022_v31_gov.sql`
- `packages/core/src/contracts/v31-gov.ts`; shared edit `packages/core/src/contracts/mcp.ts` (+2 tools)
- `packages/services/src/gov/{index,rules-engine,brand-rules,assets,reuse,links,diagnostics,release,onboarding}.ts`
- `packages/services/src/mcp/tools-gov.ts`; shared edit `mcp/tools.ts` (2 lines)
- small edits: `posts/scheduling.ts`, `posts/service.ts` (validatePost), `product/readiness.ts`, `ai/{fidelity,types,index}.ts`, `engine/claim.ts`, `apps/worker/src/main.ts`
- routes under `apps/web/app/api/` (table above)
- tests: `tests/unit/v31-gov.test.ts`, `tests/integration/v31-gov.test.ts`, `tests/unit/mcp.test.ts` (count 33)
- docs: `docs/V3_MCP_GUIDE.md` (2 rows)
