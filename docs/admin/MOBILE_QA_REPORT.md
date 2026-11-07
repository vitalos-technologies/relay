# Admin mobile QA report (V3.1 Admin §16)

Run on the production build with `scripts/admin-mobile-qa.mjs` (Playwright Chromium, touch + mobile emulation below
768 px) → `evidence/v3-1/admin/mobile-qa.json`, screenshots `evidence/v3-1/admin/mobile/*.png`. Full 390 set:
`evidence/v3-1/admin/<screen>-390-{light,dark}.png`.

## Layout: 30 admin routes × 8 sizes
320×640, 360×740, 390×844, 430×932, 768×1024, 1024×768, 1440×900 and landscape 844×390.
- **Page-level horizontal scroll: none** (0 of 240 page loads) after one fix: table header cells with `sr-only`
  (absolutely positioned) escaped their scroll container and widened the page at 768/1024; scroll containers are now
  `relative` (shared `Table` + admin `RecordList`).
- Tables become stacked cards below 768 px; secondary columns hide below 1024 px; wide comparison tables (workload)
  scroll inside their card.
- Page errors: 0.
- Small targets (< 44×44 CSS px inside page content, inline text links exempt): 27 per phone width across all 30
  routes on coarse pointers, mostly the pre-existing budgets editor inputs on Usage (10). Admin controls use the
  design system's `touch-target` rule (44 px on coarse pointers).

## The ten phone workflows (390×844) — all passed
| # | Workflow | Result | Time | Evidence |
|---|---|---|---|---|
| 1 | Find a workspace and inspect its health (platform) | ✓ | 1.0 s | `mobile/1-find-workspace-health.png` |
| 2 | Invite a member, change a scoped role (grant Approver on one brand, then revoke) | ✓ | 3.4 s | `mobile/2-*.png` |
| 3 | Inspect a failed publication and its eligible recovery | ✓ | 1.1 s | `mobile/3-failed-publication-recovery.png` |
| 4 | Inspect a broken connection and begin reconnection | ✓ | 1.0 s | `mobile/4-broken-connection-reconnect.png` |
| 5 | Review and decide an approval | ✓ | 2.7 s | `mobile/5-approval-decision.png` |
| 6 | Inspect an analytics report (ingestion + metric definitions) | ✓ | 1.4 s | `mobile/6-analytics-report.png` |
| 7 | Revoke an API key | ✓ | 2.0 s | `mobile/7-revoke-api-key.png` |
| 8 | Change a setting and verify persistence after reload (then restore) | ✓ | 3.1 s | `mobile/8-setting-persists.png` |
| 9 | Search/filter audit activity | ✓ | 1.0 s | `mobile/9-search-audit.png` |
| 10 | Pause an authorized publishing scope (brand), verify after reload, resume | ✓ | 2.4 s | `mobile/10-pause-scope*.png` |

Also in the Playwright suite (`tests/e2e/admin.spec.ts`, `@mobile`): drawer opens, Escape closes it and focus returns to
the menu button; pause/resume; invite/revoke; no horizontal scroll.

## Accessibility notes
- Drawer navigation is a Radix dialog (focus trapped, Escape, focus returned); groups are buttons with `aria-expanded`;
  current page `aria-current`; breadcrumb landmark; skip link; jump palette is a combobox/listbox with
  `aria-activedescendant` and full keyboard support.
- Status uses icon + text; both themes use the design tokens (contrast as V3 design system).
- Safe areas: header and drawer pad `env(safe-area-inset-*)`; content leaves room for the home indicator.
- Reduced motion: shared `anim-*` classes are disabled by `prefers-reduced-motion`.

## Not verified (honest)
- 200 % text zoom: approximated by the 320 px pass (≈ 640 px at 200 %); not tested with real browser zoom.
- Screen readers (VoiceOver/TalkBack) and real devices; on-screen keyboard behaviour beyond emulation.
