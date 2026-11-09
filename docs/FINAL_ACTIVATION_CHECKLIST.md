# Relay — final activation checklist

One list of everything that must happen **outside the code** before Relay runs for real customers. Last updated
2026-11-09 (after Docs + Help Centre).

- Nothing here has been done. Every flow is implemented and tested locally on simulated transports, signed fixtures or
  the Stripe test double. **None is verified against a live provider.** Until its row is done, each capability shows an
  honest state ("Not set up", "Awaiting approval", "Awaiting activation"). It never fakes success.
- `<APP_BASE_URL>` is the final public https origin. It has not been chosen yet (see 0.3), and most rows depend on it.
- Enter values in **Setup** (protected, owner or platform operator) or in the deployment secret manager. **Never put
  them in chat, tickets or this repo.** This file holds names, never values.
- **Launch** column: **B** = blocks a public launch. **O** = optional, or can follow launch; the feature stays labelled
  as not set up until then. You can move a network you won't offer at launch from B to O.
- ✱ = billed service or per-use charge. Approve the budget first.
- Engineering defects are listed in [help/DISCREPANCIES.md](help/DISCREPANCIES.md). Feature status is in
  [help/COVERAGE_MATRIX.md](help/COVERAGE_MATRIX.md). Operator procedures are in [runbooks/README.md](runbooks/README.md).

## 0. Only you can do this

| # | What | Why / unlocks | Launch |
|---|---|---|---|
| 0.1 | **Network approvals:** Meta (including insights), TikTok, YouTube/Google, LinkedIn, Threads, Pinterest, and X credits ✱ | Required before real customers connect accounts. The detail for each network is in §4 | B |
| 0.2 | **Publish the version tags from your own machine** (table below). This environment can't push tags | Gives each release a fixed reference on GitHub | O |
| 0.3 | **Choose hosting.** Offer accepted (2026-11-09): your shared Oracle Ampere VM, domain `relay.vitalos.co.uk` (configurable), all data on the VM. The deployment kit `infra/oracle/`, runbook `docs/runbooks/oracle-vm-deployment.md` is ready: run `sudo infra/oracle/bootstrap.sh` (dry run) then `--apply`. Still yours: DNS A records for `relay`, `auth.relay`, `media.relay`; OCI security list allows 80/443; storing the backup key shown once | Everything in §1 depends on the host and on `<APP_BASE_URL>` | B |
| 0.4 | ~~Supply the master SVG logo~~ **Done 2026-11-09:** traced from your brand board into `docs/brand/logo/` and live in the app (`relay-mark.tsx`, favicon, Apple icon). Optional: if your designer's original vector file exists, drop it in with the same names for a slightly more exact outline | Final brand assets | O |

**Version tags (0.2)**

| Tag | Commit |
|---|---|
| v1.0.0-local | fa905db |
| v1.1.0-local | e2bc6ec |
| v2.0.0 | 4815af8 |
| v3.0.0 | 95f8e34 |
| v3.1.0 | 78bd026 |
| v3.1.1 | 020af44 |
| v4.0.0 | 6b1ef4b |
| v5.0.0 | c53e0c4 |
| v5.1.0 | d4f3676 |

```sh
git fetch --unshallow 2>/dev/null; git fetch origin   # the V1 commits are missing from shallow clones
git tag v1.0.0-local fa905db && git push origin v1.0.0-local
git tag v1.1.0-local e2bc6ec && git push origin v1.1.0-local
git tag v2.0.0 4815af8 && git push origin v2.0.0
git tag v3.0.0 95f8e34 && git push origin v3.0.0
git tag v3.1.0 78bd026 && git push origin v3.1.0
git tag v3.1.1 020af44 && git push origin v3.1.1
git tag v4.0.0 6b1ef4b && git push origin v4.0.0
git tag v5.0.0 c53e0c4 && git push origin v5.0.0
git tag v5.1.0 d4f3676 && git push origin v5.1.0
```

HANDOFF.md also suggests an optional `v3.1.1` tag on the V3.1 Admin commit (`020af44`).

## 1. Hosting and core services

