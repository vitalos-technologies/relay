---
title: Environment variables reference
summary: Every environment variable Relay reads, what it does, its default and whether production requires it — placeholders only.
section: developers
audience: developer
status: available
related: [local-development-setup, architecture-and-modules, mcp-server]
product_version: "2026-11"
reviewed: 2026-11-09
order: 12
keywords: [env, environment, configuration, config, settings, dotenv]
---

## How configuration works

- The server validates its core settings at start-up with a zod schema (`packages/services/src/config.ts`). An invalid value stops the process with `Invalid configuration: <names>`.
- With `APP_ENV=production` the server also **refuses to start** with unsafe settings: mock providers or AI fixtures on, insecure OIDC, a non-`https` `APP_BASE_URL`, missing secrets, the local identity provider, local storage or email defaults, or the development encryption key.
- **Provider app credentials** (social networks, content sources, business apps, AI) can be set as environment variables **or** entered on the protected setup page, where secrets are stored encrypted and are write-only. These settings apply to the whole installation; in production only the owner of the first (bootstrap) workspace or a platform operator can change them. An environment value always wins and is shown as read-only. An empty value (`META_APP_ID=`) counts as unset.
- Never commit real values. `.env.example` contains names and local-only placeholders; `.env` is ignored by git.
- `node scripts/docs-api-check.mjs` fails when the code reads a variable that this page does not mention.

Values below are placeholders such as `<random 32 bytes, base64>`; replace them with your own.

## Core

| Variable | Required in production | Default | Purpose |
|---|---|---|---|
| `APP_ENV` | yes (`production`) | `development` | `development`, `test` or `production`. Production enables the fail-closed checks, `__Host-` cookies and HSTS. |
| `APP_BASE_URL` | yes, `https://…` | `http://localhost:3000` | Public address. Used for cookies, OAuth redirect URIs, email links, the CSRF Origin check and the MCP resource URL. |
| `SESSION_SECRET` | yes | — | At least 32 characters (`<random 32 bytes, base64>`). |
| `KEY_ENCRYPTION_KEYS` | yes, unless KMS is used | — | Key-encryption keys for stored credentials: `<kid>:<base64 32-byte key>[,<old kid>:<old key>]`. The first entry encrypts; older entries still decrypt during rotation. |
| `KMS_KEY_NAME` | alternative to the above | — | Cloud KMS key that unwraps `KMS_WRAPPED_KEKS` at start-up (fails closed if unusable). |
| `KMS_WRAPPED_KEKS` | with `KMS_KEY_NAME` | — | KMS-wrapped key-encryption keys. |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines; secrets and token-bearing URLs are redacted. |
| `SERVICE_NAME` | no | `social-lite` (web), `worker` (worker) | Label in logs and the database `application_name`. |
| `APP_VERSION` | no | `dev` (worker) / latest release-note version (web) | Release version. The worker records it in its heartbeat; it is compared with the rolling-deploy pin `dispatch_version`. |
| `ALLOW_SELF_SERVE_WORKSPACES` | no | unset | In production, a signed-in person without a membership may create a workspace only while no workspace exists, or when this is `true`. Outside production it is always allowed. |
| `ENABLE_MOCK_PROVIDERS` | must be `false` | `false` | Enables simulated `mock_` destinations, the billing test double and demo seeding. Development and demo only. |
| `AI_FIXTURE` | must be `false` | `false` | Deterministic, labelled AI suggestions for demos and tests. |

## Database

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Web app connection as the app role (`postgres://<app role>:<password>@<host>:<port>/<database>`). |
| `WORKER_DATABASE_URL` | for the worker | — | Worker connection (worker role). Pass it to the worker as its `DATABASE_URL`. |
| `MIGRATOR_DATABASE_URL` | for migrations | falls back to `DATABASE_URL` | Migration job connection (migrator role, the only role allowed DDL). |
| `DATABASE_ADMIN_URL` | local only | — | Owner account used by `pnpm db:roles` and `pnpm db:reset`; never by the app or worker. In production the platform provisions the roles. |
| `DATABASE_POOL_MAX` | no | `10` | Size of the main connection pool per process. |
| `WORKER_BULK_POOL_MAX` | no | `6` | Separate pool for bulk worker classes, so imports and reports cannot starve publishing. |
| `MIGRATIONS_DIR` | no | `packages/db/migrations` | Where the migration runner and diagnostics read `NNN_name.sql` files. |
| `DB_ROLES_SQL` | no | `infra/postgres/roles.sql` | Grants file applied by `pnpm db:roles`. |

