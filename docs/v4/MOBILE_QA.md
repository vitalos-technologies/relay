# V4 mobile QA

Date 2026-11-08 · production build on the dev host · Chromium (Playwright). Brief §17 widths 320/360/390/430/768/1440
(plus 1024).

## Page-level horizontal scroll
`MOBILE_QA=1 node scripts/v4-final-shots.mjs` over 14 V4 screens × 7 widths = **98 checks, 0 issues**
(`evidence/v4/final/mobile-qa.json`).

Screens: Help, Contact support, My requests, Settings → Plan and billing (trial workspace), Admin → Usage (trial and legacy
workspaces), `/signup?plan=professional`, Platform → Support inbox, a staff ticket, saved replies, support-access list,
Platform → Billing, Platform → Plans, Platform → Workspaces → [id] (billing + entitlements panels). The customer ticket page
is covered by the support stream's E2E and screenshots (`evidence/v4/sup/customer-request-390-*.png`); the Demo Workspace
used by the sweep has no ticket of its own.

## Essential mobile workflows (brief §17) → E2E on Pixel 7 (`@mobile`)

| Workflow | Spec | Result |
|---|---|---|
| Create a support ticket | `v4-support.spec.ts` "phone: create with a screenshot, read and reply; staff triage and reply" | pass |
| Attach a screenshot | same | pass |
| Read and reply | same | pass |
| Approve or revoke support access | integration `v4-support.test.ts` + `v31-admin.test.ts`; existing desktop E2E `admin.spec.ts` support-access flow | **not E2E-tested on a phone** (gap) |
| Inspect a plan and usage | `v4-billing.spec.ts` "§17 at 390 px", `v4-entitlements.spec.ts` "usage page and chooser on a phone" | pass |
| Open hosted checkout | `v4-billing.spec.ts` "§17 at 390 px" (test-mode hosted stand-in) | pass |
| Update payment details | same (Customer Portal stand-in) | pass |
| Cancel renewal | same | pass |
| Staff triage and reply | `v4-support.spec.ts` phone test | pass |
| Staff inspect a tenant's billing status | `v4-billing.spec.ts` "§17 at 390 px" | pass |

Dialogs (change plan, cancel, send to support, overrides) use the shared dialog component (focus moves in and returns on
close). On-screen-keyboard behaviour was not separately measured in this pass. Screenshots at 390 px, light and dark:
`evidence/v4/final/*-390-*.png`, `evidence/v4/{sup,bil,ent}/*-390-*.png`.
