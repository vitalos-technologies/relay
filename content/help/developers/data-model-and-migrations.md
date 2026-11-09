---
title: Data model and migrations
summary: The main database entities, how tenancy is enforced in the schema, what each migration added and how migrations are applied and rolled forward.
section: developers
audience: developer
status: available
related: [architecture-and-modules, publishing-engine-and-delivery-states, local-development-setup, authentication-and-authorization]
product_version: "2026-11"
reviewed: 2026-11-09
order: 20
keywords: [database, schema, tables, postgres, migrations, sql, entities]
---

## Principles

- **PostgreSQL is the system of record** for state, the transactional outbox, pg-boss queues (schema `pgboss`, owned by the worker role) and shared rate-limit buckets.
- **Tenancy in the schema.** Customer rows carry `workspace_id`, and most tables declare `UNIQUE (workspace_id, id)` with composite foreign keys such as `FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id)`. A row therefore cannot reference another workspace's brand, post or connection, even through a bug in service code. Services additionally filter every query by workspace and brand grants; an id from another workspace reads as "not found".
- **Immutable history.** Submitting, scheduling or publishing snapshots the mutable draft into immutable rows (`post_revisions`, `variants`); database triggers reject updates to them. Audit events are append-only for the app and worker roles.
- **Least-privilege roles** (`infra/postgres/roles.sql`): `socialite_migrator` owns the schema and is the only role with DDL; `socialite_app` (web) and `socialite_worker` have DML only; none is a superuser or bypasses row security. The worker additionally owns the `pgboss` schema.

## Core entities

| Area | Tables | Relationships |
|---|---|---|
| Identity and tenancy | `users`, `sessions`, `workspaces`, `memberships`, `brands`, `invitations` | A user belongs to workspaces through `memberships` (role, status). Brands belong to one workspace. Sessions store a SHA-256 of the opaque cookie token plus assurance (MFA, auth time) and the active workspace. |
| Authorization (V2) | `teams`, `team_memberships`, `scoped_role_grants`, `access_restrictions`, `delegation_limits`, `service_accounts`, `api_key_hashes` | Grants give a role preset at workspace, brand or connection scope to a user, team or service account; restrictions deny explicitly. API keys are stored only as hashes with a non-secret prefix. |
| Connections | `credentials`, `connections`, `connection_flows`, `oauth_states`, `provider_circuits` | A connection is one destination (page, profile, channel) of one brand and points at an envelope-encrypted credential. OAuth states are single-use hashes with a 10-minute expiry. |
| Content | `posts`, `post_revisions`, `variants`, `post_versions`, `templates`, `campaigns`, `assets`, `asset_derivatives` | A post belongs to a brand and holds the mutable draft (`version` for optimistic concurrency). A revision is an immutable snapshot; it has one variant per destination connection (`UNIQUE (revision_id, connection_id)`). Assets belong to a brand; originals are never served, only derivatives. |
| Scheduling and publishing | `schedules`, `approvals`, `deliveries`, `delivery_attempts`, `posting_slots`, `slot_reservations` | One live schedule per post; `generation` increases on every reschedule or edit. A delivery is one destination of one schedule (`UNIQUE (schedule_id, variant_id)`) and carries the state machine, lease, fencing token and provider ids. Every send attempt is recorded in `delivery_attempts`. Approvals are bound to a revision and schedule generation. |
| Reliability | `outbox`, `idempotency_keys`, `webhook_receipts`, `worker_heartbeats`, `system_flags`, `rate_limit_buckets`, `usage_counters`, `usage_reservations`, `usage_budgets`, `workspace_dispatch_state` | Outbox rows are written in the same transaction as the change they announce. Idempotency keys live 24 h. `system_flags` holds installation switches such as `dispatch_enabled` and `dispatch_version`. |
| Audit | `audit_events`, `platform_audit_events`, `mcp_audit` | Append-only trails for workspace actions, Relay staff actions and MCP tool calls (ids and outcomes, no content). |
| Analytics (V3) | `metric_definitions`, `sync_cursors`, `sync_runs`, `metric_observations`, `metric_cumulative_facts`, `metric_daily_facts`, `metric_resource_latest`, `metric_rollups`, `metric_rollup_days`, `metric_summary_zones`, `data_coverage`, `report_definitions`, `report_exports` | Raw observations are deduplicated on a fact key and folded into lifetime and daily facts, then rolled up. See [Analytics ingestion](/help/developers/analytics-ingestion). |
| Content Hub (V3) | `content_connections`, `source_grants`, `source_items`, `source_snapshots`, `imports`, `import_mappings`, `source_post_links`, `export_jobs`, `writeback_jobs`, `content_source_events`, `sync_checkpoints` | Google Drive, Docs and Notion. See [Content source imports and exports](/help/developers/content-source-imports-and-exports). |
| MCP (V3) | `mcp_clients`, `mcp_policy_grants`, `mcp_publication_intents`, `mcp_jobs`, `mcp_audit` | Client registrations with consented scopes and brands, automation policy grants, publication intents and report jobs. |
| Collaboration | `comments`, `comment_threads`, `comment_mentions`, `collab_tasks`, `approval_policies`, `approval_stages`, `approval_decisions`, `review_shares`, `notifications`, `notification_preferences` | Internal and shared comments, tasks, staged approvals and review links. |
| Inbox, cases and listening (V3.5) | `inbox_channels`, `inbox_conversations`, `inbox_messages`, `inbox_notes`, `inbox_drafts`, `inbox_reply_attempts`, `care_cases`, `care_sla_policies`, `listening_searches`, `listening_matches`, `listening_alerts` and related tables | Customer conversations, internal notes (never sent), reply attempts with the same send-once discipline as publishing, cases with SLAs and listening searches. |
| Integrations (V3.5) | `integration_connections`, `integration_events`, `integration_sync_jobs`, `external_links`, `integration_tasks`, `slack_*`, `translations` | Asana, monday.com, HubSpot, Slack, Mailchimp, Google Business Profile and Cloud Translation. |
| AI and automation | `ai_usage`, `ai_runs`, `ai_run_steps`, `ai_run_events`, `ai_run_results`, `ai_threads`, `automation_policies`, `automation_rules`, `automation_runs` | AI runs, their steps and results, token usage, and automation rules. |
| Commercial (V4/V5) | `support_tickets`, `support_messages`, `support_notes`, `billing_plans`, `billing_plan_versions`, `workspace_billing`, `billing_webhook_events`, `billing_invoices`, `usage_events`, `entitlement_overrides`, `widget_visitors`, `widget_sessions` | Relay support tickets, plans and subscriptions, the usage ledger, entitlements and the support widget. |
| Administration | `platform_operators`, `support_access_grants`, `feature_flags`, `workspace_feature_flags` | Relay staff roles, owner-approved time-limited support access and feature flag rollouts. |