## Identity (OIDC)

| Variable | Required in production | Default | Purpose |
|---|---|---|---|
| `OIDC_ISSUER` | yes | — | Issuer URL of the identity provider (local: the Keycloak realm). Must not be a local address in production. |
| `OIDC_CLIENT_ID` | yes | — | Confidential client registered with redirect URI `<APP_BASE_URL>/api/auth/callback`. |
| `OIDC_CLIENT_SECRET` | yes | — | Client secret. |
| `OIDC_ALLOW_INSECURE_HTTP` | must be `false` | `false` | Allows an `http://` issuer for local development. |

## Storage and email

| Variable | Required in production | Default | Purpose |
|---|---|---|---|
| `S3_ENDPOINT` | yes | — | S3-compatible endpoint used by the server. |
| `S3_PUBLIC_ENDPOINT` | no | `S3_ENDPOINT` | Host used in signed URLs given to browsers and providers; also added to the page CSP. Providers must be able to reach it. |
| `S3_REGION` | no | `us-east-1` | Bucket region. |
| `S3_BUCKET` | no | `social-lite-media` | Private bucket (public access blocked). Created automatically outside production. |
| `S3_ACCESS_KEY_ID` | yes | — | Least-privilege key for this bucket. |
| `S3_SECRET_ACCESS_KEY` | yes | — | Secret for the key above. Local defaults are refused in production. |
| `S3_FORCE_PATH_STYLE` | no | `true` | Path-style addressing (needed by most self-hosted S3 servers). |
| `SMTP_URL` | yes | — | `smtp(s)://<user>:<password>@<host>:<port>`. The local capture server is refused in production. |
| `EMAIL_FROM` | no | `Relay <no-reply@…>` from the brand constants | Sender for invitations, alerts and digests. |

## MCP server

All optional; defaults are derived from `APP_BASE_URL` and `OIDC_ISSUER`. See [Connect an MCP client](/help/developers/mcp-server).

| Variable | Default | Purpose |
|---|---|---|
| `MCP_RESOURCE_URL` | `<APP_BASE_URL origin>/mcp` | Canonical resource URI (token audience, protected-resource metadata). Must be `https` in production. |
| `MCP_AUTH_ISSUER` | `OIDC_ISSUER` | Authorization server whose access tokens `/mcp` accepts. |
| `MCP_ALLOWED_ORIGINS` | base + resource origins | Extra browser `Origin` values allowed (comma-separated). Requests without `Origin` are allowed. |
| `MCP_ALLOWED_HOSTS` | base + resource hosts | Extra `Host` header values allowed (comma-separated). |
| `MCP_PUBLIC_CLIENT_ID` | `relay-mcp` | Pre-registered public OAuth client shown in setup instructions; empty string = none. |
| `MCP_DCR_ENABLED` | unset | `true` when the authorization server accepts dynamic client registration for MCP clients. |

## Billing

| Variable | Default | Purpose |
|---|---|---|
| `RELAY_STRIPE_SECRET_KEY` | unset | Stripe secret key. With the webhook secret it activates the Stripe provider. Test-mode keys only, unless live mode is enabled. The `RELAY_` prefix is deliberate: a generic Stripe variable on a shared host is never picked up. |
| `RELAY_STRIPE_WEBHOOK_SECRET` | unset | Signing secret for `POST /api/webhooks/stripe`. |
| `RELAY_STRIPE_WEBHOOK_SECRET_PREVIOUS` | unset | Previous signing secret, accepted only while rotating. |
| `RELAY_STRIPE_API_VERSION` | Stripe account default | Pins the Stripe API version. |
| `BILLING_LIVE_MODE` | unset | Must be `enabled` before a live (`sk_live_…`) key is used — an explicit activation step. |
| `BILLING_TEST_WEBHOOK_SECRET` | built-in local value | Signing secret of the local billing test double (outside production with mock providers). |

