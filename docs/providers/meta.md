# Meta providers: Facebook Pages and Instagram (Facebook Login route)

Code: `packages/providers/src/meta/` (`facebookAdapter`, `instagramAdapter`, `facebookConnector`,
`instagramConnector`, `metaFake`). Contract tests: `tests/contracts/meta.test.ts`.

Research date: **2026-11-06**. Meta developer pages were reachable on this date, with the caveats
noted below. Official documentation and a real developer-console test supersede this file. The
access spike in spec §5 (an authorized test post on a real Page and IG account, plus denied-permission
and revoke/reconnect tests) is **still outstanding**. Nothing below has been exercised against live Meta.

## Sources (fetched 2026-11-06)

| # | URL | Used for |
|---|---|---|
| M1 | https://developers.facebook.com/docs/graph-api/changelog/versions | Version table (v26.0 released 2026-07-29) |
| M2 | https://developers.facebook.com/docs/graph-api/changelog | Index text says "latest is v27.0" |
| M3 | https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow | Login dialog, code exchange |
| M4 | https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived | `fb_exchange_token`, 60-day user token, Page tokens with no expiry |
| M5 | https://developers.facebook.com/docs/graph-api/securing-requests | `appsecret_proof` |
| M6 | https://developers.facebook.com/docs/graph-api/reference/user/accounts/ | `/me/accounts`, `tasks` |
| M7 | https://developers.facebook.com/docs/graph-api/reference/user/permissions/ | `/me/permissions` shape |
| M8 | https://developers.facebook.com/docs/permissions | Permission descriptions and dependencies, App Review |
| M9 | https://developers.facebook.com/docs/pages-api/posts | `/feed` (message, link, published), tasks, Page token |
| M10 | https://developers.facebook.com/docs/graph-api/reference/page/photos/ | `/photos` (`url`, `caption`; `message` deprecated), 10 MB, formats |
| M11 | https://developers.facebook.com/docs/graph-api/reference/page/published_posts/ | Reconcile listing |
| M12 | https://developers.facebook.com/docs/instagram-platform/content-publishing | IG flow, status codes, 24h expiry, Page token, PPA |
| M13 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media | Container create params, image limits, caption limits |
| M14 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container | `status_code` values |
| M15 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish | `creation_id`, partial-success `config_issue` |
| M16 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit | Quota endpoint |
| M17 | https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/get-started | `instagram_business_account` on a Page |
| M18 | https://developers.facebook.com/docs/graph-api/guides/error-handling | Error structure and codes |
| M19 | https://developers.facebook.com/docs/graph-api/overview/rate-limiting | Usage headers, throttle codes |
| M20 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes | IG publishing codes and subcodes |

## Verified vs assumed

### Verified (official docs, 2026-11-06)
- **Graph version.** The versions table (M1) lists **v26.0** (released 2026-07-29, expiry TBD) as the newest
  version. **Pinned default: `v26.0`.** You can override it with `ProviderAppConfig.apiVersion`; values must match `vNN.N`.
- **Login dialog** `https://www.facebook.com/<ver>/dialog/oauth` takes `client_id`, `redirect_uri` and `state` (required), plus
  `response_type` (default `code`) and `scope` (comma- or space-separated) (M3).
- **Code exchange.** `GET https://graph.facebook.com/<ver>/oauth/access_token?client_id&redirect_uri&client_secret&code`
  runs server to server and returns `access_token`, `token_type` and `expires_in` (M3). The docs do not mention PKCE.
- **Long-lived user token.** `GET /oauth/access_token?grant_type=fb_exchange_token&client_id&client_secret&fb_exchange_token`
  returns a token that lasts about 60 days (sample `expires_in` 5183944). Page tokens fetched with a long-lived user token
  "do not have an expiration date" (M4).
- **appsecret_proof** = HMAC-SHA256 of the access token, keyed with the app secret, sent as the `appsecret_proof` parameter (M5).
- **`/me/accounts`** returns Page nodes, and the edge adds `tasks` (a list of enums) (M6). The IG Facebook Login guide says it lists Pages
  where the user can do MANAGE, CREATE_CONTENT, MODERATE or ADVERTISE (M17).