| # | What | Why / unlocks | Where | Verify | Launch |
|---|---|---|---|---|---|
| 1.1 | Host: shared Oracle VM via the kit `infra/oracle/`, runbook `docs/runbooks/oracle-vm-deployment.md`. Docker project `relay`, app ports on 127.0.0.1 only, CPU/memory limits, log rotation. Images are tagged per build (`<date>-<sha>`) and released with `update.sh` (automatic rollback). Images are multi-arch (`linux/arm64` primary, `linux/amd64`): both were built and the whole kit tested end to end in the sandbox (arm64 under QEMU emulation, not yet on Ampere hardware). | Production at all | VM (0.3) | `sudo infra/oracle/status.sh` → `web /api/ready 200`, worker and Keycloak ready | B |
| 1.2 | TLS at the reverse proxy; `APP_BASE_URL=https://…`; the proxy must not strip app headers. `bootstrap.sh` detects nginx / Caddy / Traefik / Apache / free ports and adds a Relay-only site (diff + backup first) or runs a bundled Caddy; certbot command printed for nginx/Apache | OAuth redirects, webhooks, MCP, `__Host-` cookies, HSTS | DNS, proxy (kit) | `curl -sI https://<domain>/login` shows a CSP with `nonce-`, HSTS and `X-Frame-Options: DENY` (verified through the kit's Caddy in the sandbox) | B |
| 1.3 | PostgreSQL 16 in a container on the VM (volume `relay_pgdata`, tuned for ~1 GB). No PITR: nightly encrypted `pg_dump` (`backup.sh`, RPO ≈ 24 h; `update.sh` also backs up before each release). Accept this RPO or add more frequent dumps / an off-VM copy (`RELAY_BACKUP_RSYNC_TARGET`) | System of record and job queue | Kit | The release job prints `migrations … applied`; `/opt/relay/backups/LAST_SUCCESS` is recent | B |
| 1.4 | Login roles `socialite_migrator`, `socialite_app`, `socialite_worker` (no superuser, createdb, createrole or bypassrls). The kit's release job creates them with generated passwords and applies `infra/postgres/roles.sql`; web → app, worker → worker, migrations → migrator; the owner URL exists only in the release job | Least privilege; append-only audit | Kit (`.env.infra`, generated on the VM) | `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname LIKE 'socialite_%'` returns false for all of them (verified in the sandbox). As the app role, `UPDATE audit_events …` is denied | B |
| 1.5 | Connection capacity: `workers × 20 + web × 10 + migrator + monitoring + headroom`. Kit: `max_connections=80` for 1 web + 1 worker + Keycloak (pool 10) + jobs. Transaction-mode poolers are unsafe (advisory locks). Size memory for the 020/021/025 indexes | No connection exhaustion | `compose.prod.yaml`; `DATABASE_POOL_MAX`, `WORKER_BULK_POOL_MAX` | Peak `pg_stat_activity` stays below `max_connections`; no `too many clients` errors in the logs | B |
| 1.6 | SeaweedFS on the VM (volume `relay_media`), private bucket `relay-media` created by the release job, generated keys, CORS limited to `<APP_BASE_URL>` (server flag; SeaweedFS does not implement bucket CORS). Public endpoint `https://media.<domain>` via the proxy | Media uploads; providers fetch signed URLs | Kit | `/api/diagnostics` shows storage ok. An image upload in the Library works with no CSP violations | B |
| 1.7 | Key custody on the VM: `KEY_ENCRYPTION_KEYS` generated by `bootstrap.sh` into root-only `/opt/relay/.env.production` (no Cloud KMS on this host). Included, encrypted, in every backup. Keep old key ids when rotating: there is no re-wrap tool | Encrypted provider tokens | `/opt/relay/.env.production` | Production boot succeeds; a restored copy reads a stored credential (13.3) | B |
| 1.8 | `SESSION_SECRET` (generated on the VM by `bootstrap.sh`) | Sessions; signs the widget's time-trap token | `/opt/relay/.env.production` | Boot succeeds | B |
| 1.9 | Review the **92 env vars that code reads but `.env.example` doesn't list** (many are tuning or Setup keys by design). Ones production likely needs: `META_WEBHOOK_VERIFY_TOKEN`, `RELAY_STRIPE_*`, `BILLING_LIVE_MODE`, `KMS_*`, `MCP_*`, `ALLOW_SELF_SERVE_WORKSPACES`, `S3_PUBLIC_ENDPOINT`, `APP_VERSION`, `WORKER_CONCURRENCY`, `WORKER_HEALTH_PORT`, `ANALYTICS_*_RETENTION_DAYS` | No missing config at boot | Secret manager; full list in `content/help/developers/environment-variables.md` | Production boot passes `assertProductionSafe`; `node scripts/docs-api-check.mjs` passes | B |
| 1.10 | Apply migrations 001–038 with the migrator role, then the grants: the kit's release job (`docker compose run --rm migrate`, run by `bootstrap.sh` / `update.sh`). Plan a maintenance window for 020–025 (indexes without `CONCURRENTLY`) once data exists | Schema for all features | Kit release job | `/api/ready` reports migrations applied (34 files, last 038, in the sandbox) | B |
| 1.11 | Deploy web plus a worker that includes every stream, the worker on the **worker** DB role (kit default; `update.sh` restarts worker then web) | Background work | Kit | Worker `/health` and `/ready` ok; `lastRun` advances | B |
| 1.12 | A distinct `APP_VERSION` per image: the kit sets it to the image tag. Optional: the dispatch-version pin (`system_flags.dispatch_version`) for overlapping workers (the kit runs one worker and stops the old one first) | Two schedulers never dispatch at once | `infra/oracle/build.sh`; `docs/runbooks/deployment-and-configuration.md` | `worker_heartbeats.version` shows the tag, not `dev` (verified in the sandbox) | B |
| 1.13 | Web image contains `apps/web/public` and `content/help`: the kit's `infra/oracle/Dockerfile` includes both | Brand and marketing files, the Help Centre | `infra/oracle/Dockerfile` | `/help` and `/marketing/overview-light.webp` load from the image (verified in the sandbox) | B |
| 1.14 | Never run seeds or demo scripts in production (`db:seed`, `db:seed:e2e`, `scripts/analytics-demo.ts`, `scripts/seed-marketing-showcase.ts`). Never set `NOTION_INTERNAL_TOKEN` | Clean live data | Release process | No demo workspace exists; Setup shows the token unset | B |
| 1.15 | PDF reports need Chromium in the worker image. Without it they fall back to HTML (`ANALYTICS_PDF=off` forces HTML) | PDF exports | Worker image | An exported PDF starts with `%PDF` | O |
| 1.16 | Tracked-link host `<APP_BASE_URL>/api/l/<code>` reachable and on the brand's approved link domains | Campaign links (flag `v31.tracked_links`) | Proxy; Brand rules | A short link returns 302; an unknown code returns 404 | O |

## 2. Identity and sign-up (production Keycloak)

Use `infra/keycloak/social-lite-realm.json` as the reference only. **Don't import its demo users or client secret.**
Runbook: `docs/runbooks/keycloak-and-self-registration.md`.

| # | What | Why / unlocks | Where | Verify | Launch |
|---|---|---|---|---|---|
| 2.1 | Keycloak 26.4 on its own https hostname, with its own backed-up database | Sign-in | Host | `/realms/<realm>/.well-known/openid-configuration` → 200 | B |
| 2.2 | Realm hardening: brute-force protection, `sslRequired=all`, a password policy, user and admin events with retention | Account safety | Realm settings | A burst of failed logins locks the test user | B |
| 2.3 | MFA levels: `acr.loa.map` `{"password":1,"mfa":2}`, LoA 2 = OTP / WebAuthn / recovery codes, `oidc-amr-mapper`. Enable required actions: Configure OTP, WebAuthn register, Recovery codes, Delete credential | MFA, step-up, self-service factors | Authentication → Flows / Required actions | After a TOTP sign-in, **Security** shows two-step verified; "Add authenticator app" round-trips | B |
| 2.4 | Confidential client: standard flow, PKCE S256. Redirect `<APP_BASE_URL>/api/auth/callback`, post-logout `/login`, back-channel logout `/api/auth/backchannel-logout` (session required) reachable from Keycloak | Sign-in, logout, session revocation | Clients; firewall | Sign in/out works; an admin sign-out ends the Relay tab on its next request | B |
| 2.5 | Client service account with **only** `realm-management → view-users` | Factor list, MFA prompts | Client → Service account roles | **Security** lists sign-in methods; no other roles are present | B |
| 2.6 | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`; `OIDC_ALLOW_INSECURE_HTTP=false` | Sign-in | Secret manager → web and worker | Production boots (it refuses a local issuer) | B |
| 2.7 | Realm SMTP (verified sender) and the `email` event listener | Email verification; factor-change notices (unverified so far, gap G4) | Realm → Email / Events | "Test connection" ok; an OTP change sends an email | B |
| 2.8 | **Self-registration with email verification** (`registrationAllowed`, `registrationEmailAsUsername`, `verifyEmail`) plus `ALLOW_SELF_SERVE_WORKSPACES=true` | Visitor goes pricing card → sign up → `/signup?plan=` → 14-day trial | Realm → Login; web env | A new address registers, verifies by email, gets a workspace and a Professional trial | B |
| 2.9 | Identity cut-over decision: if `OIDC_ISSUER` changes, reset existing users to `pending` for re-binding by verified email (V2 runbook §8) | Existing users' access | Change ticket | Existing users sign in without `account_conflict` | B |
| 2.10 | At least two realm administrators, each with MFA; dry-run the owner-lockout procedure | Owner recovery | Keycloak admin | Dry run done on a test user | B |
| 2.11 | WebAuthn policy: RP ID = production domain, RP name "Relay" | Passkeys (never tested anywhere, gap G10) | Authentication → Policies | Register a passkey, sign out, sign back in with it | O |
| 2.12 | Decide: must a new owner set up a second factor before buying a paid plan? (Current behaviour: yes, because `billing.manage` is MFA-sensitive) | First-purchase friction vs safety | Product decision | Decision recorded | O |

## 3. Email

| # | What | Why / unlocks | Where | Verify | Launch |
|---|---|---|---|---|---|
| 3.1 | Transactional SMTP with a verified sender and SPF/DKIM | Invitations, mentions, digests, critical alerts, support and billing notices, widget replies and verification codes ("Continue from another device" stays hidden without it) | `SMTP_URL`, `EMAIL_FROM` | `/api/diagnostics` shows smtp ok; a test invite arrives; email rows no longer say `not_configured` | B |

## 4. Social networks

Every OAuth callback is `<APP_BASE_URL>/api/oauth/<provider>/callback`. Keys go in **Setup → ‹network›** or the secret
manager. Live tests use **designated test accounts only**, never business channels. Per-network detail:
`content/help/social-connections/*` and `docs/providers/<network>.md`.

| # | Network | What | Why / unlocks | Where | Verify | Launch |
|---|---|---|---|---|---|---|
| 4.1 | All | One designated test account/destination per network, recorded with its owner | Canaries | Each network; provider register | Listed | B |
| 4.2 | Meta | Business-type app with Facebook Login. Redirects `…/oauth/facebook/callback` and `…/oauth/instagram/callback` | FB/IG connections | developers.facebook.com → `META_APP_ID`, `META_APP_SECRET` | `/accounts` Connect is enabled and shows the destination picker | B |
| 4.3 | Meta | App Review: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish` (+ `business_management`); Business Verification | Publishing beyond app testers | App Review | Account status *Ready*, not *Missing permission* | B |
| 4.4 | Meta | Deauthorize callback `/api/meta/deauthorize`; Data Deletion URL `/api/meta/data-deletion` | Required by App Review | App settings → Advanced | Meta's test tool returns a code; `/data-deletion/<code>` shows the status | B |
| 4.5 | Meta | **Insights:** `read_insights`, `instagram_manage_insights`, then `META_REQUEST_INSIGHTS=true` and reconnect the accounts | FB/IG analytics | App Review; Setup → Meta | Analytics data health shows "ok", not "permission missing" | B |
| 4.6 | Meta | Inbox: `pages_messaging`, `pages_manage_engagement`, `pages_read_user_content`, `instagram_manage_messages`, `instagram_manage_comments` (+ Human Agent → `META_HUMAN_AGENT_APPROVED=true`). Set `META_REQUEST_INBOX=true`. Subscribe the Page fields (`messages`, `message_echoes`, `message_edits`, `message_deliveries`, `message_reads`, `feed`) and the IG fields (`messages`, `comments`) to `/api/webhooks/meta`. Reconnect | Messenger, IG DMs and comments in the Inbox | App Review; `META_WEBHOOK_VERIFY_TOKEN` | A test DM appears in the Inbox; a reply is delivered | O |
| 4.7 | WhatsApp ✱ | WABA, registered number, Business verification, payment method; system-user token; webhook `whatsapp_business_account/messages` → `/api/connectors/webhooks/whatsapp`; approved templates; optional rate card | WhatsApp in the Inbox (fix the utility-charge defect first, see DISCREPANCIES) | Meta Business; Settings → Inbox → Channels | A test message round-trips; the charge dialog appears for billable sends | O |
| 4.8 | Threads | App with the **Threads** use case; add testers | Tester-only posting | developers.facebook.com → `THREADS_APP_ID`, `THREADS_APP_SECRET` | A tester connects; a text post publishes | B |
| 4.9 | Threads | App Review: `threads_basic`, `threads_content_publish`, `threads_manage_insights` | General use and insights | Meta App Review | A non-tester connects; likes and replies appear | B |
| 4.10 | Threads | `threads_read_replies`, `threads_manage_replies` (add them to the OAuth scopes) | Threads replies in the Inbox | Meta App Review | A test reply appears in the Inbox | O |
| 4.11 | X ✱ | Project and app with pay-per-use **credits** and a spending limit | API access | console.x.com | Credits visible | B |
| 4.12 | X | OAuth 2.0 confidential client; scopes `tweet.read tweet.write users.read media.write offline.access` | X publishing | `X_CLIENT_ID`, `X_CLIENT_SECRET` | Connect → *Ready* | B |
| 4.13 | X | Workspace caps `x_monthly_writes`, `x_monthly_reads` (choose the numbers) | Budget protection; billable metrics | `workspaces.limits` | Operations → Usage moves after a post and a metrics read | B |
| 4.14 | TikTok | App with Login Kit and Content Posting API; scopes `user.info.basic video.publish video.upload video.list` | Inbox draft handoff and unaudited Direct Post (`SELF_ONLY`, ≤ 5 creators/day); `video.list` metrics | developers.tiktok.com → `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | A test creator connects; **Connections** shows the publish mode | B |
| 4.15 | TikTok | Direct Post audit (describe Relay truthfully). Approval → `TIKTOK_DIRECT_POST_AUDITED=true`. If refused, Relay stays on inbox/manual handoff | Public Direct Post and public-post metrics | TikTok app → audit | Eligibility shows "Direct Post (audited client)" | O |
| 4.16 | TikTok | Verify the media URL prefix (the public storage origin) | Photo posts (PULL_FROM_URL) | TikTok app → URL properties | No more `url_ownership_unverified` | O |
| 4.17 | YouTube | Cloud project with YouTube Data API v3 and YouTube Analytics API enabled; an OAuth web client | Video upload | console.cloud.google.com → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | A **private** test video goes processing → published | B |
| 4.18 | YouTube | Consent screen **verification** for `youtube.upload`, `youtube.readonly`, `yt-analytics.readonly`, `youtube.force-ssl`. Reconnect existing channels | Non-test users; native scheduling; comments/replies; metrics | Cloud console → OAuth consent | No "unverified app" screen for a non-test user | B |
| 4.19 | YouTube | Quota audit if you need more than ~100 uploads/day or a heavy reply volume (`comments.insert` = 50 units) | Volume | YouTube API audit form | The quota page shows the new limit | O |
| 4.20 | LinkedIn | App with Share on LinkedIn and Sign In with LinkedIn (OpenID), verified against a LinkedIn Page | Member posting | linkedin.com/developers → `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | A test member's text post publishes | B |
| 4.21 | LinkedIn | Community Management API. Approval → `LINKEDIN_ORGANIZATIONS=true`; the test member needs an admin role on the test Page | Organisation posting and **all** LinkedIn analytics | LinkedIn app → Products | The org is selectable; the post appears on the Page; impressions show | B |
| 4.22 | Pinterest | App and a test board | Trial (sandbox) Pins, visible only to you | developers.pinterest.com → `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET` | A Pin is created on the board | B |
| 4.23 | Pinterest | Upgrade to **Standard access** (video of the OAuth flow). Approval → `PINTEREST_ACCESS_TIER=standard` | Public Pins and analytics | Pinterest app → access tier | Eligibility shows "Standard access"; the Pin is public | B |
| 4.24 | Bluesky | No app. Each account owner creates an app password (with DM access for the Inbox). Self-hosted PDS hosts go in `BLUESKY_SELF_HOSTED_HOSTS` | Bluesky posting and DMs | Bluesky account; server env | A text + image post appears; reconnecting with a new password keeps the connection | O |
| 4.25 | Telegram | Per customer: a BotFather token; the bot is a channel admin with *Post Messages*. Inbox: Settings → Inbox → Channels → Check → Claim (only when no other app uses the bot's updates; Relay never overwrites a webhook). Optional `TELEGRAM_WEBHOOK_SECRET` | Telegram publishing and inbox | Connections; Setup | *Ready*; otherwise the exact fix is shown | O |
| 4.26 | X / LinkedIn / TikTok | Inbox access (X paid API ✱, LinkedIn Community Management, TikTok API for Business). No adapter is built yet | Future inbox channels | Each network | – | O |
| 4.27 | All | **Live canary** per network on its test destination: publish → record the provider id and link → reconcile → metrics → revoke → *Reconnect required* → reconnect → retry. Record the evidence in `docs/providers/<p>.md` and update "Verified live" in the capability docs | Honest "verified live" status | Relay | Evidence recorded | B |

## 5. Content sources (Google Drive/Docs, Notion)

| # | What | Why / unlocks | Where | Verify | Launch |
|---|---|---|---|---|---|
| 5.1 | Enable the Drive, Docs and Picker APIs (this can be the YouTube project) | Google content | Cloud console | APIs listed as enabled | O |
| 5.2 | OAuth web client for content with scope `drive.file` (+ `openid email`); redirect `/api/content-hub/oauth/google/callback`. Publish the consent screen (brand verification as Google requires) | Google connection beyond test users | `GOOGLE_CONTENT_CLIENT_ID`, `GOOGLE_CONTENT_CLIENT_SECRET` (Setup → Google Drive & Docs) | Consent lists only "specific files you use with this app"; no unverified-app warning | O |
| 5.3 | Picker API key restricted to the Picker API and referrer `<APP_BASE_URL>/*`; the project **number** | File selection | `GOOGLE_PICKER_API_KEY`, `GOOGLE_PICKER_APP_ID` | The Picker opens from Library → Sources with no CSP violations | O |
| 5.4 | Decide the Picker CSP: keep it, or set `CONTENT_HUB_GOOGLE_PICKER=false` if Google content isn't used | Smaller CSP | Web env | The `/login` CSP shows `frame-src 'none'` when disabled | O |
| 5.5 | Drive change notifications at `/api/webhooks/google-drive` (public HTTPS; may need domain verification) | "Changed" signals without manual refresh | Search Console / network | An edited file's card shows "changed" | O |
| 5.6 | Notion **public** integration; redirect `/api/content-hub/oauth/notion/callback`. Read content; add update/insert only for writeback and exports | Notion import/export | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` (Setup → Notion) | The page picker shows only pages the user shares | O |
| 5.7 | Notion webhooks to `/api/webhooks/notion`. An owner adopts the verification token in Relay and pastes it into Notion | Change signals | `NOTION_WEBHOOK_VERIFICATION_TOKEN` | Notion shows the subscription verified | O |
| 5.8 | For writeback, create the `status` options `Draft in Relay`, `In review`, `Scheduled`, `Published`, `Failed` | Status writeback | Notion database | A scheduled post's row shows "Scheduled" | O |
| 5.9 | Live check: import a file, a Doc and a page; export one report; revoke at the provider | Honest status | Relay | Previews disappear after revocation | O |

## 6. Business apps and listening

Redirect and webhook URLs are shown in **Relay → Business apps → ‹app›** to the instance owner and platform operators.

| # | What | Why / unlocks | Where | Verify | Launch |
|---|---|---|---|---|---|
| 6.1 | Asana OAuth app (scopes `tasks:read/write`, `projects:read`, `users:read`, `webhooks:write`, `workspaces:read`); redirect `/api/connectors/oauth/asana/callback` | Tasks from cases/posts | `ASANA_CLIENT_ID`, `ASANA_CLIENT_SECRET` | Connect; a test task syncs without loops | O |
| 6.2 | monday.com app with OAuth and a signing secret; confirm the current API version | Items sync | `MONDAY_CLIENT_ID`, `MONDAY_CLIENT_SECRET`, `MONDAY_SIGNING_SECRET`, `MONDAY_API_VERSION` | A test item syncs | O |
| 6.3 | HubSpot public app (Service Hub portal); webhooks `ticket.propertyChange`, `ticket.deletion` → `/api/connectors/webhooks/hubspot`; a default pipeline and stage per install | Tickets from cases | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | Repeated delivery yields exactly one ticket | O |
| 6.4 | Slack app: bot scopes `chat:write`, `channels:read`, `groups:read`; interactivity URL `/api/connectors/webhooks/slack` | Alerts and actions in Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | Members link their identity from a Slack click; an unsigned request is refused | O |
| 6.5 | Mailchimp registered app; optional signed webhooks | Campaign drafts from approved posts | `MAILCHIMP_CLIENT_ID`, `MAILCHIMP_CLIENT_SECRET`, `MAILCHIMP_WEBHOOK_SECRET` | A draft campaign is created (nothing is sent) | O |
| 6.6 | Google Business Profile: API access approval (quota is 0 until granted), verified locations, an OAuth client; optional Pub/Sub ✱ push subscription | GBP posts, reviews in the Inbox | `GBP_CLIENT_ID`, `GBP_CLIENT_SECRET`, `GBP_PUBSUB_AUDIENCE`, `GBP_PUBSUB_SERVICE_ACCOUNT` | A test review appears; a notification triggers a poll | O |
| 6.7 | Cloud Translation ✱: a project with billing, a service account with `roles/cloudtranslate.user`, the list price confirmed. A workspace admin enables it and acknowledges billing | Inbox translation (the original is kept; nothing is auto-sent) | `GOOGLE_TRANSLATE_PROJECT_ID`, `GOOGLE_TRANSLATE_SERVICE_ACCOUNT_JSON`, `GOOGLE_TRANSLATE_LOCATION`, `TRANSLATE_PRICE_PER_MILLION_USD` | Translate a test message | O |
| 6.8 | TipSignal: signing secret plus the brand binding (owned by a service account) | Inbound drafts | `TIPSIGNAL_SIGNING_SECRET` (Setup); Settings → Integrations | A signed test event creates exactly one draft | O |
| 6.9 | API keys for external scripts using `/api/v1` | Machine access | Settings → Developer → Service accounts (step-up) | The key works for drafts on its brand; it fails after revocation | O |
| 6.10 | Live verification: one test account per connector; run "Live verification" in `docs/v3-5/INTEGRATIONS.md` | Honest status | Relay | Evidence recorded | O |
| 6.11 | Broad listening ✱: X credits and budget, a YouTube Data API key, a Bluesky app password, a Reddit commercial agreement, a news/web provider contract. Each also needs an adapter (not built) | Listening beyond connected accounts (connected-source listening goes live with §4) | Provider contracts | Sources leave "Awaiting activation" | O |

## 7. Billing (Stripe)

| # | What | Why / unlocks | Where | Verify | Launch |
|---|---|---|---|---|---|
| 7.1 | Stripe account. Start with a **test** key. The generic `STRIPE_SECRET_KEY` name is ignored on purpose | Billing | `RELAY_STRIPE_SECRET_KEY` | Billing leaves the labelled test double | B |
| 7.2 | Webhook `/api/webhooks/stripe` subscribed to the events in `docs/v4/BILLING_LIFECYCLE_AND_WEBHOOKS.md` | Subscription state | `RELAY_STRIPE_WEBHOOK_SECRET` (+ `_PREVIOUS` during rotation) | Stripe test event → 2xx; the subscription updates | B |
| 7.3 | Two Products with monthly per-unit **GBP** prices (Standard £10, Professional £25); map the price ids to plan versions | Checkout from pricing | Stripe; Platform → Plans | Checkout shows seats × price | B |
| 7.4 | Customer Portal: payment-method update, cancel at period end, invoices (plan switching stays in Relay) | Self-service billing | Stripe | The portal opens from Billing | B |
| 7.5 | Tax: decide; configure Stripe Tax and matching price copy if collecting | Correct prices | Stripe; pricing copy | Prices are labelled inclusive/exclusive | B |
| 7.6 | Confirm the allowances (`packages/core/src/contracts/v4-plans.ts`), past-due grace (7 d, `PAST_DUE_GRACE_DAYS`), trial-ending notice (3 d) and free guests (5) | Commercial terms | Decision → code/env | Recorded | B |
| 7.7 | Live mode only after test-mode verification: an `sk_live_…` key **and** `BILLING_LIVE_MODE=enabled` | Real charges | Secret manager | Billing shows live mode; one staff-run live checkout completes | B |

## 8. Support and the website widget

| # | What | Why / unlocks | Where | Verify | Launch |
|---|---|---|---|---|---|
| 8.1 | Turn the widget on (`widget_enabled`; off by default). Set `widget_staffed` only when people watch Platform → Support (otherwise the widget title says "Send us a message") | Pre-sales chat on the marketing page | Platform → Marketing | A visitor message appears in Platform → Support with source "Widget" | O |
| 8.2 | Malware scanning for attachments, if policy needs it (today: allow-list, size and magic-byte checks only) | Attachment safety | Scanner of your choice | Decision recorded | O |
| 8.3 | Real-device keyboard check (one iOS, one Android) for the widget sheet and the AI composer | Mobile usability | Manual QA | The reply box stays visible above the keyboard | O |

## 9. AI

| # | What | Why / unlocks | Where | Verify | Launch |
|---|---|---|---|---|---|
| 9.1 | AI provider key ✱ + `AI_MODEL` ✱ (+ optional `AI_MODEL_PRICES`, `AI_FALLBACK_MODELS`) | Composer assist, AI replies, AI workspace model steps and Ask, staff ticket summaries, MCP `prepare_with_ai`. Without the key **and** the model these say "AI is not set up"; deterministic steps still run. No model id is built in (D32): pick it from the provider's current docs. Without prices, cost estimates show as unknown (token budgets still apply) | Key: Setup → AI (protected) or environment. Model, prices, fallback list: server environment (validated at start-up) | Setup → AI assistance shows key, model and prices as Set; assist returns suggestions without the "Test fixture" label; a workflow run completes; Admin → AI shows an estimated cost | O |
| 9.2 | Workspace monthly AI token cap (`limits.ai_monthly_tokens`) and per-policy budgets **before** enabling AI replies; platform entitlement overrides as needed. Multi-step workflows are Professional (`ai_workflows`) | Cost control | Settings → Usage and limits; Platform → AI | Budget usage moves; a capped run stops with "budget used up" | O |
| 9.3 | Approve knowledge per brand, with review dates, before any AI answer about policy, prices or refunds | Safe answers | Assistant → Knowledge | Answers cite approved items | O |

## 10. MCP

| # | What | Why / unlocks | Where | Verify | Launch |
|---|---|---|---|---|---|
| 10.1 | Serve `/mcp` over public HTTPS. Set `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` if a proxy rewrites them. With more than one web replica, use **sticky routing on `Mcp-Session-Id`** (sessions are in-process) | Remote MCP clients | `MCP_RESOURCE_URL=https://<domain>/mcp`; proxy | `/.well-known/oauth-protected-resource/mcp` returns the resource; an unauthenticated POST → 401 with `resource_metadata` | O |
| 10.2 | Production IdP: public client `relay-mcp` (standard flow, PKCE S256, consent on, `default.acr.values=mfa`) with **all 13 MCP scopes**, each with an audience mapper → `https://<domain>/mcp`. The local realm has only the 7 V3 scopes | OAuth MCP sign-in, including the inbox, case, listening and AI tools | Keycloak admin | The token has `aud` = the MCP URL and `azp=relay-mcp`; a web-login token is refused at `/mcp` | O |
| 10.3 | Register each real client's redirect URI (MCP Inspector, Claude Code, Claude, ChatGPT) | Each client | Keycloak → relay-mcp | Sign-in + consent succeed; the client is listed in Settings → Developer → MCP | O |
| 10.4 | Decide on dynamic client registration (default off: `MCP_DCR_ENABLED=false`) | DCR-only clients | Keycloak client-registration policies | Registers or is refused as intended | O |
| 10.5 | Test each client: `list_workspaces`; a read-only consent can't `create_draft`; prepare → confirm → commit on a test brand; revoke. Then update the tested-clients table (`packages/services/src/mcp/setup.ts`, MCP guide) | Honest client list | Real clients | Table updated | O |
| 10.6 | Existing clients re-consent to the V3.5 scopes. API-key clients created before V3.5 must be re-created | V3.5 tools | Settings → Developer → MCP | New tools are listed | O |

## 11. Legal pages and policies

| # | What | Why / unlocks | Where | Verify | Launch |
|---|---|---|---|---|---|
| 11.1 | Publish a Privacy notice and Terms (no legal pages exist in the repo); set their links and the support email | Footer stops saying "not published yet"; Meta and Google app reviews require a privacy URL | Platform → Marketing | Footer links resolve | B |
| 11.2 | Customer-facing billing terms, cancellation and refund handling | Paid plans | Legal text; linked from pricing/Billing | Published | B |
| 11.3 | Accept retention: support (archive after 30 d, purge 730 d after archive), Trash (`TRASH_RETENTION_DAYS`, 30 d), AI outputs and attachments (30 d) | Data protection | Policy decision | Recorded | B |
| 11.4 | Erasure and export procedures: there's no self-service account or workspace deletion and no personal-data export. Adopt the engineering-supported procedure | Data-subject requests | `docs/runbooks/data-export-and-deletion.md` | Dry run on a test workspace | B |
| 11.5 | Default draft local-recovery policy (`persistent` / `session` / `off`, max age, clear on sign-out), especially for shared devices | Data-protection posture | Settings → Workspace → Draft recovery | `GET /api/session` → `draft_recovery` | O |

## 12. Platform staff

| # | What | Why / unlocks | Where | Verify | Launch |
|---|---|---|---|---|---|
| 12.1 | Name the first platform operator on the server: `pnpm platform:operator grant <email> operator` (seeds grant the demo owner; never seed production) | Platform admin | Server shell | `/admin/platform` opens for that person | B |
| 12.2 | Assign support staff (`support`) and billing staff (`billing`). Each sets up MFA (privileged actions need step-up) | Platform → Support is watched; billing actions | `pnpm platform:operator grant <email> support\|billing` | The staff member sees the inbox; a step-up prompt appears | B |
| 12.3 | Decide G-A1: make Instance setup platform-operator-only for multi-workspace installs | A tenant owner can't change installation-wide settings | Product decision | Recorded | B |
| 12.4 | Restrict the platform host (`ops.<domain>`, office/VPN IPs) | Smaller attack surface | Proxy / firewall | `/admin/platform` is unreachable from outside | O |

## 13. Security and operations

| # | What | Why / unlocks | Where | Verify | Launch |
|---|---|---|---|---|---|
| 13.1 | Monitoring and alerting (recommended alerts in `docs/runbooks/health-and-monitoring.md`); on-call contacts in a private document | Incident response | Monitoring platform | A test alert reaches on-call | B |
| 13.2 | Error-reporting/APM sink for the web and worker JSON logs | Structured error reporting | Logging platform | A forced error appears with its correlation id and no secrets | B |
| 13.3 | Backups include the means to decrypt (same KMS key/KEK versions); run a restore drill | Restore | Backup policy; `docs/runbooks/backup-restore-and-reconciliation.md` | A restored copy reads a stored credential | B |
| 13.4 | Immutable audit sink decision (DB superusers can rewrite `audit_events`; G-A8) | Audit residual risk | Security owner | Decision recorded | O |
| 13.5 | Real-user Web Vitals collector (LCP/INP/CLS p75 per route; no collection code yet, gap G2). Optionally, a throttled lab series and Lighthouse on a deployed build | Field performance targets | Vendor or own endpoint; CSP `connect-src` | Field p75 after a week | O |
| 13.6 | Feature-flag rollout plan for the six V3.1 flags (off by default); kill-switch drill in staging (`feature_flags.killed`, SQL only) | Controlled release | Settings → Operations → Feature flags | `GET /api/feature-flags` shows the expected source | O |
| 13.7 | G-A5: `GRANT USAGE ON SCHEMA pgboss TO socialite_app; GRANT SELECT ON pgboss.job TO socialite_app;` | Full queue gauges in Operations | DB | Queue gauges show counts | O |
| 13.8 | Watch for self-registration abuse once sign-up is open | Abuse control | `docs/runbooks/keycloak-and-self-registration.md` | Registration events reviewed weekly | O |

Older per-phase checklists are kept for history only: `docs/V2_…`, `docs/V3_…`, `docs/V3_1_…`, `docs/admin/…`,
`docs/v3-5/…`, `docs/v4/…`, `docs/v5/FINAL_ACTIVATION_CHECKLIST.md`. This file supersedes them.
