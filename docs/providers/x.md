# X provider: posts via X API v2 with OAuth 2.0 (PKCE)

Code: `packages/providers/src/x/` (`xAdapter`, `xConnector`, `xFake`). Connection lifecycle:
`packages/services/src/connections/`. Contract tests: `tests/contracts/x.test.ts`; integration:
`tests/integration/connections.test.ts`.

Research date: **2026-11-06**. Facts marked **verified** were read from docs.x.com on that date. Facts marked
**assumed** come from third-party reports or inference. Nothing here has been run against the live X API yet.
The spec §5 access spike is **still outstanding**: a real developer app, a test post, a media upload, a 401
after revoking the app, and the console's pricing for this project.

## Sources (fetched 2026-11-06)

| # | URL | Used for |
|---|---|---|
| X1 | https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code | Authorize URL, params, PKCE, scopes, 2h token, 30s code |
| X2 | https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token | Token/refresh/revoke requests, confidential-client Basic auth |
| X3 | https://docs.x.com/x-api/media/upload-media | `POST /2/media/upload` (simple upload) |
| X4 | https://docs.x.com/x-api/media/quickstart/media-upload-chunked | v2 chunked endpoints, STATUS polling |
| X5 | https://docs.x.com/x-api/posts/create-post | `POST /2/tweets` body/response/scopes |
| X6 | https://docs.x.com/x-api/users/get-my-user | `GET /2/users/me` |
| X7 | https://docs.x.com/x-api/users/get-posts | `GET /2/users/:id/tweets` (reconcile) |
| X8 | https://docs.x.com/x-api/fundamentals/rate-limits | Rate-limit headers, per-endpoint limits, 429 |
| X9 | https://docs.x.com/x-api/fundamentals/response-codes-and-errors | Problem JSON shape, `usage-capped`, `client-forbidden` |
| X10 | https://docs.x.com/x-api/getting-started/pricing | Pay-per-usage credits and per-request prices |
| A1 | https://www.ayrshare.com/solutions/x-twitter-api-error-403-duplicate-post-how-to-fix-it/ | (third-party) duplicate-content 403 |
| A2 | https://opentweet.io/tools/x-api-error-decoder · https://docs.revive.social/general-guides/fix-credits-depleted-error-when-posting-to-x | (third-party) 402 / "Credits Depleted" |

## Verified facts

**OAuth 2.0 Authorization Code with PKCE** (X1, X2)
- Authorize: `https://x.com/i/oauth2/authorize?response_type=code&client_id&redirect_uri&scope&state&code_challenge&code_challenge_method`
  (`S256` or `plain`; we use `S256`). The redirect URI must match exactly. `state` can be up to 500 characters.
- The auth code is valid for **30 seconds**. The callback exchanges it immediately.
- Token: `POST https://api.x.com/2/oauth2/token`, `Content-Type: application/x-www-form-urlencoded`, body
  `code, grant_type=authorization_code, redirect_uri, code_verifier`. **Confidential clients** send
  `Authorization: Basic base64(client_id:client_secret)` and omit `client_id` from the body. Public clients send
  `client_id` in the body.
- Refresh: same endpoint, `grant_type=refresh_token&refresh_token=…` (Basic auth for confidential clients).
  Refresh tokens are issued **only with `offline.access`**.
- Access tokens last **two hours** by default.
- Revoke: `POST https://api.x.com/2/oauth2/revoke` (`token`). Not called yet; see Gaps.
- Scopes include `tweet.read`, `tweet.write`, `users.read`, `offline.access` and `media.write`. We request exactly
  these five.

**Endpoints**
- `GET /2/users/me?user.fields=name,username,profile_image_url` returns `data.{id,name,username,profile_image_url}`
  (X6). Scopes: `tweet.read users.read`.