- **`/me/permissions`** returns `data: [{permission, status: granted|declined|expired}]` (M7).
- **Facebook Page text/link post.** `POST /{page-id}/feed` takes `message`, `link` and `published` (default true), uses a Page token
  and returns `id` (M9).
- **Facebook Page photo.** `POST /{page-id}/photos` takes `url` and **`caption`** (`message` is deprecated) plus `published`, and
  returns `id` (the photo) and `post_id`. It needs `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` and the
  CREATE_CONTENT task. Accepted formats are JPEG, BMP, PNG, GIF and TIFF, up to 10 MB (M10).
- **Instagram publishing (Facebook Login route).** It uses host `graph.facebook.com` and a **Page access token**, and needs
  `instagram_basic`, `instagram_content_publish` and `pages_read_engagement`, plus `ads_management` or `ads_read` when the Page
  role comes from Business Manager (M12).
- **Container.** `POST /{ig-user-id}/media` takes `image_url` and `caption` and returns `{id}`. Images must be JPEG only, ≤ 8 MB,
  aspect ratio 4:5 to 1.91:1, and 320 to 1440 px wide (scaled). Captions are limited to 2,200 characters, 30 hashtags and 20 @tags (M13).
- **Status.** `GET /{container-id}?fields=status_code` returns one of `FINISHED`, `IN_PROGRESS`, `ERROR`, `EXPIRED` or `PUBLISHED`. Containers expire
  after 24 h. When the status is ERROR, `status` holds a subcode (M12, M14). Meta recommends polling about once a minute for at most 5 minutes (M12).
- **Publish.** `POST /{ig-user-id}/media_publish` with `creation_id` returns `{id}` (the media id). A partial success
  (`config_issue`) is still published (M15).
- **Quota.** `GET /{ig-user-id}/content_publishing_limit?fields=quota_usage,config` returns `config.quota_total`, which is
  currently **50** per 86,400 s (M16). The content-publishing guide (M12) says 100 in one place and 50 in another. We trust the API's
  own `quota_total`.
- **IG account on a Page.** `GET /{page-id}?fields=instagram_business_account` (M17).
- **Error codes and usage headers**, from M18, M19 and M20. See the error table below.

### Assumed / not verified
- **v27.0.** The changelog index (M2) and the manual-flow examples (M3) mention v27.0, but the versions table (M1) does not
  list it and `/changelog/version27.0` returned 404. We pin v26.0 until v27.0 appears in the table. Revisit at the next compatibility review.
- **Field selection on `/me/accounts`.** We request `instagram_business_account{id,username,name}` and `tasks` in a single call.
  This is standard Graph field selection on Page nodes, but M17 shows only the per-Page form.
- **`published_posts` with `since` and `fields`.** M11 says the edge "doesn't have any parameters" (it means edge-specific ones), and the
  Graph-wide `since`/`fields`/`limit` modifiers are assumed to apply. Reconcile also filters by `created_time` on our side.
- **IG media listing fields** `id,caption,timestamp,permalink` and the media lookup `?fields=id,permalink,timestamp` are standard
  IG Media fields that we did not re-read on this date.
- **Facebook text length.** No limit was found on the pages read. We use a **conservative 10,000 code points** (63,206 is widely
  reported).
- **Counting unit.** Meta says "characters". We count Unicode code points.
- **What Meta does when `media_publish` is called on an already-published container** is not documented. The adapter never does it: prepare
  detects `PUBLISHED` and publish then resolves the existing media. The fake answers `24/2207008`.
- **`business_management`** is not requested. M8 does not say it is required for Pages owned by a business portfolio. If Pages
  are missing from `/me/accounts` for business-owned assets during the access spike, add it to the requested scopes (it depends on
  `pages_read_engagement` and `pages_show_list`).
- **Authorization header.** Graph examples always pass `access_token` as a parameter. We did not verify Bearer-header support, so we use
  the documented form (see Transport below).