Without Stripe settings, outside production with mock providers on, a labelled test double is used; otherwise billing pages show stored state and checkout refuses with `provider_not_configured`.

## Worker, publishing and analytics tuning

| Variable | Default | Purpose |
|---|---|---|
| `WORKER_ID` | `<hostname>-<pid>-<random>` | Stable worker identity in heartbeats and leases. |
| `WORKER_CONCURRENCY` | `4` | Publishing claim slots per worker (also the `publishing` class cap). |
| `WORKER_HEALTH_PORT` | `3001` | Port of the worker's `/health` and `/ready` endpoints. |
| `WORKLOAD_<CLASS>_CONCURRENCY`, `WORKLOAD_<CLASS>_PER_WORKSPACE` | per class (see [Background jobs](/help/developers/background-jobs-and-media)) | Override a workload class cap, e.g. `WORKLOAD_VIDEO_CONCURRENCY`. Values 1–256. |
| `PUBLISHING_PRESSURE_DUE_AGE_SECONDS` | `10` | Publishing counts as "under pressure" when due work has waited longer than this; bulk classes then defer. |
| `DISPATCH_WORKSPACE_CONCURRENCY` | `4` | Live publishing leases per workspace across all workers (operators can override per workspace). |
| `DISPATCH_PROVIDER_CONCURRENCY`, `DISPATCH_PROVIDER_CONCURRENCY_<PROVIDER>` | `8` | Live publishing leases per network across all workers, e.g. `DISPATCH_PROVIDER_CONCURRENCY_X=2`. |
| `DISPATCH_FAIR_ORDERING` | on | `off` restores plain due-time ordering across workspaces (kill switch). |
| `PROVIDER_EARLY_UPLOAD_MINUTES` | `180` (minimum 15) | How early provider-scheduled uploads (for example YouTube) may start before the publish time. |
| `ANALYTICS_BACKFILL_DAYS` | `90` (max 365) | Backfill horizon for analytics sync, capped by what each network can still report. |
| `ANALYTICS_WORKSPACE_CONCURRENCY` | `2` | Connections of one workspace that may sync analytics at the same time. |
| `ANALYTICS_YIELD_DUE_DELIVERIES` | `25` | Analytics runs pause (checkpointed) while at least this many deliveries are due. |
| `ANALYTICS_RAW_RETENTION_DAYS` | `400` | How long raw metric observations are kept (normalized facts stay with the account). |
| `ANALYTICS_DISCONNECTED_RETENTION_DAYS` | `90` | How long analytics of a disconnected account stay visible (labelled "access ended") before they are purged. |
| `ANALYTICS_PDF` | on when Playwright is installed | `off` disables PDF report rendering. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `/usr/bin/ffmpeg`, `/usr/bin/ffprobe` | Video validation and transcoding binaries (worker only). |
| `MOCK_PROVIDER_LATENCY_MS` | `0` | Artificial delay per simulated provider request (load tests). |
| `BLUESKY_SELF_HOSTED_HOSTS` | empty | Exact hostnames of self-hosted Bluesky servers the transport may call (comma-separated). Empty = Bluesky-hosted only. |
| `CONTENT_HUB_GOOGLE_PICKER` | on | `false` keeps `frame-src 'none'` in the CSP (disables the Google Picker frame). |
| `HELP_CONTENT_DIR` | the nearest `content/help` | Location of the Help Centre Markdown source. |

## Provider app settings (environment or setup page)

Each of these can be an environment variable or be entered on the setup page (installation-wide; see above). Secrets are stored encrypted and never shown again. OAuth redirect URIs are `<APP_BASE_URL>/api/oauth/<provider>/callback` for social networks, `<APP_BASE_URL>/api/content-hub/oauth/<google|notion>/callback` for content sources and `<APP_BASE_URL>/api/connectors/oauth/<connector>/callback` for business apps (the setup page shows the exact value).

