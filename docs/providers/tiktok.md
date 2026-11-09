# TikTok provider: Content Posting API (Direct Post, inbox/draft upload, manual handoff)

Code: `packages/providers/src/tiktok/` (`tiktokAdapter`, `tiktokConnector`, `tiktokFake`, `tiktokMetricsFetcher`).
Contract tests: `tests/contracts/v3-tiktok.test.ts` (35 tests: OAuth, required fields, chunk boundaries, resume,
photo/inbox, error table, all 8 simulator scenarios, metrics).

Research date: **2026-11-07**. **Verified** = read on developers.tiktok.com on that date. **Assumed** = inference or
undocumented. **Live-test status: not tested** (no TikTok developer app, audit or test creator was available).

## Sources (fetched 2026-11-07)

| # | URL | Used for |
|---|---|---|
| T1 | https://developers.tiktok.com/doc/content-posting-api-reference-direct-post | Direct Post video init, post_info fields, errors, 6 req/min |
| T2 | https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info | creator_info query, privacy options, 20 req/min |
| T3 | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide | Chunk rules, PUT headers, 206/201, media restrictions, PULL_FROM_URL ownership |
| T4 | https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status | status/fetch, status values, fail reasons, 30 req/min |
| T5 | https://developers.tiktok.com/doc/content-posting-api-reference-upload-video | Inbox (draft) video init, `video.upload`, 5 pending shares / 24 h |
| T6 | https://developers.tiktok.com/doc/content-posting-api-reference-photo-post | Photo posts (`/v2/post/publish/content/init/`), 35 photos, title 90 / description 4000 |
| T7 | https://developers.tiktok.com/doc/content-sharing-guidelines | Required Direct Post UX, consent, intended use, unaudited restrictions |
| T8 | https://developers.tiktok.com/doc/login-kit-web | Authorize URL, comma-separated scopes, callback params |
| T9 | https://developers.tiktok.com/docs/en/oauth-get-a-user-access-token | Token endpoint, 2 h access / 180 d refresh |
| T10 | https://developers.tiktok.com/docs/en/oauth-refresh-a-user-access-token | Refresh request (rotating refresh token) |
| T11 | https://developers.tiktok.com/docs/en/oauth-revoke-a-user-access-token | Revoke endpoint |
| T12 | https://developers.tiktok.com/docs/en/tiktok-api-scopes | Scope descriptions |
| T13 | https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info | `/v2/user/info/` fields per scope |
| T14 | https://developers.tiktok.com/doc/tiktok-api-v2-video-query | `/v2/video/query/` (metrics), `video.list` |

## Eligibility gates (read first)

- **Intended use (T7).** TikTok states that "A utility tool to help upload contents to the account(s) you or your
  team manages" is *not* an acceptable Direct Post use case, and apps must serve a wide audience of authentic
  creators. Social Lite's internal-first history makes this a real question. **Do not misrepresent the product to
  obtain approval.** Without approved Direct Post access the product must use the inbox/draft or manual handoff modes.
- **Audit (T1, T6, T7).** Unaudited clients: content is restricted to `SELF_ONLY` viewing, at most 5 users may post
  in 24 h, and those accounts must be private (`unaudited_client_can_only_post_to_private_accounts`).
- **Per-creator caps (T1, T5, T7).** `spam_risk_too_many_posts` (daily cap, typically ~15 posts/day),
  `spam_risk_too_many_pending_share` (≤ 5 pending inbox shares / 24 h), `reached_active_user_cap` (client-wide).
- **PULL_FROM_URL (T3).** Media URLs must be on a domain/URL prefix verified in the developer portal. Photo posts
  only support PULL_FROM_URL, so **photo posts need the storage domain verified**. Video uses FILE_UPLOAD (chunked).

## Publish modes (connection metadata `publish_mode`)

| Mode | When | Behaviour | UI label |
|---|---|---|---|
| `direct` | `video.publish` granted | Direct Post: creator_info → init → chunk upload (last chunk = publish) → status poll | Scheduled automation |
| `inbox` | only `video.upload` granted | Upload to the creator's TikTok inbox as a draft; the creator must open TikTok and finish | **Manual handoff (draft)** |
| `manual` | neither scope | No API publishing (`canPublish=false`); `tiktokManualHandoff()` returns caption + media list to download and post in the app | **Manual handoff** |

