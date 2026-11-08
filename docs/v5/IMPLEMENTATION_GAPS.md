# V5 implementation gaps (final)

What V5 does not do yet, and why. Lead (F5), 2026-11-08. External steps are in `FINAL_ACTIVATION_CHECKLIST.md`. V4 gaps
(`docs/v4/IMPLEMENTATION_GAPS.md`) still apply.

## Externally blocked

| Gap | Blocked on | Notes |
|---|---|---|
| Real AI output in the five workflows and "Ask" | AI provider key | Deterministic steps (read sources, validate destinations, save drafts, query analytics, create tasks) run for real; model steps report "AI is not set up". Model behaviour is tested only with a fake provider injected in tests. |
| Public sign-up by a new visitor in production | Production IdP self-registration (with email verification) + `ALLOW_SELF_SERVE_WORKSPACES=true` | Works end to end on the local Keycloak realm (registration + Mailpit verification). |
| Privacy notice and Terms | Legal text | No legal pages exist; the footer shows "not published yet" until links are set in Platform → Marketing. |
| Visitor reply emails and cross-device verification codes | SMTP sender | Without SMTP, replies appear only in the widget and "Continue from another device" is hidden. |
| Live billing from the pricing handoff | Stripe (V4 checklist) | Test mode end to end. |

## Not implemented / not verified

| Gap | Notes | Suggested next step |
|---|---|---|
| Real-device on-screen keyboard check | Playwright can't open a real virtual keyboard; the widget sheet and AI composer follow `visualViewport` and were checked with a shrunken viewport. | Manual check on one iOS and one Android device. |
| "Watch demo" | No genuine demo video exists, so the page uses "Explore Relay" (brief §3). | Add only when a real demo exists. |
| Typing / read indicators in the widget | Deliberately omitted: no real events back them (brief §9). | Add with a realtime channel if staffed live chat is introduced. |
| AI progress is polled, not pushed | Event cursor polling; refresh-safe. | SSE like the inbox stream if latency matters. |
| AI attachments | Text, Markdown, CSV, JSON up to 256 KB; larger documents go through the Content library. | Reuse the media pipeline for PDFs/Docs. |
| Listening suggestion / workflow | No listening workflow exists, so no listening suggestion is shown. | Add a listening digest workflow. |
| Self-serve owner and paid plans | `billing.manage` is MFA-sensitive, so a new owner must set up a second factor before choosing a paid plan; Billing says so and links to Security. | Product decision: keep (safer) or relax for the first purchase. |
| Lighthouse scores | Lab metrics measured with Playwright (LCP, CLS, JS transfer) under documented throttling; no Lighthouse run. | Run Lighthouse in CI against a deployed build. |
| Widget inside the app | Not mounted in the app; in-app support stays at Help → Contact support (`widget_in_app` flag unused). | Mount if wanted. |
