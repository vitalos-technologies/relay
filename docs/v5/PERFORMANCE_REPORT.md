# V5 performance report

Date 2026-11-08 · production build on the dev host · headless Chromium. Lab measurements, not field data.

## Marketing page `/` (MKT, `PERF=1 node scripts/v5-mkt-shots.mjs`, `evidence/v5/mkt/perf.json`)
Cold cache per run, median of 5 runs. Mobile = 390×844 at DPR 2, 4× CPU slowdown, 150 ms RTT, 1.6 / 0.75 Mbps. JS counts
every script on the page, including the support-widget launcher.

| Build | `/` JS transferred | LCP desktop | LCP mobile (throttled) | CLS |
|---|---|---|---|---|
| first build (core barrel leaked into the client, dialogs eager) | 258 KB | 188 ms | 1,648 ms | 0 |
| subpath imports + lazy Base UI dialogs | 176.5 KB | 208 ms | 1,656 ms | 0 |
| + widget launcher, hand-built hero | 203.1 KB | 236 ms | 1,624 ms | 0 |
| **final: real dashboard hero** | **208.2 KB** (15 files) | **232 ms** | **1,712 ms** | **0** |
| `/login` baseline for comparison | 136.7 KB | 96 ms | 960 ms | 0 |

Against the V3.1 browser budgets (`docs/PERFORMANCE_BUDGETS.md`): LCP ≤ 2 s p75 — met in the lab, including throttled
mobile; CLS ≤ 0.1 — 0. CSS 18.9 KB; fonts = the three files the root layout already preloads; one image (the hero, served
as AVIF/WebP by `next/image`, ~27 KB at 1,200 px, light or dark only, reserved dimensions, high fetch priority). No app
shell bundle on `/`; below-the-fold previews and dialogs load lazily.

## Support widget (WID)
Launcher 3.9 KB minified / 2.0 KB gzip inside the marketing chunk; no request on load. Panel 32.7 KB / 10.0 KB gzip,
loaded on interaction or idle (not in the initial load). Cold click → dialog open: 149 ms.

## App screens (lead sweep, `PERF=1 node scripts/v5-final-shots.mjs`, `evidence/v5/final/perf.json`)
1440 px, full document loads, cold then warm. "Settled" = network idle (includes Playwright's 500 ms idle window) and no
skeleton left — not comparable with the 300 ms in-shell warm-navigation budget.

| Screen | DOMContentLoaded cold / warm | First data API cold / warm | Settled cold / warm |
|---|---|---|---|
| Marketing `/` (signed out) | 117 / 116 ms | — (no API) | 870 / 866 ms |
| Marketing `/` (signed in) | 131 / 199 ms | — | 962 / 941 ms |
| Signup handoff `/signup?plan=standard&seats=3` | 70 / 73 ms | — | 746 / 739 ms |
| AI workspace `/assistant` | 68 / 91 ms | 378 / 381 ms | 1,135 / 1,144 ms |
| Admin → AI | 82 / 96 ms | 367 / 316 ms | 1,040 / 1,025 ms |
| Platform → Marketing | 63 / 69 ms | 355 / 310 ms | 1,049 / 916 ms |
| Platform → AI | 83 / 61 ms | 358 / 324 ms | 968 / 944 ms |
| Platform → Support (widget filter) | 63 / 54 ms | 322 / 301 ms | 987 / 966 ms |

AI runs execute in the worker (`ai_assist` workload class); pages only read stored run state and poll an event cursor, so
typing, scrolling and navigation never wait on a model or provider. Conversation history loads incrementally.

## Not measured
Field data (needs a deployment), Lighthouse scores, a real phone on a real network.