## Scopes

| Provider | Requested and checked by `health()` |
|---|---|
| Facebook Page | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` |
| Instagram | `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish` |

Dependencies (M8): `pages_manage_posts` → `pages_read_engagement` and `pages_show_list`; `instagram_content_publish` → `instagram_basic`,
`pages_read_engagement` and `pages_show_list`; `instagram_basic` → `pages_show_list` (M8 also lists `pages_read_user_content`, but the
IG Facebook Login guide requests only `instagram_basic` and `pages_show_list`. Confirm this during the spike).

The user must also hold a CREATE_CONTENT or MANAGE **task** on the Page. Destinations without one are listed with
`unavailableReason`.

## App setup, App Review and Business Verification

1. Create a Meta app of type **Business** at developers.facebook.com and add **Facebook Login** (or Facebook Login for Business).
2. Under *Valid OAuth Redirect URIs*, add `<APP_BASE_URL>/api/oauth/facebook/callback` and `<APP_BASE_URL>/api/oauth/instagram/callback`.
   The same value must be sent in both the dialog and the code exchange (M3).
3. Set `META_APP_ID` → `clientId`, `META_APP_SECRET` → `clientSecret`, and optionally a pinned `apiVersion`. `isConfigured()` needs both id and secret.
4. In development mode, only app roles (admins, developers, testers) can authorize. For other users, request **Advanced Access** for
   every scope above through **App Review**, with a screencast per permission (for `pages_manage_posts`, M8 asks the screencast to show
   create, edit and delete) and a use-case description. Request nothing unneeded, because extra permissions are a common reason for rejection (M8).
5. **Business Verification** is required for Advanced Access (M8). Also complete data-handling questions and the annual Data Use Checkup.
6. Instagram accounts must be **professional** (Business or Creator) and **linked to a Facebook Page** (M17). Pages that require
   **Page Publishing Authorization** or 2FA must have completed it, or publishing fails (M12, M15).
7. **Facebook Login for Business** can use a `config_id` instead of `scope`. The adapter currently sends `scope` (classic dialog
   parameters). If the app is set up with a FLfB configuration, a `config_id` parameter must be added. This is a gap that needs a config field from the lead.

## Transport and security
- POST: `application/x-www-form-urlencoded` body that carries `access_token` and `appsecret_proof` (sent when `clientSecret` is set).
- GET: `access_token` and `appsecret_proof` go in the query string, the documented Graph form. `HttpTransport` logs only
  `redactProviderUrl(url)`, which redacts `access_token`, `appsecret_proof`, `client_secret`, `code` and `fb_exchange_token`. The tests assert this.
- OAuth token calls do not add `appsecret_proof` (they authenticate with `client_secret`).
- Op labels: `meta.facebook.{feed,photos,published_posts,post_lookup,page_lookup,page_token}`,
  `meta.instagram.{media_create,container_status,publishing_limit,media_publish,media_lookup,media_list,account_lookup}`,
  `meta.{permissions,accounts}` and `meta.oauth.{exchange_code,long_lived}`. Only `meta.facebook.feed`, `meta.facebook.photos` and
  `meta.instagram.media_publish` set `publishes: true`.
- Raw provider error text is parsed but never put into outcome messages or exceptions.

## Capabilities

| | Facebook Page | Instagram |
|---|---|---|
| Formats | text (with optional link), single image | single image |
| Text counting | code points | code points |
| Max text / caption | 10,000 / 10,000 (conservative, assumed) | 2,200 / 2,200 (verified) |
| Link | separate `link` field on text posts. On image posts it is appended to the caption (`/photos` has no link field) | **not supported** (not clickable). Validation fails with `link_unsupported` and the exact fix. Never silently dropped |
| Image MIME | `image/jpeg`, `image/png` (subset of the verified list) | `image/jpeg` only |
| Max image bytes | 10 MB | 8 MB |
| Aspect / width | none | 0.8 to 1.91, min width 320 |
| Hashtags / mentions | none | 30 / 20 |
| Buttons | no | no |
| Edit / delete / metrics | no / no / no (MVP) | no / no / no |
| Reconcile | yes (search `published_posts`) | yes (container status + media list) |

`constraintsVersion` = `meta-<provider>-2026-11-06-<graph version>`.

## Flows

**Facebook.** `prepare` validates and returns `ready` (a no-op checkpoint). `publish` posts to `/feed` or `/photos` and returns
`confirmed` with `providerIds = [post_id(, photo_id)]` and `url = https://www.facebook.com/<post_id>`.
`reconcile` looks up known ids, then searches `/{page}/published_posts?since=<sentAt−10min>` for a message that equals (or starts
with) the variant text. A match gives `published`. Otherwise the result is **`still_unknown`**: Facebook has no idempotency key, so absence is never proof.