- `POST /2/media/upload` (X3) accepts `multipart/form-data` (raw bytes) or JSON (base64). Required fields are
  `media` and `media_category` (`tweet_image`, …). The response has `data.{id, media_key, expires_after_secs, size,
  processing_info{state: pending|in_progress|failed|succeeded, check_after_secs, progress_percent}}`. Scope:
  `media.write`. **Images use this single-request upload.** The chunked v2 flow
  (`/2/media/upload/initialize`, `/{id}/append`, `/{id}/finalize`) is only needed for video and large media,
  and the old `command=INIT|APPEND|FINALIZE` must not be sent to `POST /2/media/upload` (X4). Status polling:
  `GET /2/media/upload?command=STATUS&media_id=…`, used only when `processing_info` is returned (X4).
  `tweet_image` has a 5 MB limit (X4).
- `POST /2/tweets` (X5) takes a JSON body `{ text, media: { media_ids: [...] } }`, among other fields. Unknown fields
  are rejected (`additionalProperties: false`). It returns **201** with
  `data.{id, text, edit_history_post_ids}`. Scopes: `tweet.read tweet.write users.read`. Up to 4 photos per post;
  the product uses 1.
- `GET /2/users/:id/tweets` (X7) accepts `start_time`, `end_time`, `max_results` (5–100), `since_id`, `until_id`,
  `exclude=replies,retweets`, and returns `data[].{id,text}` and `meta.{result_count,newest_id,oldest_id,next_token}`.
  The current docs name the field selector `post.fields` (formerly `tweet.fields`). Because of that rename, we
  request only the default fields.

**Errors and rate limits** (X8, X9)
- Errors are Problem JSON: `{ title, detail, type: "https://api.x.com/2/problems/<kind>", status }`. Some
  endpoints return `{ errors: [...] }`. Problem types include `usage-capped` ("Usage cap exceeded") and
  `client-forbidden` ("App not enrolled or lacks required access").
- Headers: `x-rate-limit-limit`, `x-rate-limit-remaining`, and `x-rate-limit-reset` (a Unix timestamp when the
  window resets). A 429 means "Rate limit exceeded". Wait until `x-rate-limit-reset`.
- Limits: `POST /2/tweets` 100 per 15 min per user, 10,000 per 24 h per app. `POST /2/media/upload` 500 per 15 min per user.
  `GET /2/users/me` 75 per 15 min per user. `GET /2/users/:id/tweets` 900 per 15 min per user.