Inbox deliveries never become "published" by Social Lite: after the upload the delivery is `processing`; when TikTok
reports `SEND_TO_USER_INBOX` the reconcile result is `still_unknown` with the explicit text `TIKTOK_INBOX_HANDOFF`
("Manual handoff: … It was not published automatically."), so the engine shows **Unknown** with that message. It
turns into Published only when TikTok reports `PUBLISH_COMPLETE` (the creator posted it) — see Engine gaps.

## Verified facts

**OAuth (T8–T11)**
- Authorize `https://www.tiktok.com/v2/auth/authorize/?client_key&response_type=code&scope&redirect_uri&state`.
  Scopes are **comma-separated**. Redirect URI: absolute https, static, no query/fragment, < 512 chars, ≤ 10 per app.
  PKCE is not listed for web apps (T8) — not used. The callback returns `code`, `scopes`, `state`, `error`.
- Token `POST https://open.tiktokapis.com/v2/oauth/token/` (`application/x-www-form-urlencoded`): `client_key,
  client_secret, code, grant_type=authorization_code, redirect_uri`. Response `access_token` (**2 h**), `expires_in`,
  `refresh_token` (**180 d**), `refresh_expires_in`, `open_id`, `scope` (comma-separated), `token_type=Bearer`.
- Refresh: same endpoint, `client_key, client_secret, grant_type=refresh_token, refresh_token`. The refresh token
  **rotates** (the old one is invalidated).
- Revoke `POST https://open.tiktokapis.com/v2/oauth/revoke/` (`client_key, client_secret, token`).
- Errors: `{error, error_description, log_id}`.

**Scopes requested**: `user.info.basic,video.publish,video.upload,video.list` (T12): basic profile; Direct Post;
draft upload; read public videos (metrics). Callback URL: `<APP_BASE_URL>/api/oauth/tiktok/callback`.

**Creator info (T2)** `POST /v2/post/publish/creator_info/query/` (Bearer, JSON) → `creator_username,
creator_nickname, privacy_level_options, comment_disabled, duet_disabled, stitch_disabled,
max_video_post_duration_sec`. Some errors return **HTTP 200** with `error.code` ≠ `ok`.

**Direct Post video (T1, T3)** `POST /v2/post/publish/video/init/` body `{post_info:{title (≤ 2200 UTF-16),
privacy_level, disable_duet, disable_comment, disable_stitch, video_cover_timestamp_ms, brand_content_toggle,
brand_organic_toggle, is_aigc}, source_info:{source:FILE_UPLOAD, video_size, chunk_size, total_chunk_count}}` →
`data.publish_id`, `data.upload_url` (valid 1 h). `PUT upload_url` per chunk with `Content-Type: video/mp4`,
`Content-Length`, `Content-Range: bytes first-last/total`; `206` = more chunks, `201` = all received (TikTok then
posts). Chunks 5–64 MB (last ≤ 128 MB), `total_chunk_count = floor(size / chunk_size)`, 1–1000 chunks, sequential,
files < 5 MB in one chunk. Upload errors 400/403 (expired URL)/404/416/5xx (retry chunk).

**Inbox video (T5)** `POST /v2/post/publish/inbox/video/init/` with `source_info` only; same upload. Users "must
click on inbox notifications to continue the editing flow in TikTok".

**Photo (T6)** `POST /v2/post/publish/content/init/` `{post_info:{title ≤ 90, description ≤ 4000, privacy_level,
disable_comment, auto_add_music, brand_content_toggle, brand_organic_toggle}, source_info:{source:PULL_FROM_URL,
photo_cover_index, photo_images[≤ 35]}, post_mode: DIRECT_POST|MEDIA_UPLOAD, media_type: PHOTO}`.

**Status (T4)** `POST /v2/post/publish/status/fetch/ {publish_id}` → `status` ∈ `PROCESSING_UPLOAD,
PROCESSING_DOWNLOAD, SEND_TO_USER_INBOX, PUBLISH_COMPLETE, FAILED`, `fail_reason`, `publicaly_available_post_id[]`
(only when public and moderated), `uploaded_bytes`, `downloaded_bytes`.

**Media (T3)** Video: MP4/WebM/MOV, H.264/H.265/VP8/VP9, 23–60 fps, 360–4096 px each side, ≤ 4 GB; the Upload
Video endpoint accepts up to 10 min (creator limit from creator_info). Images: WebP/JPEG, ≤ 1080p, ≤ 20 MB.