**Instagram.**
- `prepare` with no checkpoint creates a container and polls once.
  - `FINISHED` → `ready`.
  - `IN_PROGRESS` → `pending`, rechecked after 5 s, 5 s, 10 s, 15 s, 30 s, then 60 s.
  - After 10 minutes stuck, the outcome is `retryable` and a fresh container is made on the retry.
- The checkpoint is `{containerId, createdAt, expiresAt: createdAt+24h, polls}` with `Checkpoint.expiresAt` set.
- On re-entry, the expiry check comes first. At or past `expiresAt − 10 min`, the adapter checks the status, so a `PUBLISHED` container is never re-made, and then creates a fresh container.
  - `EXPIRED`, or a container-expired error (24/2207008, 2207006, 2207020), → fresh container.
  - `ERROR` → `permanent`, with the fix text from the status subcode. Transient subcodes → `retryable`.
  - `PUBLISHED` → `ready`, with `published: true` in the checkpoint.
- `publish` handles an already-published container by resolving the media from the media list, without calling `media_publish`. Otherwise:
  - It checks `content_publishing_limit`. If `quota_usage ≥ quota_total`, the result is `permanent_failure` with `blocking: 'rate_limit'`. If the check itself fails, publishing continues.
  - Then `media_publish {creation_id}` returns `confirmed` with `[media id]`, and the permalink when the best-effort lookup succeeds.
- `reconcile` tries, in order: known media ids, then the container status, then `/{ig}/media` matched on caption and time.
  - A matching media item, or `PUBLISHED`, gives `published`. When the media is not yet listed, `providerIds` may be empty.
  - `EXPIRED` or `ERROR` gives `not_published`. The provider says the container can no longer be published.
  - `FINISHED` or `IN_PROGRESS` 10 minutes or more after `sentAt`, with no matching media, gives `not_published`.
  - Anything else gives `still_unknown`.

**Health** (both). The Page or IG lookup uses the Page token and decides `reconnect_required`, because Page tokens outlive the 60-day user
token. `/me/permissions` uses the user token and lists `missingPermissions`. Transient failures throw `MetaHealthUnavailableError`, so the caller
keeps the previous status.

**Connectors.**
- `authorizationUrl` builds the dialog URL above.
- `exchangeCode` gets a short-lived token, exchanges it for a long-lived one, and reads `/me/permissions`. It returns `scopes`, the **granted** permissions only, and `expiresAt` = now + `expires_in`.
- `listDestinations` reads `/me/accounts` (up to 5 pages of 100).
  - Facebook: one candidate per Page. A Page without CREATE_CONTENT or MANAGE gets `unavailableReason`.
  - Instagram: one candidate per Page that has `instagram_business_account`. A Page without one gets *"Link an Instagram professional account to this Page"*.
  - Candidates never carry tokens.
- `finalize` re-reads the Page (`fields=access_token,...`) to get the Page token and checks that the IG link is still the same. It returns
  `{kind:'meta_page', pageAccessToken, userAccessToken, userTokenExpiresAt}` and metadata `page_id`, `page_name`, `ig_user_id`, `ig_username`, `graph_version`, plus a health check.
  - Connection `expiresAt = null`, because the Page token has no expiry.
  - The app does not implement `refreshCredentials`: Meta has no refresh token, so the user reconnects.