| Group | Variables |
|---|---|
| Meta (Facebook, Instagram) | `META_APP_ID`, `META_APP_SECRET` (secret), `META_GRAPH_VERSION` (default `v26.0`), `META_REQUEST_INSIGHTS`, `META_REQUEST_INBOX`, `META_HUMAN_AGENT_APPROVED` (set the last three to `true` only after Meta approves those permissions), `META_WEBHOOK_VERIFY_TOKEN` (environment only; Meta webhook subscription handshake) |
| X | `X_CLIENT_ID`, `X_CLIENT_SECRET` (secret) |
| Telegram | `TELEGRAM_WEBHOOK_SECRET` (secret, 16–256 characters; Relay never overwrites an existing bot webhook) |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` (secret), `TIKTOK_DIRECT_POST_AUDITED` |
| YouTube (Google) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (secret) |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` (secret), `LINKEDIN_API_VERSION` (`YYYYMM`), `LINKEDIN_ORGANIZATIONS` |
| Threads | `THREADS_APP_ID`, `THREADS_APP_SECRET` (secret) |
| Pinterest | `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET` (secret), `PINTEREST_ACCESS_TIER` (`trial` or `standard`) |
| Google Drive and Docs | `GOOGLE_CONTENT_CLIENT_ID`, `GOOGLE_CONTENT_CLIENT_SECRET` (secret), `GOOGLE_PICKER_API_KEY`, `GOOGLE_PICKER_APP_ID` |
| Notion | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` (secret), `NOTION_INTERNAL_TOKEN` (secret; single internal test workspace only, not in production), `NOTION_WEBHOOK_VERIFICATION_TOKEN` (secret) |
| AI assistance | `ANTHROPIC_API_KEY` (secret). Environment only: `AI_MODEL` (required: the provider's model id; no default, so AI stays off until it is set), `AI_FALLBACK_MODELS` (optional comma-separated model ids for which Relay requests the provider's server-side refusal fallback), `AI_MODEL_PRICES` (optional JSON `{"<model id>": [input, output]}` in USD per million tokens; without a price, cost estimates show as unknown). Invalid values stop the server at start-up with the variable name. The setup page shows each as set or not set, never the value |
| TipSignal | `TIPSIGNAL_SIGNING_SECRET` (secret) |
| Asana | `ASANA_CLIENT_ID`, `ASANA_CLIENT_SECRET` (secret) |
| monday.com | `MONDAY_CLIENT_ID`, `MONDAY_CLIENT_SECRET` (secret), `MONDAY_SIGNING_SECRET` (secret), `MONDAY_API_VERSION` (`YYYY-MM`) |
| HubSpot | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` (secret; also verifies webhook signatures) |
| Google Business Profile | `GBP_CLIENT_ID`, `GBP_CLIENT_SECRET` (secret), `GBP_PUBSUB_AUDIENCE`, `GBP_PUBSUB_SERVICE_ACCOUNT` |
| Cloud Translation | `GOOGLE_TRANSLATE_PROJECT_ID`, `GOOGLE_TRANSLATE_SERVICE_ACCOUNT_JSON` (secret), `GOOGLE_TRANSLATE_LOCATION` (default `global`), `TRANSLATE_PRICE_PER_MILLION_USD` (cost estimates only) |
| Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` (secret), `SLACK_SIGNING_SECRET` (secret), `SLACK_SIGNING_SECRET_PREVIOUS` (secret, only while rotating) |
| Mailchimp | `MAILCHIMP_CLIENT_ID`, `MAILCHIMP_CLIENT_SECRET` (secret), `MAILCHIMP_WEBHOOK_SECRET` (secret) |

Bluesky needs no server setting: each account connects with its own app password.

## Variables used only by tests and scripts

`TEST_ADMIN_DATABASE_URL`, `TEST_DATABASE_URL`, `TEST_KEK`, `SOCIALITE_TEST_RUN` (integration tests), `E2E_BASE_URL`, `E2E_WORKSPACE`, `E2E_KEYCLOAK_URL`, `E2E_MAILPIT_URL`, `E2E_SKIP_SEED` (Playwright) and the screenshot/benchmark script options. They are not read by the web app or worker.

## Not in `.env.example`

`.env.example` lists the variables needed for local development. Everything else on this page is optional and absent from it on purpose (tuning, billing, MCP overrides and provider apps that can be set on the setup page). `META_WEBHOOK_VERIFY_TOKEN`, `RELAY_STRIPE_*`, `KMS_*` and the `MCP_*` variables are the ones a production deployment is most likely to need and must be added to the deployment's secret manager by hand.
