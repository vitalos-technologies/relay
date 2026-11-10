# Marketing page guide (V5 §1–4, §17; stream MKT)

One public, server-rendered page at **`/`**, **light only** (user request 2026-11-10: it ignores `prefers-color-scheme` and the
app's saved theme via `components/marketing/force-light.tsx`; the signed-out Help Centre shell does the same; the app keeps
its own light/dark). The signed-in app home moved to **`/overview`** (D23). Signed-in visitors on
`/` are not redirected: the header, hero, final band and footer show **Open dashboard** instead of Log in / Start free trial.

## Where things live
| Part | Code |
|---|---|
| Route + layout | `apps/web/app/(marketing)/page.tsx`, `layout.tsx`, `marketing.css` (palette scoped to `.mkt`, D24) |
| Sections | `apps/web/components/marketing/*` — `site-header` + `mobile-menu`, `hero`, `capability-strip`, `product-demos` + `demos` + `explore-dialog`, `integrations-section` (+ `integrations-data`, `tool-icon`), `pricing-section` + `pricing-cards` + `plan-comparison` (+ `plan-data`), `faq-section` (+ `content`), `final-cta`, `site-footer` |
| Shared V5 UI (also used by WID/AIW) | `apps/web/components/ui-v5/*` — Button/ButtonLink, Card, Badge, Accordion, Collapsible, Sheet/Dialog, Reveal |
| Configuration | Platform → Marketing (`/admin/platform/marketing`), `packages/services/src/marketing/config.ts`, contract `packages/core/src/contracts/v5-marketing.ts` |
| Signup handoff | `apps/web/app/signup/page.tsx` (+ `components/marketing/seat-total.tsx`, paid plans only) → `/signup/workspace?plan=` (V4; `free` creates a Free workspace) |

## Sections (brief §4 order)
1. **Header** — Relay mark (back to top), anchors **Product · AI · Integrations · Pricing · FAQ** (same page), Log in, Start
   free trial / Open dashboard, mobile menu (Base UI Dialog sheet; section links close it, scroll, and focus the heading).
2. **Hero** — "Your social world. Working together." / "Plan content, manage conversations, and get work done with AI."
   Start free trial → `/signup`; **Explore Relay** → `#product` (no genuine demo video exists, so no "Watch demo"). No price
   line under the CTAs (user request; pricing lives in the Pricing section). Depth: the frame and the two floating cards sit
   on separate z-layers that drift at different speeds while the hero scrolls away and tilt slightly with the pointer on
   desktop (`marketing-motion.tsx` HeroMotion; Motion `scroll()` + `motion/mini` WAAPI, transform only).
   Product visual = a **real capture of Relay's Overview** from the synthetic "Relay Showcase" workspace (fictional bakery
   brand and person; `scripts/seed-marketing-showcase.ts`, dev only), captured by `scripts/marketing-capture.mjs`
   (1280×800 CSS px, DPR 2, light, refuses an unstyled page; the demo strip is hidden at capture time only). Source:
   `apps/web/public/marketing/overview-light.webp`; served by next/image (`getImageProps`): AVIF/WebP per Accept header,
   reserved 2560×1600 intrinsic size, `fetchPriority` high, descriptive alt. Window frame + two floating component cards (Scheduled toast, "AI drafted 3 captions"). Captioned
   "Illustrative preview with example content". Re-capture after UI changes: seed → capture → rebuild.
3. **Capability strip** — Plan · Engage · Understand · Collaborate.
4. **Product demonstrations** (`#product`) — Publishing and scheduling (pick networks → real per-network length checks on an
   example caption), Social inbox (filter by conversation type), Analytics and listening (7/28-day toggle on labelled example
   data, coverage line), AI assistant (`#ai`; suggested tasks → observable steps). Every preview is tagged **Example**.
   **Explore …** opens an accessible inline preview (dialog) with what is included, which plan, and what still needs provider
   access.
5. **Connect your tools** (`#integrations`, never "Trusted by") — every implemented publishing network (`PROVIDERS`) and the
   implemented apps (V3.5 connector registry, content hub, MCP). Tiles are icon, name and one line (user request 2026-11-10:
   no legend, status badges, notes or disclaimer line). The intro keeps the honesty disclosure: "The networks and apps Relay
   connects to. Some go live as each network approves Relay’s access." Statuses stay in `integrations-data.ts` and on each
   tile as `data-status`. Slack and monday.com are not in `simple-icons`, so they get monogram tiles.
