# V5 mobile QA

Date 2026-11-08 · production build · Chromium (Playwright). Widths 320/360/390/430/768/1024/1440.

## Page-level horizontal scroll
- Lead sweep `MOBILE_QA=1 node scripts/v5-final-shots.mjs`: 8 V5 screens (marketing signed out and signed in, signup
  handoff, AI workspace, Admin → AI, Platform → Marketing, Platform → AI, Platform → Support filtered to the widget) × 7
  widths = **56 checks, 0 issues** (`evidence/v5/final/mobile-qa.json`).
- Stream checks: marketing sections at every width and at 1440 with 200 % zoom (0 px overflow, MKT); widget open and closed
  at every width (WID); AI workspace and a run at 320–1440 (AIW).

## Workflows on a phone (`@mobile`, Pixel 7)

| Workflow | Spec | Result |
|---|---|---|
| Marketing: menu sheet, section scroll, seat entry with the keyboard | `v5-marketing.spec.ts` | pass |
| Widget: full-screen sheet with Close, reply box + Send visible when focused, launcher never covers pricing actions | `v5-widget.spec.ts` | pass |
| AI workspace: history sheet, composer with a shrunken (keyboard-open) viewport, results readable | `v5-ai.spec.ts` | pass |

## Accessibility covered by the V5 specs
Keyboard-only paths (section nav, FAQ accordion, Explore previews, widget launcher → dialog → Escape returns focus, AI
suggestions + composer), accessible names on controls, reduced motion (content stays visible, Motion disabled), 200 % zoom
(1440 → 720 CSS px), and text contrast ≥ 4.5:1 on the marketing palette (MKT measured every text colour pair).

## Not covered
A real on-screen keyboard on physical iOS/Android devices (Playwright can only shrink the viewport) — listed in
`IMPLEMENTATION_GAPS.md`. Screen-reader testing was by role/name assertions, not with VoiceOver/TalkBack.

Screenshots: `evidence/v5/final/*-{1440,390}-{light,dark}.png`, `evidence/v5/{mkt,wid,aiw}/`.
