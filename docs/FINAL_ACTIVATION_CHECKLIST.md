# Final activation checklist

External inputs only. Engineering gaps are in [IMPLEMENTATION_GAPS.md](IMPLEMENTATION_GAPS.md).
`<APP_BASE_URL>` = your final https origin (not chosen yet). Enter provider values on **/setup** (owner) or as environment secrets — never in chat.

## 1. Hosting and core services

| Need | Why | Where | Verify | Unlocks |
|---|---|---|---|---|
| Domain + authorised host and monthly spend cap | Nothing is provisioned without approval | Your cloud account | `curl https://<domain>/api/ready` → 200 | Production deployment |
| Managed PostgreSQL 16 with PITR | System of record and job queue | Cloud SQL or equivalent → `DATABASE_URL` | Migration job prints `applied` | Everything |
| Private S3-compatible bucket + HMAC keys, CORS `POST` from `<APP_BASE_URL>` | Media uploads; providers fetch signed URLs | `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `/api/diagnostics` → storage ok; upload an image in Library | Media |
| Key-encryption key custody | Encrypts provider tokens | Preferred: Cloud KMS key + wrapped KEKs → `KMS_KEY_NAME`, `KMS_WRAPPED_KEKS` (encrypt 32 random bytes with AAD `social-lite-kek:<kid>`; grant the VM service account `cloudkms.cryptoKeyDecrypter`). Alternative: `KEY_ENCRYPTION_KEYS` from a secret manager | Worker logs `kms_keys_loaded`; app boots in production | Credentials |
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
| Deauthorize callback `<APP_BASE_URL>/api/meta/deauthorize`; Data Deletion Request URL `<APP_BASE_URL>/api/meta/data-deletion` | App settings → Advanced / Facebook Login settings | Meta's test tool returns a confirmation code; status at `/data-deletion/<code>` | Required for App Review |
| Optional insights scopes (`read_insights`, `instagram_manage_insights`) | App Review | Analytics shows values instead of "Permission missing" | Analytics |

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

- `ANTHROPIC_API_KEY` (/setup) and a monthly AI token cap (Settings → Budgets) — enables AI caption assistance. Verify: composer → Assist returns suggestions without the "Test fixture" label.
- `TIPSIGNAL_SIGNING_SECRET` (/setup) and Settings → Integrations → bind the TipSignal brand. Verify: a signed test event creates a draft.