**Required Direct Post UX (T7)** — enforced as required provider fields in `variant.options.tiktok`:
- creator nickname shown; latest creator_info fetched at post time (prepare re-queries it);
- `privacyLevel` chosen manually from `privacy_level_options` (**no default**; validated against creator_info);
- `allowComment/allowDuet/allowStitch` off by default (unset ⇒ sent as `disable_*: true`); the composer reads live
  creator_info (`GET /api/connections/:id/tiktok-creator-info`) and greys out an interaction the creator disabled, and
  prepare re-reads creator_info and always sends a creator-disabled interaction as disabled; photo posts show and send
  Comment only (fix H1, 2026-11-09);
- commercial disclosure: `brandOrganic` ("Your brand" → "Promotional content"), `brandContent` ("Branded
  content" → "Paid partnership"); branded content **cannot be `SELF_ONLY`**;
- `consent: true` — content is sent only after express consent (Music Usage Confirmation / Branded Content
  Policy declaration shown in the UI);
- no watermarks or promotional text added by Social Lite.

**Rate limits**: init 6/min/user token; creator_info 20/min; status 30/min. 429 `rate_limit_exceeded`.

## Assumed

- No `Retry-After` header is documented; 429 waits 60 s. Daily caps (`spam_risk_too_many_posts`,
  `spam_risk_too_many_pending_share`) are retried after 6 h; `reached_active_user_cap` blocks with **budget**.
- An init'ed but incomplete FILE_UPLOAD (upload URL expired) creates nothing visible; prepare re-inits.
- Video codec names from ffprobe: `h264`, `hevc`, `vp8`, `vp9`.
- Manual handoff page URL `https://www.tiktok.com/upload` (not an API; used only as a link).

## Error policy

| Condition | prepare | publish | Blocking |
|---|---|---|---|
| 401 `access_token_invalid` | permanent | permanent_failure | reconnect |
| 401 `scope_not_authorized` | permanent | permanent_failure | permission |
| 403 `unaudited_client_can_only_post_to_private_accounts` | permanent `tiktok_unaudited_client` | permanent_failure | permission (eligibility) |
| 403 `url_ownership_unverified` | permanent | permanent_failure | permission (setup) |
| 403 `spam_risk_user_banned_from_posting` | permanent | permanent_failure | permission |
| 403 `reached_active_user_cap` | permanent | permanent_failure | budget |
| 403 `spam_risk_too_many_posts` / `_pending_share` | retryable 6 h | rejected_safe_to_retry 6 h | – |
| 403 `privacy_level_option_mismatch`, 400 `invalid_param` | permanent | permanent_failure | – |
| 429 | retryable 60 s | rejected_safe_to_retry 60 s | – |
| 5xx / lost response on final chunk or init | retryable | **unknown** (reconciled by `publish_id`) | – |

## Checkpoints (no duplicates)

`prepare` (nothing visible): creator_info → init → upload chunks **except the last** →
`{step:'uploading', data:{publishId, uploadUrl, nextChunk, chunkSize, totalChunks, mode}, expiresAt: +55 min}`.
A restart resumes from `nextChunk`; an expired URL re-inits. `publish` uploads the last chunk (`publishes:true`)
→ `processing` with `providerIds:[publish_id]`. Photo posts: `publish` = content init (`publishes:true`).
`reconcile` = status/fetch by `publish_id` (from providerIds or checkpoint): `PUBLISH_COMPLETE` → published
(post id when public), `FAILED` → not published, otherwise processing.

## Analytics

`POST /v2/video/query/?fields=id,view_count,like_count,comment_count,share_count` with `filters.video_ids`
(needs `video.list` and the **public** post id from `publicaly_available_post_id`). Private/SELF_ONLY or inbox posts
have no public id ⇒ metrics **unavailable** (never 0).

## Engine gaps (for the lead)

- No first-class "manual handoff" delivery state: inbox deliveries end in `unknown` (engine code `status_unavailable`,
  message = `TIKTOK_INBOX_HANDOFF`) and resolve automatically on `PUBLISH_COMPLETE` or by manual resolution.
- int64 post ids (`publicaly_available_post_id`) are read from the raw JSON text (JSON.parse would round them).
- The download + open-app handoff (`manual` mode) needs a UI action; the adapter exposes `tiktokManualHandoff()`.
