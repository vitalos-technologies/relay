# Final activation checklist

External inputs only. Engineering gaps are in [IMPLEMENTATION_GAPS.md](IMPLEMENTATION_GAPS.md).
`<APP_BASE_URL>` = your final https origin (not chosen yet). Enter provider values on **/setup** (owner) or as environment secrets — never in chat.

## 1. Hosting and core services

| Need | Why | Where | Verify | Unlocks |
|---|---|---|---|---|
| Domain + authorised host and monthly spend cap | Nothing is provisioned without approval | Your cloud account | `curl https://<domain>/api/ready` → 200 | Production deployment |
| Managed PostgreSQL 16 with PITR | System of record and job queue | Cloud SQL or equivalent → `DATABASE_URL` | Migration job prints `applied` | Everything |
| Private S3-compatible bucket + HMAC keys, CORS `POST` from `<APP_BASE_URL>` | Media uploads; providers fetch signed URLs | `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `/api/diagnostics` → storage ok; upload an image in Library | Media |
| KMS-held key-encryption key | Encrypts provider tokens | `KEY_ENCRYPTION_KEYS` (secret manager) | App boots in production | Credentials |
| Managed OIDC app (redirect `<APP_BASE_URL>/api/auth/callback`) | Staff sign-in | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Sign in on `/login` | Access |
| Transactional email (SMTP URL, verified sender) | Invitations, critical alerts | `SMTP_URL`, `EMAIL_FROM` | `/api/diagnostics` → smtp ok; send an invite | Team onboarding |
| `SESSION_SECRET` | Session hardening | Secret manager | Boot succeeds | – |

## 2. Meta (Instagram + Facebook)

| Need | Where | Verify | Unlocks |
|---|---|---|---|
| Meta app (Business type) with Facebook Login; App ID + Secret | developers.facebook.com → App settings → `META_APP_ID`, `META_APP_SECRET` (/setup) | `/accounts` shows Facebook/Instagram *Connect* enabled | Connection flows |
| Valid OAuth redirect URIs: `<APP_BASE_URL>/api/oauth/facebook/callback`, `<APP_BASE_URL>/api/oauth/instagram/callback` | Facebook Login → Settings | Connect completes and shows the destination picker | – |
| Permissions approved via App Review: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish` (+ `business_management` if Pages are business-owned); Business Verification | App Review | Account status *Ready* (not *Missing permission*) | Live publishing beyond app testers |
| Test Page + linked Instagram professional account; your user has CREATE_CONTENT on the Page | Meta Business Suite | Destinations appear in picker | Canary |

## 3. Telegram

| Need | Where | Verify | Unlocks |
|---|---|---|---|
| Dedicated bot token (BotFather) | Accounts → Connect Telegram (masked field) | Connection shows *Ready* | Telegram publishing |
| Bot added to a **test channel** as administrator with *Post Messages* | Channel → Administrators | *Ready*; otherwise exact fix shown | Canary |
| Optional `TELEGRAM_WEBHOOK_SECRET` (only if you later want inbound updates; outbound needs none) | /setup | – | Webhook ingress |

## 4. X

| Need | Where | Verify | Unlocks |
|---|---|---|---|
| Project + App with pay-per-use **credits** and a spending limit | console.x.com | – | API access |
| OAuth 2.0 (confidential client), callback `<APP_BASE_URL>/api/oauth/x/callback`, scopes `tweet.read tweet.write users.read media.write offline.access` | App → User authentication settings → `X_CLIENT_ID`, `X_CLIENT_SECRET` (/setup) | Connect → *Ready* | X publishing |
| Monthly caps for this workspace (`x_monthly_writes`, `x_monthly_reads`) | Tell us the numbers; set in `workspaces.limits` | Operations → Usage | Budget protection |

## 5. Live verification (after 2–4)

- Name the **test destinations** and approve the canary text/image. Then: compose → Publish now to each test destination → record provider ID + link (History export) → revoke the app/bot → confirm *Reconnect required* → reconnect → retry.
- Business channels are never used for tests.

## 6. Optional

- `ANTHROPIC_API_KEY` — only if AI caption assistance is built (not implemented; see gaps).
- `TIPSIGNAL_SIGNING_SECRET` — only if TipSignal ingestion is built (not implemented).