## Error normalisation

| Graph condition | Class | Publish outcome | Prepare outcome | Notes |
|---|---|---|---|---|
| 190, 102, 104, 2500; subcodes 458/460/463/467 | reconnect | permanent_failure, blocking `reconnect` | permanent, `reconnect` | M18 |
| subcode 459/464 (checkpoint) | reconnect | permanent_failure, `reconnect` | permanent | user must log in on facebook.com |
| 10, 3, 200–299 | permission | permanent_failure, blocking `permission` | permanent, `permission` | M18 |
| subcode 492 | permission | permanent_failure, `permission` | permanent | Page role lost |
| 100 / subcode 33 | permission | permanent_failure, `permission` | permanent | object inaccessible |
| 4, 17, 32, 341, 613, 80001, 80002; 9/2207042 | rate_limit | rejected_safe_to_retry, `retryAfterMs` | retryable | max `estimated_time_to_regain_access` (minutes) from `X-Business-Use-Case-Usage`. If `X-App-Usage` is ≥ 100 % or absent, 15 min (M19) |
| `is_transient: true` (incl. codes 1, 2) | transient | rejected_safe_to_retry (60 s) | retryable | |
| IG 2207001, 2207003, 2207032, 2207053 | transient | rejected_safe_to_retry | retryable | IG "try again" codes (M20) |
| 1, 2, −1, −2 without `is_transient`; HTTP 5xx; unparseable | server_error | **unknown** (reconcile) | retryable | a publish might have gone through |
| 506 duplicate post | duplicate | **unknown** | retryable | an earlier attempt may have posted it |
| 9007 / 2207027 media not ready | not_ready | rejected_safe_to_retry (10 s) | retryable | |
| 24/2207006, 24/2207008, −2/2207020 | container_expired | rejected_safe_to_retry (prepare recreates) | fresh container | |
| 100 (other), 324, 1609005, 36000/2207004, 36001/2207005, 36003/2207009, 36004/2207010, 2207023, 2207026, 2207040, 9004/2207052 | invalid | permanent_failure with the exact fix | permanent | |
| 368 policy block; 4/2207051 spam; 25/2207050 restricted | policy | permanent_failure (2207050 blocking `permission`) | permanent | needs human action |
| other 4xx | invalid | permanent_failure `provider_rejected` | permanent | |
| TransportError, `requestMayHaveBeenSent` on a publish call | — | **unknown** `response_lost` | — | |
| TransportError, pre-connect | — | rejected_safe_to_retry | retryable | |
| TransportError on container create or poll | — | — | retryable | containers are invisible, so this is safe |

## Limits
- IG: `content_publishing_limit` `quota_total` (50 per 24 h on 2026-11-06, M16). Containers expire after 24 h. Poll at most for about 10 minutes per container.
- Facebook: Page API calls with a Page token use BUC limits (code 80001, M19). We read the usage headers for back-off.
- Meta signed media URLs: Meta fetches `image_url` and `url` itself, so the signed URL TTL must cover container processing (minutes) and
  any retries. The URL must be reachable by Meta (M12: "must be on a public server").

## Simulation (`metaFake`)
`metaFake` simulates every endpoint above for `mock_` destinations.
- Facebook mock Page id = account id. IG mock: IG user id = account id, and its Page = `<account>_page`.
- It honours each `MockScenario` on the final publish call (`/feed`, `/photos`, `/media_publish`), except:
  - `fail_permanent` hits content validation: `100` on Facebook, `36003/2207009` on IG container create.
  - `missing_permission`: `200` on Facebook publish, `10` on IG container create and publish, and the scope is declined in `/me/permissions`.
  - `processing`: the IG container stays `IN_PROGRESS` for the first 2 polls.
  - `revoked`: `190/460` on every call that uses a token.
- Throttling is simulated as Graph does it: HTTP 400 with code 80001 or 80002 and an `X-Business-Use-Case-Usage` header (2 minutes), not as HTTP 429.
- Objects persist in `env.store`, and the "once" counters are keyed by provider, account, op and scenario.
