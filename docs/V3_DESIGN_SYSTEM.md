# Relay V3 design system

Source of truth for the redesigned UI (stream UX, brief `docs/queue/018_UX_REDESIGN_BRIEF.md`). Tokens live in
`apps/web/app/globals.css`; components in `apps/web/components/ui/**` (exported from `@/components/ui`).

## Principles
- Every page: one obvious purpose and one primary action (orange). Less text; no explanatory paragraphs on operational screens — use an `InfoTip` when a definition is truly needed.
- Show status with icon + text, never colour alone. Status colours (success/warn/danger/info) are distinct from brand orange.
- Demo/simulated status is shown **once** (shell strip; dataset notice in Analytics). Rows only carry provenance where real and simulated items mix. Demo/simulated data never enters live charts (Analytics `dataset` filter).
- Missing ≠ zero: `null` renders as "—" and breaks chart lines; coverage/freshness is explained once per view (footer), not per row.
- Progressive disclosure: logs, diagnostics and secondary state go in drawers, menus or tooltips.

## Tokens (both themes equally designed)
| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` / `--surface` / `--raised` / `--sunken` | #0C0E10 / #141619 / #1C1F23 / #0F1113 | #F4F5F6 / #FFFFFF / #EBEDEE (mist) / #EEF0F1 | tonal steps, no glows |
| `--text` / `--muted` / `--subtle` | #EEF0F1 / #A1A8B0 / #7B838C | #121416 (ink) / #545C66 / #69717B | meta ≥ 4.5:1 on surface |
| `--accent` / `--on-accent` | #FD6701 / #121416 | same | primary fill; ink text on orange (6.7:1) |
| `--accent-text` | #FF8A3D | #B23A00 | small orange text/icons (≥ 4.5:1) |
| `--tile` / `--tile-fg` | #1F2226 / #FF8A3D | #121416 / #FF8A3D | orange outlined icon on dark rounded tile (`FeatureTile`) |
| `--success` `--warn` `--danger` `--info` (+ `-soft`) | see css | see css | states only |
| `--chart-1…5` | #EA6000 #1F9FB5 #C98500 #9877EE #E23D1A | #E35C00 #00849E #B97800 #6E4FD6 #C42D0B | categorical, fixed order, validated with the dataviz palette checker (lightness band, chroma, CVD ΔE ≥ 15 adjacent) |
| `--chart-prev` | #7B838C | #8A929B | previous period: neutral + dashed, not a categorical slot |
| `--radius-card` | 14px | | cards, panels |
| `--nav-w` / `--rail-w` | 240px / 72px | | sidebar expanded (≥1280) / rail (768–1279) |

Type: Inter (self-hosted), body 14px, meta ≥ 12px (11px only for chips/axis), page titles 28px (24px mobile). Spacing on a 4/8 rhythm. Motion 140–180ms (`anim-fade`, `anim-pop`, `anim-slide`); `prefers-reduced-motion` disables it.

## Components
| Component | File | Notes |
|---|---|---|
| `PageHeader` | `ui/card.tsx` | title + optional meta chip + actions |
| `FilterBar`, `FilterSelect` | `ui/layout.tsx` | one row above the content it filters; filters live in the URL |
| `MetricCard`, `DeltaChip` | `ui/data-viz.tsx` | ≤ 4 per row; delta shows icon + signed % (or New / No baseline) |
| `ChartPanel` | `ui/data-viz.tsx` | chart ↔ table toggle, sr-only summary, optional definition tip |
| `LineChart`, `Legend`, `BarList`, `CoverageMeter` | `ui/data-viz.tsx` | dependency-free SVG; null breaks lines; crosshair tooltip; ←/→/Home/End keyboard; legend for ≥ 2 series; max 5 series (rest in table) |
| `ContentCard`, `Thumb` | `ui/layout.tsx` | thumbnail rows (lazy images; video/album glyph; network tile fallback) |
| `SortTh` + `Table` | `ui/layout.tsx`, `ui/table.tsx` | `aria-sort`, sortable headers |
| `StatusBadge` family | `ui/badge.tsx` | `PostStatusBadge`, `DeliveryStateBadge`, `ConnectionStatusBadge`; `components/accounts/capability-badge.tsx` for V3 capability states |
| `EmptyState`, `ErrorState` | `ui/feedback.tsx` | icon + ≤ 5 words + one action; errors keep the correlation reference |
| `DetailDrawer`, `DrawerSection` | `ui/layout.tsx` | right drawer (full-width on phones), Escape/overlay close, focus trapped |
| `IntegrationCard`, `FeatureTile` | `ui/layout.tsx` | connection/integration cards; orange icon on dark tile |
| `SettingsShell` | `components/settings-shell/*` | grouped left nav, search over visible items only, drawer + breadcrumb under 1024px |

## Navigation
- Primary: Overview, Planner, Create, Content library, Campaigns, Approvals, Analytics, Connections, Team, Settings. Admin group (Setup, Operations, Activity) separated and permission-gated. Phones: bottom bar (Overview, Planner, Create, Approvals) + More (everything else, Admin, pause).
- Top bar: brand scope, notifications, account. Shell banners: offline, paused, demo (once).
- Settings deep links `/settings/<group>/<item>` (registry: `components/settings-shell/registry.tsx`); legacy `/settings?tab=x` redirects server-side and keeps other query params; `/mcp/settings` → `/settings/developer/mcp`; `/security` renders inside the shell. People/Connections/Audit entries link to their canonical pages (Team, Connections, Activity).
- Analytics views `/analytics`, `/analytics/{content,channels,video,audience,workflow}` share URL filters (contract `FILTER_QUERY_KEYS`).

## Connection capability states (spec §6)
`lib/client/capability-state.ts`: Connected · Missing permission · Awaiting platform approval · Unsupported for this account · Reconnect required · Manual handoff · Limited access · Expires soon · Paused · Verifying · Disconnected. One primary chip per card; publishing formats and analytics are listed separately and only once known.

## Responsive
Checked at 1440 / 1280 / 1024 / 768 / 390. Composer: three regions ≥ 1280, two ≥ 1024, steps (Destinations · Write · Preview) on phones. Planner defaults to List on phones. No page-level horizontal scroll (tables scroll inside their card).

## Evidence
`scripts/ux-shots.mjs` (dev only) regenerates `evidence/v3/ux/<screen>-<width>-<theme>.png` at deviceScaleFactor 2.