## Migrations

Migrations are plain SQL files in `packages/db/migrations`, named `NNN_name.sql`, applied in order by `pnpm db:migrate` (`packages/db/src/migrate.ts`):

- one migration job at a time (PostgreSQL advisory lock);
- each file runs in its own transaction and is recorded in `schema_migrations` with its SHA-256 checksum;
- an applied file whose content later changes aborts the run (`checksum mismatch`) — never edit an applied migration, add a new one;
- migrations are forward-only. There is no automatic down migration; compatibility with the previous release is kept by making changes additive.

| File | Adds |
|---|---|
| `001_core.sql` | Users, sessions, workspaces, memberships, brands, invitations, credentials, connections, assets, templates, posts, revisions, variants, schedules, approvals, deliveries, attempts, outbox, webhooks, audit, notifications, idempotency, usage, circuits, heartbeats, system flags, app settings |
| `002_mock_provider_store.sql` | Simulated provider object store (`mock_` destinations) |
| `003_connection_flows.sql` | Multi-step connection flows (account selection) |
| `004_tipsignal.sql` | Integration bindings and source events (TipSignal drafts) |
| `005_ai.sql` | AI usage ledger |
| `006_media_expansion.sql` | Video and media columns (alters only) |
| `007_slots_crops_analytics.sql` | Posting slots, crops, first metric snapshots |
| `008_rate_limits_and_deletion.sql` | Shared rate-limit buckets, data deletion requests |
| `009_v2_authz.sql` | Teams, scoped grants, restrictions, delegation limits, service accounts, API key hashes |
| `010_v2_identity.sql` | Identity provider logout tokens (back-channel logout replay protection) |
| `011_v2_tenancy.sql` | Ownership transfers, publication authorizations, adoption events |
| `012_v2_collaboration.sql` | Campaigns, post versions, approval policies and stages, review shares, comments, notification preferences |
| `013_v2_product.sql` | Usage budgets and reservations, per-workspace dispatch state |
| `014_v3_providers.sql` | Columns for the V3 networks (alters only) |
| `015_v3_analytics.sql` | Metric definitions, sync cursors and runs, observations, facts, rollups, coverage, reports |
| `016_v3_content_hub.sql` | Content connections, source items and snapshots, imports, exports, writeback |
| `017_v3_mcp.sql` | MCP clients, audit, policy grants, publication intents, jobs |
| `019_v3_engine.sql` | Engine adjustments (alters only) |
| `020_v31_perf.sql` | Workload samples |
| `021_v31_data.sql` | Draft save clients, data policies, bulk jobs, recent items |
| `022_v31_gov.sql` | Brand profiles and rules, asset governance, provenance, queues, tracked links, feature flags, onboarding |
| `025_v31_perf_more.sql` | Summary zones and daily rollups |
| `026_v31_admin.sql` | Platform operators, platform audit, support access grants |
| `027_collaboration.sql` | Comment threads, tasks, reviewer requests, presence, collaboration events |
| `028_v35_foundation.sql` | Integrations, inbox channels, customers, conversations, messages, notes, drafts, cases, SLAs |
| `029_v35_inbox_more.sql` | Inbound events, moderation, attachments, satisfaction requests |
| `030_v35_integrations.sql` | Integration tasks, Google Business Profile posts, Slack, translations |
| `031_v35_listening.sql` | Listening searches, matches, alerts, dashboards |
| `032_v35_ai_automation.sql` | AI knowledge sources, runs, proposed actions, automation policies and rules |
| `034_v4_support.sql` | Relay support tickets, messages, notes, attachments, activity |
| `035_v4_billing.sql` | Plans, plan versions, prices, workspace billing, trials, checkout, webhook events, invoices |
| `036_v4_entitlements.sql` | Usage ledger, entitlement overrides and state |
| `037_v5_widget.sql` | Support widget visitors, sessions, verifications |
| `038_v5_ai_runs.sql` | AI workspace threads, run steps, events, results, attachments |

Numbers 018, 023, 024, 033 and 039 are intentionally unused. The next free number is 040.

## Working with migrations

1. Create `packages/db/migrations/040_<short_name>.sql`. Make the change additive (new tables, nullable columns, new indexes) so the previous web and worker images keep working during a rollout.
2. Apply locally: `pnpm db:migrate`, then `pnpm db:roles` so the app and worker roles get grants on new objects.
3. Run the integration tests: each run creates a disposable database from all migrations (`tests/integration/global-setup.ts`).
4. In production the migration job runs before new workers and web servers start. Rolling back means redeploying the previous images; the database is not rolled back destructively.

`pnpm db:reset` drops and recreates the schema and refuses to run when `APP_ENV=production`.
