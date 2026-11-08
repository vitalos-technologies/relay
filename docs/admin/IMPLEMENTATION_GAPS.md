# Admin implementation gaps (honest list)

Missing **product** functionality (shown as "Not available", never faked):
- **G-P1 Billing**: no plans, invoices, payment status or seat pricing. Usage caps are the only limits.
- **G-P2 Outbound webhooks**: no customer webhook subscriptions/delivery history/signatures exist. Inbound provider
  callbacks are listed.
- **G-P3 Retention policy editor**: trash retention and analytics retention are fixed by code/config.
- **G-P4 Problem report triage**: reports have a status column but no close/assign workflow.

Missing or partial **admin** functionality:
- **G-A1 Instance setup authority**: `/setup` (provider keys, OIDC, SMTP) is still gated by *workspace owner*
  (`setup.manage` → `security.manage`), inherited from the single-tenant V1. On a multi-workspace installation it should
  be platform-operator-only. Left unchanged to avoid breaking existing installs/E2E; recommended change: require
  `platform_operators.role='operator'` when any operator exists.
- **G-A2 Session revocation for another user** by a workspace admin: not offered (sessions are global, not per
  workspace). Workspace suspension stops access immediately; platform account suspension ends all sessions.
- **G-A3 Meta data-deletion requests**: processed automatically; no admin list yet.
- **G-A4 Per-job retry from the admin jobs list**: recovery stays in the owning screen (Content hub, Trash, Analytics).
- **G-A5 pg-boss queue gauges** in the web app: the least-privilege web role can't read the worker-owned `pgboss`
  schema, so queue gauges show deliveries + outbox only (documented in the UI). Optional: grant `SELECT` on
  `pgboss.job` to the web role.
- **G-A6 Realtime transport**: polling markers (10 s), not push. Adequate for admin; push would need an SSE endpoint and
  a fan-out process.
- **G-A7 Account suspension vs scheduled work**: suspending a *platform account* doesn't hold that person's scheduled
  posts (workspace decides). Shown in the confirmation; may need a policy decision.
- **G-A8 Audit immutability**: append-only by database grants; no external WORM sink.
- **G-A9 Admin role for brand managers**: brand-scoped managers have no admin overview (they use the main app). A
  brand-scoped admin view would need per-card brand filtering (cards already filter by brand; the overview requires
  `workspace.read`).

Pre-existing issues fixed during this work:
- `/api/ops/workload` returned 500 under the least-privilege web role (`permission denied for schema pgboss`); now guarded.
- The 6-hourly connection health check renamed *simulated* destinations to the fake provider's profile name
  ("Simulated X account"), which broke seed-name lookups (`publishing.spec.ts`) six hours after seeding and confused
  admins. Simulated connections now keep their name (`connections/manage.ts applyHealth`); the six renamed dev rows were
  restored; regression test in `v31-admin.test.ts`.
- Tables with `sr-only` header cells widened the page at 768/1024 px (absolute cells escaping the scroll container);
  scroll containers are now `relative` (shared `Table`).
