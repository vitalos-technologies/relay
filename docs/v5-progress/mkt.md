# V5 stream MKT — marketing site, pricing presentation, signup flow

Resume point. Brief §1–8, §17; acceptance §18 items 1–7, 17, 18 (MKT part).

## Shared components — ready for WID / AIW (announce)
Dependencies added once to `apps/web/package.json` (exact): `@base-ui/react@1.9.0`, `motion@14.6.0`,
`class-variance-authority@0.7.1`, `tailwind-merge@3.7.0`. Do not add competing copies; add a primitive here with a note.

`apps/web/components/ui-v5/*` (shadcn/ui copy-ins, Base UI variant, adapted to namespaced `--v5-*` tokens):
| File | Exports | Notes |
|---|---|---|
| `cn.ts` | `cn` | clsx + tailwind-merge |
| `button.tsx` | `Button` (Base UI button), `ButtonLink` (plain `<a>`, server-safe), `buttonVariants` | variants `primary · outline · secondary · ghost · link`; sizes `sm · md · lg · icon`; shape `pill · rounded` |
| `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | server-safe |
| `badge.tsx` | `Badge`, `badgeVariants` | `primary · neutral · success · warn · outline`; server-safe span |
| `accordion.tsx` | `Accordion`, `AccordionItem`, `AccordionTrigger` (`headingLevel`), `AccordionContent` | client |
| `collapsible.tsx` | `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` | client, animated height |
| `sheet.tsx` | `Sheet`/`Dialog`, `SheetTrigger`, `SheetClose`, `SheetContent` (`side`: right/left/top/bottom/**full**), `DialogContent`, `SheetHeader`, `SheetTitle`, `SheetDescription` (+ Dialog* aliases) | Base UI Dialog: focus trap/return, Esc, inert + scroll lock; close button with label |
| `reveal.tsx` | `Reveal` | Motion (`motion/react-mini`) fade-in on scroll; content visible without JS / with reduced motion |

Tokens: `apps/web/app/globals.css` "V5 shared UI tokens" — utilities `bg-v5-primary`, `text-v5-fg`, `text-v5-muted`,
`border-v5-border`, `bg-v5-surface`, `bg-v5-raised`, `text-v5-primary-text`, `bg-v5-primary-soft`, `outline-v5-ring`, … In the
app they resolve to the app palette (orange); inside `.mkt` (marketing page) to purple.

Config for WID: `marketingConfig()` in `packages/services/src/marketing/config.ts` (contract
`packages/core/src/contracts/v5-marketing.ts`: `widget_enabled`, `widget_staffed`, `widget_in_app`, `privacy_url`,
`terms_url`, `support_email`). Default: widget off, not staffed ("Send us a message").

## Status
**Done** (2026-11-08). The stream is complete. Evidence and tests are green on a production build (see "Verification").

## Decisions
- Route move per D23: app home → `/overview` (`APP_HOME` in `contracts/v5-marketing.ts`); `/` = marketing page.
- Config stored in `system_flags` (key `marketing_config`) — no migration (039 not used).

## Done
- Dependencies, ui-v5 components, v5 tokens, marketing contract (`APP_HOME`, sections, `MarketingConfig`).
- Route move `/` → `/overview` (app shell nav, logo, admin "Back to Relay", app not-found, workspace switch/reload paths,
  onboarding, invite returnTo, OIDC default + `/` returnTo → `/overview`, notification/Slack/MCP home links) + tests updated
  (E2E helpers/specs that used `/` as the dashboard, `auth.test.ts`).
- Marketing page `apps/web/app/(marketing)/{layout,page}.tsx` + `marketing.css` (scoped purple palette, light + dark) and
  `components/marketing/*`: header + mobile menu sheet, hero + illustrative preview, capability strip, four product demos
  (interactive example previews + Explore dialogs; `#ai`), Connect your tools (honest statuses), pricing cards + team-size
  estimate + expandable comparison (all from `v4-plans.ts`), FAQ accordion (answers generated from catalogue/capabilities),
  final CTA, minimal footer (legal links from config; "not published yet" until set).
- Signup handoff: `/signup?plan=&seats=` shows seats × price = monthly total (SeatTotal); login page links to the trial.
- Platform → Marketing: `packages/services/src/marketing/config.ts` (`marketingConfig`, `platformMarketingConfig`,
  `updateMarketingConfig` — operator + fresh MFA + reason + platform audit; links/email validated on write AND read),
  `GET|PUT /api/platform/marketing`, admin page + nav entry.
- Local Keycloak realm: `registrationAllowed: true`, `registrationEmailAsUsername: true`, `verifyEmail: true` (JSON + applied
  live via the admin API; email verification keeps D20's verified-email binding safe).
- Tests: `tests/unit/v5-marketing.test.ts` (8), `tests/integration/v5-marketing.test.ts` (8), `tests/e2e/v5-marketing.spec.ts`
  (public part green on the dev server: 5 desktop+mobile).
- Evidence script `scripts/v5-mkt-shots.mjs` (shots + MOBILE_QA overflow incl. 200 % text).

## Hero = real dashboard capture (user request via lead)
- `scripts/seed-marketing-showcase.ts` (dev only, idempotent, refuses production): synthetic "Relay Showcase" workspace.
  Fictional "Lumen Lane Bakery" / "Lumen Lane Events" brands, owned by fictional "Ava Moreno". Healthy simulated
  destinations (Instagram, Facebook, LinkedIn, Threads, Bluesky). Five scheduled posts with artwork, 2 awaiting approval,
  published posts, 0 failed/expired. Synthetic analytics on the bakery brand ("Demo data"; the demo's accounts are renamed
  "… · insights" and un-paused, still flagged synthetic). Two simulated inbox conversations, onboarding dismissed. Also turns
  the support widget on in dev only. Purges a failed partial seed.
- `scripts/marketing-capture.mjs`: short-lived session (deleted after), `/overview` at 1280×800 CSS px with DPR 2, light +
  dark. Refuses an unstyled page. Hides the demo strip at capture time only. Writes
  `apps/web/public/marketing/overview-{light,dark}.webp`.
- Hero: next/image `getImageProps` → `<picture>` with a `prefers-color-scheme` source, AVIF/WebP (`images.formats`),
  2560×1600 intrinsic, `fetchPriority=high`, alt text. Served sizes: 1200w AVIF 27 KB light / 27 KB dark; 640w AVIF 11 KB.

## Verification (production build on :3000, under the lock)
- E2E `tests/e2e/v5-marketing.spec.ts`: **7 passed** (6 desktop + 1 `@mobile`; the `@mobile` test is skipped on desktop).
  Covers section anchors, account routes, branding / no fabrication, hero image (alt, size, AVIF/WebP), two plans + seat
  totals + comparison + handoff, FAQ / Explore / reduced motion / skip link, mobile menu focus + keyboard seat entry +
  overflow at 320–1440, signed-in "Open dashboard" → `/overview`, registration → email verify → workspace → 14-day
  Professional trial → Billing.
- Integration: `v5-marketing` 8 + `auth` + `v4-billing` → 43 passed. Unit: 624 passed (45 files, incl. `v5-marketing` 8).
  `pnpm -s typecheck` clean.
- Mobile QA (`evidence/v5/mkt/mobile-qa.json`): page-level overflow **0 px** at 320/360/390/430/768/1024/1440 and at 1440
  with 200 % zoom (720 CSS px), with the comparison table open.
- Contrast (computed): all text pairs ≥ 4.5:1 (see `marketing.css` header).

## Performance (`PERF=1 node scripts/v5-mkt-shots.mjs`, `evidence/v5/mkt/perf.json`)
Headless Chromium, cold cache per run, median of 5 runs. Mobile = 390×844 at DPR 2, 4× CPU, 150 ms RTT, 1.6/0.75 Mbps.
JS counts every script on the page, including WID's launcher (and its idle-loaded panel).
| State | `/` JS transfer | LCP desktop | LCP mobile | CLS |
|---|---|---|---|---|
| first build (core barrel leaked into the client, dialogs eager) | 258 KB (14 files) | 188 ms | 1648 ms | 0 |
| subpath imports + lazy Base UI dialogs | 176.5 KB | 208 ms | 1656 ms | 0 |
| + WID launcher, hand-built hero (before screenshot) | 203.1 KB | 236 ms | 1624 ms | 0 |
| **real dashboard hero (after)** | **208.2 KB** (15 files) | **232 ms** | **1712 ms** | **0** |
| `/login` baseline | 136.7 KB | 96 ms | 960 ms | 0 |
CSS 18.9 KB. Fonts: the 3 Inter/Geist files the root layout already preloads. One image (the hero).

## Files
New: `packages/core/src/contracts/v5-marketing.ts`, `packages/services/src/marketing/config.ts`, `apps/web/components/ui-v5/*`,
`apps/web/components/marketing/*`, `apps/web/app/(marketing)/*`, `apps/web/app/(app)/overview/page.tsx` (moved from
`(app)/page.tsx`), `apps/web/app/api/platform/marketing/route.ts`, `apps/web/app/(admin)/admin/platform/marketing/page.tsx`,
`tests/unit/v5-marketing.test.ts`, `tests/integration/v5-marketing.test.ts`, `tests/e2e/v5-marketing.spec.ts`,
`scripts/v5-mkt-shots.mjs`, `scripts/seed-marketing-showcase.ts`, `scripts/marketing-capture.mjs`,
`apps/web/public/marketing/overview-{light,dark}.webp`, `apps/web/components/marketing/{explore-panel,mobile-menu-sheet,seat-total}.tsx`,
`docs/v5/{MARKETING_PAGE_GUIDE,PLAN_AND_SEAT_DEFINITIONS,TRIAL_AND_SUBSCRIPTION_LIFECYCLE}.md`, `evidence/v5/mkt/*`.
Edited shared: `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/app/globals.css` (appended v5 tokens + print rule),
`apps/web/components/shell/{app-shell,logo}.tsx`, `apps/web/components/admin/{admin-shell,nav}.tsx`,
`apps/web/lib/client/{api,session}.tsx?`, `apps/web/lib/client/workspace-sync.ts`, `apps/web/app/(app)/not-found.tsx`,
`apps/web/app/onboarding/page.tsx`, `apps/web/app/invite/[token]/page.tsx`, `apps/web/app/login/page.tsx`,
`apps/web/app/signup/page.tsx`, `packages/services/src/auth/oidc.ts`, `packages/services/src/collab/notifications.ts`,
`packages/services/src/integrations-v35/slack/service.ts`, `packages/services/src/mcp/tools.ts`,
`infra/keycloak/social-lite-realm.json`, `tests/e2e/{helpers,v2-product,v31-ui,admin,publishing}.spec.ts`,
`tests/integration/auth.test.ts`, `apps/web/next.config.ts` (`images.formats` AVIF/WebP), `apps/web/components/billing/billing-settings.tsx`
(MFA hint instead of "only people who manage billing" for an owner without a second factor), `apps/web/components/ui/platform-icon.tsx`
and `apps/web/components/brand/relay-mark.tsx` (core subpath imports).

## Activation items
- Production self-registration: enable at the production IdP **with email verification** (+ `ALLOW_SELF_SERVE_WORKSPACES=true`
  in production, `canCreateWorkspace`).
- Publish Privacy notice + Terms and set their links in Platform → Marketing (no legal pages exist in the repo).
- Provider approvals listed in "Connect your tools" (unchanged from V3.5/V4 checklists).
