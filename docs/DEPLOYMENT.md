# Deployment

**Current state: not deployed.** No hosting account, domain or budget was authorised. Images build and run locally (verified).

## Target shape

One small Linux host (reverse proxy + `web` + `worker` containers), managed PostgreSQL 16 with point-in-time recovery, managed S3-compatible storage (private bucket), managed OIDC, transactional email, KMS/secret manager. GCP mapping: Compute Engine, Cloud SQL, Cloud Storage (S3 interoperability/HMAC), Secret Manager. Cloud Run is **not** suitable for the worker without redesign.

## Build

```bash
./scripts/build-images.sh <tag>      # social-lite-web:<tag>, social-lite-worker:<tag>
```
CI (`.github/workflows/ci.yml`) typechecks, runs unit/contract/integration tests on real Postgres + S3, checks migrations twice, builds, and builds both images. Deploy by **image digest**.

## Configure

Copy `.env.example` names into the secret manager. Key custody: prefer `KMS_KEY_NAME` + `KMS_WRAPPED_KEKS` (unwrapped at boot; fail closed) over a plaintext `KEY_ENCRYPTION_KEYS`. Images include ffmpeg/ffprobe for video validation and transcoding. Production refuses to start unless:
`APP_ENV=production`, `APP_BASE_URL=https://…`, `SESSION_SECRET`, `KEY_ENCRYPTION_KEYS` (not the dev key), a non-local `OIDC_ISSUER` + client, `S3_*` (not local defaults), `SMTP_URL` (not Mailpit), `ENABLE_MOCK_PROVIDERS=false`, `OIDC_ALLOW_INSECURE_HTTP=false`.
Provider app settings (Meta, X, Telegram webhook secret) can be set in env or on **/setup** by the owner (stored encrypted, write-only).

Identity provider (Keycloak or another OIDC IdP; the local realm `infra/keycloak/social-lite-realm.json` is the reference): confidential client, standard flow + PKCE S256, redirect `<APP_BASE_URL>/api/auth/callback`, post-logout redirect `<APP_BASE_URL>/login`, back-channel logout URL `<APP_BASE_URL>/api/auth/backchannel-logout` with *session required*; browser flow with a conditional second-factor level (`acr` `mfa` → OTP / WebAuthn / recovery codes; `amr` mapper); recovery codes + WebAuthn required actions enabled; the client's service account gets **only** `realm-management/view-users`. With a non-Keycloak IdP, factor management on **Security** is unavailable (shown as such) and step-up relies on `acr_values`/`max_age`.

Security headers come from the app: nonce-based CSP per page request (`apps/web/proxy.ts`, `'strict-dynamic'`, `frame-ancestors 'none'`, `connect-src`/`img-src` include the `S3_PUBLIC_ENDPOINT`/`S3_ENDPOINT` origin for presigned uploads and previews), `default-src 'none'` on API responses, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, and HSTS when `APP_ENV=production`. Do not strip or override them at the proxy.

Reverse proxy: TLS, HSTS, forward `X-Forwarded-*`, body limit ≥ 1 MB for API (uploads go directly to storage), `/api/webhooks/*` reachable publicly.
Storage CORS: allow `POST` from `APP_BASE_URL` (browser presigned uploads). Providers fetch media via short-lived signed URLs, so `S3_PUBLIC_ENDPOINT` must be publicly reachable.

## Migrate (one controlled job)

```bash
docker run --rm --env-file prod.env social-lite-worker:<tag> node dist/migrate.mjs migrate
```
Migrations are additive and checksum-verified (an edited applied migration aborts). Keep schema changes backward compatible with the previous image during rollout.

## Release

1. Run the migration job.
2. Start new `worker` (old one receives SIGTERM: stops claiming, drains up to 30 s; anything mid-send is resolved by lease expiry → Unknown, never resent).
3. Start new `web`; wait for `/api/ready` 200; switch traffic.

Health: web `GET /api/health` (liveness), `GET /api/ready` (DB + migrations); worker `:3001/health`, `:3001/ready`.

## Rollback

Redeploy the previous image digests. Never roll the database back destructively; migrations are forward-only. If a release published incorrectly, pause publishing first (Operations).
