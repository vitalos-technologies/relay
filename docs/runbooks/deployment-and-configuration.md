# Deployment and configuration

Audience: operators. Repo only. Reviewed 2026-11-09 (product 2026-11). Related: `docs/DEPLOYMENT.md`,
`content/help/developers/environment-variables.md`, [migration-and-rollback.md](migration-and-rollback.md).

**Prerequisites:** image build access (`./scripts/build-images.sh <tag>` or CI images), the deployment's secret manager,
a migration-capable database connection, a backup taken within the last hour (point-in-time recovery enabled).

**Affected resources:** `web` and `worker` containers, the PostgreSQL schema, `system_flags`.

## Symptoms that send you here

- A release is due, or configuration must change.
- A process refuses to start: `Refusing to start in production: …` or `Invalid configuration: <names>`.
- The setup page (`/admin/setup`) shows a group as not ready, or a warning such as "Points at local email capture".

## Diagnostics

1. **READ-ONLY** — Start-up refusal lists every problem. Typical causes in production:
   `ENABLE_MOCK_PROVIDERS` or `AI_FIXTURE` true; `OIDC_ALLOW_INSECURE_HTTP` true; `APP_BASE_URL` not `https://`;
   missing `SESSION_SECRET`; neither `KEY_ENCRYPTION_KEYS` nor `KMS_KEY_NAME` + `KMS_WRAPPED_KEKS`; missing OIDC, S3 or
   SMTP settings; local defaults (local issuer, `not-for-production` S3 secret, local SMTP capture, `local-dev` key).
2. **READ-ONLY** — `GET /api/ready` → `{"status":"ready","checks":{"database":…,"migrations":…}}`. A `migrations`
   failure means the image expects migrations that are not applied.
3. **READ-ONLY** — `GET /api/diagnostics` (owner/admin session) checks database, storage, OIDC, SMTP, worker heartbeat
   and the dispatch switch, each with a detail line.
4. **READ-ONLY** — Worker log line `privileged_db_role` means the worker connects with a role that has more privileges
   than `socialite_worker`; in production the worker refuses to start (fail closed).

## Corrective actions

### Release (forward)

1. Build or pick images by **digest** (`social-lite-web`, `social-lite-worker`). Never deploy a mutable tag.
2. **CHANGES DATA** — Run the migration job once: `docker run --rm --env-file <prod env> social-lite-worker@<digest> node dist/migrate.mjs migrate`
   (as the migrator role). Migrations are additive, checksum-verified and each runs in a transaction.
3. Optional, for a rolling deploy where old and new workers overlap: pin dispatch to one version —
   **CHANGES DATA** `UPDATE system_flags SET value='"<new version>"'::jsonb, updated_by='release' WHERE key='dispatch_version'`
   (insert the row if missing). Only workers whose `APP_VERSION` matches will claim deliveries. Clear it afterwards
   (`value='null'::jsonb`).
4. Start the new worker(s). Stop the old worker with `SIGTERM`: it stops claiming, drains for up to 30 s; anything still
   sending becomes Unknown via lease expiry (never resent).
5. Start the new web containers; wait for `GET /api/ready` = 200; switch traffic; stop old web containers.

### Configuration changes

- Core settings (database, OIDC, storage, email, keys) are environment-only: change them in the secret manager and
  restart web and worker.
- Provider app settings may be in the environment **or** on the setup page (installation-wide; in production only the owner of the first, bootstrap workspace or a platform operator; stored encrypted, write-only). An
  environment value wins. To move a value from the setup page to the environment, set the environment variable and
  restart; the stored value is then ignored.
- Reverse proxy: TLS, HSTS, forward `X-Forwarded-*`, keep the app's security headers, make `/api/webhooks/*`,
  `/api/connectors/webhooks/*`, `/api/meta/*`, `/mcp` and `/.well-known/oauth-protected-resource*` publicly reachable.
  With more than one web replica, route `/mcp` by `Mcp-Session-Id` to the same replica (protocol sessions are in
  memory).
- Storage CORS must allow browser `POST` from `APP_BASE_URL`; `S3_PUBLIC_ENDPOINT` must be reachable by the networks.

## Verification

- `GET /api/ready` 200 on every web replica; worker `:3001/ready` 200 and a fresh `worker_heartbeats.last_seen_at`
  (**READ-ONLY** `SELECT worker_id, version, last_seen_at FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 5;`).
- `/admin/operations`: no overdue deliveries, outbox backlog draining.
- Publish a post to a test destination the installation owns (never a customer channel) or, on staging, a simulated one.

## Escalation

Start-up refusal you cannot explain, a migration failure, or a worker that will not claim work after a release:
pause dispatch ([emergency-pause.md](emergency-pause.md)), roll back the images ([migration-and-rollback.md](migration-and-rollback.md)),
escalate to the engineering owner with the correlation ids and the failing log lines.
