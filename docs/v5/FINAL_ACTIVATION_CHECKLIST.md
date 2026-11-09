# V5 activation checklist

> **Superseded (2026-11-09):** the consolidated list is [../FINAL_ACTIVATION_CHECKLIST.md](../FINAL_ACTIVATION_CHECKLIST.md). This per-phase file is kept for history; any "§n" reference to the V1 checklist points at its pre-consolidation version in git history.

Only genuinely remaining external steps. V4's checklist (`docs/v4/FINAL_ACTIVATION_CHECKLIST.md`) still applies (Stripe,
support staff, SMTP, etc.). Both are merged into the final Relay checklist after Docs + Help Centre. Never paste keys into
chat; use the deployment secret manager.

## Marketing and sign-up
1. Enable self-registration at the production identity provider **with email verification**, and set
   `ALLOW_SELF_SERVE_WORKSPACES=true`, so a new visitor can go from the pricing cards → sign up → `/signup?plan=` → trial.
2. Publish a Privacy notice and Terms; set their links (and the support email) in Platform → Marketing.
3. Decide whether a new owner must set up a second factor before buying a paid plan (current behaviour) — see
   `IMPLEMENTATION_GAPS.md`.
4. Provider approvals named on the "Connect your tools" tiles (Meta, Google, LinkedIn, TikTok, X, Threads, Pinterest…) —
   same items as the V3.5 checklist; the page labels each one honestly until then.

## Support widget
5. Turn the widget on in Platform → Marketing (`widget_enabled`; production default is off). Mark it staffed only when
   people actually watch the Platform → Support inbox (otherwise it says "Send us a message").
6. SMTP sender (`SMTP_URL`, `EMAIL_FROM`) for visitor reply emails and one-time verification codes.
7. Production `SESSION_SECRET` (already required; also signs the widget's form time-trap token).

## AI workspace
8. AI provider key in Setup → protected settings and `AI_MODEL` in the server environment (D32; optional `AI_MODEL_PRICES`), then per-workspace AI budgets (Usage and limits) or platform
   entitlement overrides. Multi-step workflows are a Professional feature (`ai_workflows`).

## Deploy
9. Run migrations 037–038 (`pnpm db:migrate`, then `pnpm db:roles`) and restart the worker (widget sweeps, AI workflow
   engine). The marketing page needs no migration (config lives in `system_flags`).
10. Do not run `scripts/seed-marketing-showcase.ts` in production (it refuses to); the hero image is committed under
    `apps/web/public/marketing/`.
