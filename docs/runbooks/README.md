# Relay operational runbooks

**Repository only.** These pages are for Relay operators (platform staff and whoever runs the installation). They are
never served by the Help Centre or included in the downloadable bundle. Member-facing explanations live in
`content/help/**`. Last reviewed 2026-11-09 against product version 2026-11 (migrations 001–038).

> Current state: Relay is **not deployed to production** (see `docs/DEPLOYMENT.md`). Commands are written for the target
> shape (one host with `web` + `worker` containers, managed PostgreSQL with point-in-time recovery, S3-compatible storage,
> an OIDC identity provider, SMTP) and were checked against the code and, where marked, the local stack. Steps that
> depend on a hosting provider's console are described generically.

## Index

| Runbook | Use when |
|---|---|
| [deployment-and-configuration.md](deployment-and-configuration.md) | Releasing, configuring or rolling back a deployment |
| [oracle-vm-deployment.md](oracle-vm-deployment.md) | First install, updates, backups and restore drills on the shared Oracle Ampere VM (`infra/oracle/`) |
| [health-and-monitoring.md](health-and-monitoring.md) | Daily checks; any alert; "is Relay healthy?" |
| [worker-and-queue-failures.md](worker-and-queue-failures.md) | Posts not going out, overdue work, backlog, dead letters, stuck jobs |
| [expired-provider-auth.md](expired-provider-auth.md) | Accounts needing reconnection, missing permissions, blocked deliveries |
| [rate-limits-and-budgets.md](rate-limits-and-budgets.md) | 429s, network rate limits, X/export/MCP/integration budgets, plan allowances |
| [failed-and-ambiguous-publications.md](failed-and-ambiguous-publications.md) | Failed, Unknown, Expired or partially published posts |
| [media-processing-failures.md](media-processing-failures.md) | Uploads rejected or stuck, video never ready |
| [source-sync-failures.md](source-sync-failures.md) | Drive/Docs/Notion imports, analytics sync, business-app sync failures |
| [mcp-connection-and-auth-failures.md](mcp-connection-and-auth-failures.md) | MCP clients cannot connect, get 401/403/404, or tools fail |
| [emergency-pause.md](emergency-pause.md) | Something must stop publishing now |
| [migration-and-rollback.md](migration-and-rollback.md) | Applying migrations, a failed migration, rolling a release back |
| [backup-restore-and-reconciliation.md](backup-restore-and-reconciliation.md) | Restoring the database; reconciling publications afterwards |
| [key-rotation-and-security-incidents.md](key-rotation-and-security-incidents.md) | Rotating secrets/keys; suspected compromise |
| [data-export-and-deletion.md](data-export-and-deletion.md) | A person or workspace asks for export or deletion; Meta deletion callbacks |
| [billing-webhooks-and-reconciliation.md](billing-webhooks-and-reconciliation.md) | Billing state wrong, Stripe webhooks failing, access held after payment |
| [support-widget-abuse.md](support-widget-abuse.md) | Spam or abuse through the marketing support widget |
| [ai-budget-exhaustion.md](ai-budget-exhaustion.md) | AI features refuse with "budget used up"; AI provider not configured or failing |
| [keycloak-and-self-registration.md](keycloak-and-self-registration.md) | Sign-in failures, owner lockout, self-registration and signup abuse |
| [container-restart-recovery.md](container-restart-recovery.md) | The host or container restarted; Docker will not start (stale pid file) |

## Conventions

- **Never blindly replay publications.** Anything that may already have reached a network (`unknown`, or anything after
  a restore) is reconciled read-only first. Retrying an Unknown delivery needs the explicit duplicate-risk
  acknowledgement and is audited.
- **Flags used in these pages:**
  - **READ-ONLY** — safe to run at any time.
  - **CHANGES DATA** — writes to the database or configuration; record it in the incident log with the reason.
  - **DESTRUCTIVE** — deletes or irreversibly changes data or external state; needs a second operator's agreement and a
    recent backup.
- **Prefer the product over SQL.** The admin console (`/admin`, platform operators) and workspace settings perform the
  same changes with authorization, audit and step-up. Use SQL only when the UI cannot, and say so in the incident log.
- **Database access:** `psql "$OPS_DATABASE_URL"` means a connection with the access the step needs (read-only replica
  or role for diagnostics; the migrator or owner role for corrective writes). Never use the web app's role for manual
  writes. Never paste connection strings, tokens or keys into tickets or chat.
- **Correlation ids:** every API error carries `correlation_id`; logs are JSON lines with the same id
  (`correlationId`). Search logs by it first.
- **Escalation path (generic):** on-call operator → engineering owner of the area → incident lead. Security
  incidents and suspected data exposure go to the incident lead immediately. Record contact names in the
  deployment's private on-call document, not here.
- **No secrets** in these pages: placeholders such as `<workspace id>` only.

## Where things are

| Need | Where |
|---|---|
| Installation health, workspaces, operators, dispatch switch, flags, billing, support | Admin console (platform operators): `/admin` → Platform |
| Workspace delivery operations, dead letters, jobs, webhooks, integrations | Admin console (workspace admins): `/admin` |
| Per-workspace operations view | `/operations` |
| Machine-readable health | `GET /api/health`, `GET /api/ready`, worker `:3001/health`, `:3001/ready`; `GET /api/ops`, `GET /api/ops/workload`, `GET /api/diagnostics` (owner/admin) |
| Generated API reference | `docs/api/routes.md`, `docs/api/openapi.json` |