**Pricing** (X10, read 2026-11-06; **confirm in the project's Developer Console before launch**)
- Pay-per-usage with **prepaid credits**. No subscription. A spending limit can be set per billing cycle, and
  requests are blocked once it is reached. Requests are also blocked when credits run out or the balance goes
  negative.
- Listed prices: Post create **$0.015** per request, or **$0.200 per request when the post contains a URL**. Post read
  $0.005 per resource. User read $0.010 per resource. Owned reads $0.001 per resource on listed endpoints. Media
  metadata $0.005 per request. **No separate media-upload price was listed.**
- Resources are deduplicated within a 24-hour UTC window, which the page calls a "soft guarantee".
- Consequences for Social Lite:
  - A post with a link costs about 13× as much as one without.
  - Each health check (`/2/users/me`) is a billable user read. Workers check every 6 h, and X is excluded
    from the expiry-driven checks.
  - **Each reconcile call is a billable post read** (`/2/users/:id/tweets`), so the engine must budget reconcile
    polls.

## Assumed (third-party or inferred; verify in the access spike)

- **Duplicate content**: X answers `403` with
  `detail: "You are not allowed to create a Tweet with duplicate content."` (A1). We classify this as **Unknown**,
  not Failed, because an earlier attempt whose response was lost may have posted.
- **Credits depleted**: HTTP **402** (A2). Its body type and title are undocumented, so we also match
  `credits` and `usage cap` text. Together with `usage-capped`, this becomes `permanent_failure`, blocking `budget`.
- `client-forbidden` with `reason: client-not-enrolled` means the app is not attached to a Project or package
  with access. We report it as a permission block with the fix in the Developer Console.
- Refresh-token lifetime when unused is not documented. A failed refresh marks the connection **Reconnect
  required**.
- `x-rate-limit-reset` is in epoch seconds (X8 says "Unix timestamp"). A `retry-after` header is used as a fallback.

## Setup (operator)

1. In the X Developer Console, create a Project and an App with **pay-per-use credits** and a spending limit.
2. Under **User authentication settings**, enable OAuth 2.0. Set Type of App to **Web App (confidential client)**
   and App permissions to **Read and write**. Set the **Callback URI** to `GET /api/providers` → `x.callback_url`
   (`${APP_BASE_URL}/api/oauth/x/callback`). Set a Website URL.
3. Copy the OAuth 2.0 **Client ID** and **Client Secret** into `X_CLIENT_ID` / `X_CLIENT_SECRET` (env), or into the
   Setup page (stored encrypted). With no secret, the app is treated as a public client (PKCE only).
4. Customers go to **Accounts → Connect X**. Social Lite redirects to X with PKCE (S256) and a single-use 10-minute
   state bound to the user, workspace and brand. On return, it shows the authorizing account, and the user
   confirms the selection (AC-02).

## Capabilities and constraints (`X_CONSTRAINTS`, version `x-api-v2@2026-11-06`)

| | |
|---|---|
| Formats | text, single image (JPEG/PNG ≤ 5 MB) |
| Text | 280 **X-weighted** (twitter-text; URLs count 23). The link is appended to the text. |
| Buttons | not supported |
| Reconcile | yes, by timeline search (billable) |
| Edit/delete/metrics | not implemented |

Published URL: `https://x.com/<username>/status/<id>` (or `https://x.com/i/web/status/<id>`).

## Adapter flow

1. `prepare`: if there is an image, `POST /2/media/upload` (multipart, `media_category=tweet_image`). The
   checkpoint is `{step:'media_ready', data:{mediaId, expiresAt}}`. If `processing_info` is pending or
   in_progress, the result is `pending` with `checkAfterMs = check_after_secs*1000`, and the next `prepare`
   polls STATUS. A valid checkpoint (more than 5 minutes before expiry) is reused without uploading again.
2. `publish`: `POST /2/tweets {text, media:{media_ids:[mediaId]}}` with `publishes: true` → `confirmed`.
3. `reconcile`: `GET /2/users/:id/tweets?start_time=<sentAt-10min>&max_results=20&exclude=replies,retweets`.
   Texts are compared after normalisation: t.co and media links stripped, `&amp;`/`&lt;`/`&gt;` decoded,
   whitespace collapsed, case folded. A match gives `published`; otherwise the result is `still_unknown`.
4. `refreshCredentials`: rotating refresh. The connections service serializes it per connection (advisory
   lock, then a re-read of `refresh_version`, then the provider call outside any transaction).

## Error policy

| Condition | prepare | publish | Blocking |
|---|---|---|---|
| 401 | permanent | `permanent_failure` (the engine refreshes once with `forceRefresh` first) | `reconnect` |
| 402, `usage-capped`, credits/spend text | permanent | `permanent_failure` | `budget` (X only) |
| 403 duplicate content | – | **`unknown`** (an earlier attempt may have posted) | – |
| 403 `client-forbidden` / not enrolled | permanent | `permanent_failure` `x_app_not_enrolled` | `permission` |
| other 403 | permanent | `permanent_failure` `x_forbidden` | `permission` |
| 429 | retryable until `x-rate-limit-reset` | `rejected_safe_to_retry`, `retryAfterMs` from reset | – |
| 400 (invalid text/media) | permanent | `permanent_failure` | – |
| 5xx | retryable (an upload creates no post) | `unknown` | – |
| Transport, pre-connect | retryable | `rejected_safe_to_retry` | – |
| Transport, after send | retryable | `unknown` | – |

Alt text (fix H3, 2026-11-09): after an image is uploaded and ready, `POST /2/media/metadata`
`{id, metadata:{alt_text:{text}}}` (≤ 1,000, `media.write`; listed price $0.005/request) for each image with library
alt text; `altSet` in the checkpoint prevents a repeat. `capabilities.canReadMetrics` is true (public metrics; billable
reads metered on `x.read`; fix H7).

Health (`/2/users/me`):
- A 401, or a user id that differs from the connection's account, means **Reconnect required**.
- Missing granted scopes, or `client-forbidden`, means **Missing permission**.
- A token with no refresh token that expires within 24 h means **Expiring**.

## Simulated destination (`xFake`)

Serves the token endpoint, `/2/users/me`, media upload and STATUS, `/2/tweets` and `/2/users/:id/tweets`.
Scenarios:
- `processing`: the upload returns `processing_info`, and STATUS succeeds on the 2nd poll.
- `fail_permanent`: 400.
- `fail_transient_once`: a pre-connect failure, then success.
- `rate_limited_once`: 429 with `x-rate-limit-reset` 5 s ahead.
- `timeout_after_send`: the post is stored and the response is lost. Reconcile then finds it.
- `revoked`: 401, and refresh returns `invalid_request`.
- `missing_permission`: `/2/tweets` returns 403, and `/users/me` returns 403 `client-forbidden`.

The fake also rejects duplicate text with the 403 duplicate-content shape. Ids are `mock_…`.

## Gaps

- Token revocation on disconnect (`/2/oauth2/revoke`) is not called. The stored credential is deleted immediately.
- Every number above (prices, limits) must be re-checked against the project's own console before launch.

## V1.1 multi-image and video (research date 2026-11-07)

Code: `media.ts`, `adapter.ts`, `fake.ts`. Contract tests: `tests/contracts/x-media.test.ts`.

| # | URL (fetched 2026-11-07) | Used for |
|---|---|---|
| X11 | https://docs.x.com/x-api/media/quickstart/media-upload-chunked | initialize / append / finalize / STATUS request shapes, segment size |
| X12 | https://docs.x.com/x-api/media/quickstart/best-practices | 4 photos / 1 GIF / 1 video per post; video constraints |
| X13 | https://docs.x.com/x-api/media/introduction | Size and duration limits per `media_category` |

**Verified.**
- `POST /2/media/upload/initialize` JSON `{media_type: "video/mp4", total_bytes, media_category: "tweet_video"}` → `data.id`,
  `expires_after_secs`; `POST /2/media/upload/{id}/append` multipart `segment_index` (from 0) + `media`, segments ≤ 5 MB
  (server max 8 MB); `POST /2/media/upload/{id}/finalize` → `processing_info`; `GET /2/media/upload?command=STATUS&media_id=`
  until `succeeded | failed`, waiting `check_after_secs`. `command=INIT|APPEND|FINALIZE` must not be sent.
- "You may attach up to 4 photos, 1 animated GIF or 1 video in a Post."
- tweet_video: ≥ 0.5 s; 20 min / 8 GB (default account); 32×32–1280×1024; ≤ 60 fps; aspect 1:3–3:1; H.264 (High
  recommended), AAC-LC, mono/stereo, yuv420p, progressive, no open GOP.

**Assumed.** Re-sending an already received segment replaces it (used on resume); 1280×1024 applies to either orientation
(X recommends 720×1280 for portrait); a second `finalize` after a lost response errors with 4xx, so we then ask STATUS.
Videos and photos are not mixed (implied by "4 photos, 1 GIF or 1 video").

**Behaviour.** 2–4 images: one simple upload each (`tweet_image`); checkpoint `data.items[]` keeps every uploaded
`mediaId` so a retry uploads only the missing ones. Video: initialize → 4 MB appends (checkpoint `media_uploading` with
`nextSegment`) → finalize → `pending` until STATUS `succeeded` (`media_processing` → `media_ready`). A retry continues
from the next segment of the same media id. Publish sends `media.media_ids` in order (`publishes: true`, lost ⇒ unknown,
reconciled by timeline search). The pipeline transcodes videos into the 1280×1024 envelope, so derivatives fit X.
Capabilities: `text, image, album, video` (constraints `x-api-v2@2026-11-07`). Simulator: chunked endpoints, segment and
size checks, `fail_permanent` ⇒ processing `failed`, video never mixed with other media.