6. **Pricing** (`#pricing`) — three cards from `publicCatalogue()` (D33): **Free £0** (1 user, "No card required",
   **Start free** → `/signup?plan=free`, no trial wording), **Standard £5** and **Professional £15** per user / month
   ("14 days free", "No card required", **Start free trial**); Professional stays highlighted. A team-size stepper (paid
   plans only) shows *N users · £total / month after the trial* per paid plan (`recurringTotalMinor`) and carries
   `?plan=…&seats=N` to `/signup`; Free shows *1 user · £0 / month · no teammates*. "Compare plans and allowances" expands a
   table generated from the catalogue's features, limits/allowances (users, brands, accounts, scheduled posts, storage, AI
   first) and trial allowances (Free: "–", no trial). Tax: "Any tax is shown at checkout" (no inclusive/exclusive claim).
7. **FAQ** (`#faq`) — trial (ends on Free, nothing deleted), what Free includes, per-user pricing, channels, teammates,
   cancellation (back to Free), AI/integration limits. Answers are generated
   in `content.ts` from the catalogue and capability data and match `docs/v4/*` (see the unit test).
8. **Final invitation** and **footer** — sections, account actions, Support (`/help/contact`, via sign-in for visitors;
   optional public support email), Privacy / Terms from Platform → Marketing ("not published yet" until configured — no
   legal pages exist in the repository; activation item).

Not built on purpose (mockup notes): "Trusted by" logos, stats band, testimonials, dropdown menus. (A third tier was
excluded until D33 added Free.)

## Platform → Marketing
Any platform role can read; **operators** change it with a fresh MFA sign-in and a reason (platform audit
`marketing.config_updated` with a before/after diff). Fields: support widget on/off, staffed live chat (off ⇒ the widget
says "Send us a message"; forced off when the widget is off), widget in the app, privacy and terms links (same-site path or
https only), public support email. Stored in `system_flags.marketing_config`; values are re-validated on read so a tampered
row cannot put an unsafe link on the page. There is **no public settings API** — the page reads it server-side and WID calls
`marketingConfig()`.

## Performance and accessibility
- Server-rendered; the app shell/providers are never loaded on `/`. Client islands: mobile menu button, four demo previews,
  explore triggers, pricing stepper, comparison, FAQ accordion, `Reveal`. Base UI Dialog (mobile menu sheet, Explore
  previews) loads on first hover/focus/tap, not with the page. Demo previews are HTML/CSS/SVG; the only image is the hero
  screenshot. One font family (Inter, self-hosted). Client components import core via subpaths (`@social-lite/core/types`,
  `/brand`) so the core barrel (zod, twitter-text + polyfills) never reaches the page bundle.
- Motion: CSS entrance on the hero; `Reveal` (Motion `motion/react-mini`) brings blocks in with a per-section effect (fade-up
  headings, staggered rise on the capability strip, scale-in on integration tiles and pricing cards, slides from alternating
  sides on product cards, left/right on the FAQ, scale on the final band), only after hydration and only if they start below
  the viewport — content is visible without JS, with reduced motion, and in print. Hero depth and the product stack: see
  above. Hover lift (`.mkt-lift`) on pricing cards and integration tiles. Transform/opacity only; everything is static with
  `prefers-reduced-motion: reduce`.
- Keyboard: skip link first; visible focus rings; Base UI accordion/collapsible/dialog semantics (aria-expanded, focus trap +
  return, Esc); headings are focus targets for menu navigation. Pressed-state buttons in the demos use `aria-pressed`;
  totals are `aria-live`.
- Measured numbers: `docs/v5/PERFORMANCE_REPORT.md` (lead) and `docs/v5-progress/mkt.md`.

## Evidence
`node scripts/v5-mkt-shots.mjs` → `evidence/v5/mkt/<shot>-<width>-<theme>.png`; `MOBILE_QA=1` → page-level overflow at
320–1440 px (+ 200 % text) in `evidence/v5/mkt/mobile-qa.json`. E2E: `tests/e2e/v5-marketing.spec.ts`.
