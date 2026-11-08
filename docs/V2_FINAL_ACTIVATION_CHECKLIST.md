# V2 final activation checklist

Things a human operator must do outside the code before Relay V2 runs in production. Engineering gaps are in [V2_IMPLEMENTATION_GAPS.md](V2_IMPLEMENTATION_GAPS.md); upgrade steps in [V2_MIGRATION_RUNBOOK.md](V2_MIGRATION_RUNBOOK.md). V1 items that are unchanged (Meta, X, Telegram apps and canaries) stay in [FINAL_ACTIVATION_CHECKLIST.md](FINAL_ACTIVATION_CHECKLIST.md) §2–5.

Store every secret in the secret manager. Never paste values into chat, tickets or this repo. `<APP_BASE_URL>` = the final https origin (not chosen yet).

## 1. Identity provider (production Keycloak)

The local realm `infra/keycloak/social-lite-realm.json` is the reference. Do **not** import its demo users or client secret.

| What | Where | Verify | Unlocks |
|---|---|---|---|
| Keycloak (26.4 line) on its own https hostname, with its own backed-up database | Hosting target | `https://<idp>/realms/<realm>/.well-known/openid-configuration` returns 200 | Sign-in |
| Realm hardening: registration off, brute-force protection on, `sslRequired=all`, a password policy (local realm has none), user + admin events on with retention | Realm settings | Settings pages show the values; a failed-login burst locks the test user | Account safety |
| Second-factor levels: `acr.loa.map` `{"password":1,"mfa":2}`; browser flow LoA 1 = password, LoA 2 = OTP / WebAuthn / recovery codes; `oidc-amr-mapper` on the client | Authentication → Flows; client mappers | After TOTP sign-in, Relay **Security** shows two-step verified (session `acr=mfa`, `amr` includes `otp`) | MFA, step-up |
| Required actions enabled: Configure OTP, WebAuthn register, Recovery authentication codes, Delete credential | Authentication → Required actions | **Security → Add authenticator app** completes and returns to Relay | Self-service factors |
| WebAuthn policy: RP ID = production domain, RP name "Relay" | Authentication → Policies → WebAuthn | Register a passkey on **Security**, sign out, sign in with it (not yet tested anywhere — see gap G10) | Passkeys |
| Confidential client: standard flow only, PKCE S256, redirect `<APP_BASE_URL>/api/auth/callback`, post-logout `<APP_BASE_URL>/login`, back-channel logout `<APP_BASE_URL>/api/auth/backchannel-logout` with *session required* | Clients | Sign in and sign out on `/login` | Sign-in, logout |
| Client service account with **only** `realm-management` → `view-users` | Client → Service account roles | **Security** lists sign-in methods; Keycloak shows no other roles on the account | Factor list, MFA prompts |
| Back-channel logout reachable from Keycloak to `<APP_BASE_URL>` | Network / firewall | Keycloak admin → Users → *user* → Sessions → Sign out; the user's Relay tab is signed out on its next request | Session revocation |
| Realm SMTP (verified sender) and the `email` event listener | Realm → Email; Events → Listeners | Keycloak "Test connection" succeeds; change a test user's OTP and check that an email arrives (unverified so far — gap G4) | Factor-change notices |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`; `OIDC_ALLOW_INSECURE_HTTP=false` | Secret manager → web + worker env | Production web boots (it refuses a local issuer) | Sign-in |
| At least two Keycloak realm administrators, each with MFA, for the owner-lockout procedure | Keycloak master/realm admin users | Dry-run the procedure in `docs/OPERATIONS.md` on a test user | Owner recovery |

## 2. Identity cut-over decision

| What | Where | Verify | Unlocks |
|---|---|---|---|
| Decide whether `OIDC_ISSUER` changes at the upgrade. If it does, decide (and record) whether existing users are reset to `pending` for re-binding by verified email — runbook §8 | Change ticket | Each existing user signs in without `account_conflict` | Existing users' access |

## 3. Database roles

| What | Where | Verify | Unlocks |
|---|---|---|---|
| Login roles `socialite_migrator`, `socialite_app`, `socialite_worker` (no superuser/createdb/createrole/bypassrls); passwords generated and stored in the secret manager | Managed PostgreSQL + secret manager | `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname LIKE 'socialite_%';` all false | Least privilege |
| Connection URLs: web `DATABASE_URL` → app role; worker container `DATABASE_URL` → worker role; migration job `MIGRATOR_DATABASE_URL` → migrator; owner URL (`DATABASE_ADMIN_URL`) only in the release job that applies `infra/postgres/roles.sql` | Secret manager → per-container env | As `socialite_app`: `UPDATE audit_events SET action=action WHERE false;` → permission denied | Append-only audit |

## 4. Key custody (unchanged from V1, still open)

| What | Where | Verify | Unlocks |
|---|---|---|---|
| Cloud KMS key; wrapped KEKs (`KMS_KEY_NAME`, `KMS_WRAPPED_KEKS`); web and worker service accounts get only `cloudkms.cryptoKeyDecrypter` on that key | Cloud KMS + IAM → env | Worker logs `kms_keys_loaded`; production boot succeeds | Encrypted provider tokens, ID-token storage |
| `SESSION_SECRET` | Secret manager | Boot succeeds | Sessions |
| Backups include the means to decrypt (same KMS key/KEK versions) | Backup policy | Restore drill on a copy reads a stored credential | Restore |

## 5. Email

| What | Where | Verify | Unlocks |
|---|---|---|---|
| Transactional SMTP (`SMTP_URL`, `EMAIL_FROM`), SPF/DKIM for the sender domain | Email provider → env | `/api/diagnostics` → smtp ok; invite a test address and receive it | Invitations, mentions, digests, critical alerts |

## 6. Domain, TLS and headers

| What | Where | Verify | Unlocks |
|---|---|---|---|
| Domain + TLS at the reverse proxy; `APP_BASE_URL=https://…`; proxy must not strip or override app headers | DNS, proxy, env | `curl -sI https://<domain>/login` shows `Content-Security-Policy` (with `nonce-`), `Strict-Transport-Security`, `X-Frame-Options: DENY`; `/api/ready` → 200 | Secure cookies (`__Host-`), HSTS |
| Storage: `S3_PUBLIC_ENDPOINT` reachable; bucket CORS allows `POST` from `<APP_BASE_URL>` (CSP adds the storage origin automatically) | Bucket settings → env | Upload an image in the composer; browser console shows no CSP violations | Media uploads/previews |
| CSP violation reporting | – | Nothing to configure: the app has no report endpoint (gap G20) | – |

## 7. Integrations

| What | Where | Verify | Unlocks |
|---|---|---|---|
| `TIPSIGNAL_SIGNING_SECRET` (V1) and, after migration, the TipSignal binding now owned by a service account | Env; **Settings → Integrations** | A signed test event creates exactly one draft on the bound brand | TipSignal drafts |
| API keys for any external script using `/api/v1` | **Settings → Service accounts** (owner/admin, step-up) | Key works for drafts on its brand; revoking it fails the next call | Machine access |
| Meta / X / Telegram apps, scopes and canaries | V1 checklist §2–5 | As listed there | Live publishing |

## 8. Decisions and hosting

| What | Where | Verify | Unlocks |
|---|---|---|---|
| Authorised hosting target, budget and deploy access | Cloud account | Images deployed by digest; `/api/ready` 200 | Production |
| Accept or provide an immutable audit sink (none configured; DB superusers can rewrite `audit_events`) | Security owner | Decision recorded | Audit residual risk |
