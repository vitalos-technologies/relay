# Stream MD — marketing Integrations + Pricing redesign (user request 2026-11-11)

Status: **done** (2026-11-11), awaiting lead review/commit. Light page only (no dark theme). Reference: the user's chosen
Framer template (layout and motion studied with Playwright; no text, fonts, images, icons or code copied).

## Files
- `apps/web/components/marketing/integrations-section.tsx` — rewritten: two columns (eyebrow, two-tone heading, honest
  paragraph with counts from `networks()`/`TOOLS` + disclosure, "Get started free" → `/signup?plan=free`) beside three
  staggered rows of icon-only tiles (CSS marquee). Rows `aria-hidden`; one sr-only list keeps `mkt-networks`, `mkt-tools`,
  `mkt-network-*`, `mkt-tool-*` + `data-status`. Glyphs as SVG `<symbol>`s reused via `<use>`.
- `apps/web/components/marketing/marquee-control.tsx` — new client island: Pause/Play (`aria-pressed`, WCAG 2.2.2) and
  off-screen pause (IntersectionObserver). Hidden with reduced motion.
- `apps/web/components/marketing/tool-icon.tsx` — now glyph data only (`toolGlyph`); `ToolIcon` removed (no other users).
- `apps/web/components/marketing/section.tsx` — `Eyebrow`, `TwoToneHeading` added.
- `apps/web/components/marketing/pricing-cards.tsx`, `pricing-section.tsx`, `plan-comparison.tsx` — new card layout, centred
  header, stepper pill above the cards, lightly restyled comparison. No monthly/yearly toggle (monthly billing only).
- `apps/web/components/marketing/plan-data.ts` — `cardChecklist()` + `CHECKLIST_LENGTH` (5 lines per plan, catalogue-derived).
- `apps/web/components/marketing/product-demos.tsx`, `integrations-data.ts` — copy/comment: "Connect your tools" → Integrations.
- `apps/web/app/(marketing)/marketing.css` — tokens `--mkt-tile`, `--mkt-tile-border`, `--mkt-heading-muted` (#868aa0,
  3.4:1, large text only), `--mkt-glyph`; marquee + tile styles.
- **Shared file:** `apps/web/components/ui/platform-icon.tsx` — additive export `platformGlyphPath(provider)` only.
- Tests: `tests/e2e/v5-marketing.spec.ts` (heading, lead, CTA, telegram item text now "Telegram — Channel posts · bot chats",
  sr list counts 10/11, one marquee tile per entry, marquee aria-hidden with no focusables, animation runs + Pause works,
  reduced motion = `animation-name: none` and no Pause button; pricing heading, 5 checklist lines per card, "Everything in …",
  "All features", no yearly/annual/popular). `tests/unit/v5-marketing.test.ts` (+3: checklist shape, "Everything in
  <previous>" holds for every feature and allowance, no unlimited/popular/N+ claims).
- Docs: `docs/v5/MARKETING_PAGE_GUIDE.md` §5, §6, motion notes; `docs/v5/PLAN_AND_SEAT_DEFINITIONS.md` card bullets line.

## Verification (2026-11-11)
- `pnpm -s typecheck` clean · `pnpm test` 706/706 (50 files) · integration `v5-marketing` 9/9 · `node scripts/docs-check.mjs` ✔.
- eslint on touched files: 0 errors (pre-existing: 2 errors in untouched `site-footer.tsx`, 2 `<img>` warnings in hero/demos).
- E2E `tests/e2e/v5-marketing.spec.ts` after rebuild: **8 passed, 1 skipped** (the @mobile test is skipped on desktop and
  passes on the mobile project).
- Overflow 0 px at 320/360/390/430/768/1024/1440 and 1440 @ 200 % (720 CSS px, DPR 2), motion on and reduced, comparison
  open; marquee loop seamless at every width (one set ≥ row width; track = 3 × set).
- Perf on `/` (same method as `scripts/v5-mkt-shots.mjs PERF=1`, median of 5, cold): desktop LCP 564 → 492 ms; throttled mobile
  1,956 → 1,960 ms; CLS 0 → 0 on load and after scrolling the whole page; JS 364.4 → 364.9 KB; CSS 20.2 → 20.9 KB; HTML
  57.7 → 59.2 KB.
- Screenshots (DPR 2, light; sticky header and support launcher hidden for the captures only):
  `evidence/plans/v2-integrations-{1440,390}-{a,b}.png` (2 s apart), `v2-pricing-{1440,390}.png`,
  `v2-pricing-compare-{1440,390}.png`.

## Environment notes
- Docker/dockerd and the infra compose were down (container restart); MD restarted them, the worker and web under the lock.
