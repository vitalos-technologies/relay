# Pinterest provider: API v5 (boards → Pins, video media upload, Pin analytics)

Code: `packages/providers/src/pinterest/` (`pinterestAdapter`, `pinterestConnector`, `pinterestFake`, `pinterestMetricsFetcher`).
Contract tests: `tests/contracts/v3-pinterest.test.ts` (22 tests).

Research date: **2026-11-07**. Primary source: Pinterest's official OpenAPI description **v5.28.0**
(`https://raw.githubusercontent.com/pinterest/api-description/main/v5/openapi.json`, linked from
developers.pinterest.com). **Live-test status: not tested.**

## Sources (fetched 2026-11-07)

| # | URL | Used for |
|---|---|---|
| P1 | https://raw.githubusercontent.com/pinterest/api-description/main/v5/openapi.json | Endpoints, schemas, scopes, limits, errors |
| P2 | https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/ | OAuth flow, continuous refresh (60 d) |
| P3 | https://developers.pinterest.com/docs/key-concepts/access-tiers/ | Trial vs Standard access |
| P4 | https://help.pinterest.com/en/business/article/pinterest-product-specs | Image/video/carousel specs |
| S6 | https://developers.pinterest.com/ | Platform |

## Verified facts

- **OAuth (P1, P2)**: authorize `https://www.pinterest.com/oauth/?client_id&redirect_uri&response_type=code&scope&state`;
  token `POST https://api.pinterest.com/v5/oauth/token` with `Authorization: Basic base64(client_id:client_secret)`,
  form `grant_type=authorization_code, code, redirect_uri, continuous_refresh=true` (needed for apps created before
  2025-09-25, ignored otherwise). Access token 30 days; **continuous refresh token 60 days, rotating** (refresh returns
  a new one and `refresh_token_expires_at`); legacy 365-day refresh tokens are no longer supported.
- **Scopes requested**: `boards:read,pins:read,pins:write,user_accounts:read` (secret boards need `*_secret` scopes —
  not requested, so secret boards are not offered).
- **Destinations = boards** (board selection is mandatory and explicit): `GET /v5/user_account` (id, username,
  account_type PINNER|BUSINESS) and `GET /v5/boards?page_size=…&bookmark=…` (`items[{id,name,privacy}]`). Each board
  the user picks becomes one connection.
- **Create Pin (P1)** `POST /v5/pins` (scopes `boards:read boards:write pins:read pins:write`): `board_id`
  (required), `title` ≤ 100, `description` ≤ 800, `link` ≤ 2048, `alt_text` ≤ 500, `media_source` one of
  `image_url {url}`, `multiple_image_urls {items[2–5]{url,title,description,link}}`, `video_id {media_id,
  cover_image_url | cover_image_key_frame_time}`. Response 201 `{id}`. "Intended solely for publishing new content
  created by the user."
- **Video (P1)**: `POST /v5/media {media_type:'video'}` → `media_id, upload_url, upload_parameters`; POST the file as
  multipart form to `upload_url` with every `upload_parameters` field plus `file`; `GET /v5/media/{media_id}` →
  `status` `registered|processing|succeeded|failed`.
- **Specs (P4)**: images PNG/JPEG ≤ 20 MB (2:3 recommended); video MP4/MOV/M4V, H.264/H.265, ≤ 2 GB, 4 s – 15 min;
  carousel 2–5 images; title 100, description 800.
- **Errors (P1)**: `{code, message}` with 400/401/403/404/429.
- **Analytics (P1)**: `GET /v5/pins/{id}/analytics?start_date&end_date&metric_types=…` (≤ 90 days back) →
  `summary_metrics`, `daily_metrics`, `lifetime_metrics`. Metrics: `IMPRESSION, OUTBOUND_CLICK, PIN_CLICK, SAVE,
  SAVE_RATE, TOTAL_COMMENTS, TOTAL_REACTIONS` (+ video `VIDEO_MRC_VIEW, VIDEO_AVG_WATCH_TIME, VIDEO_V50_WATCH_TIME,
  VIDEO_START, VIDEO_10S_VIEW, QUARTILE_95_PERCENT_VIEW`).
- **Access tiers (P3)**: Trial access — Pins and boards are **visible only to their creator** (sandbox entities);
  Standard access requires an upgrade with a video of the OAuth flow and live integration.

## Assumed

- No rate-limit reset header is documented (P1 mentions only `x-ratelimit-category`); 429 waits 60 s.
- Trial vs Standard cannot be detected via the API: the operator sets `PINTEREST_ACCESS_TIER` (`trial` default ⇒
  capability eligibility "Pins visible only to you").
- Image byte limit 20 MB (desktop spec) is used for validation; text counted in code points.
- Reconcile lists `GET /v5/boards/{board_id}/pins` (newest first) and matches description + link.

## Required provider fields

Board = the connection (required, chosen explicitly). Optional `variant.options.pinterest`: `title`, `altText` (empty ⇒ the
first image's library alt text, `PublishMedia.altText`; > 500 is a validation issue — fix H3).
`variant.link` is the destination link (separate field, not appended to the description).

## Checkpoints

Images use `image_url` / `multiple_image_urls` (Pinterest fetches the signed URL) — nothing to prepare. Video:
`prepare` registers the media, uploads to S3 and polls status; checkpoint `{mediaId, uploaded, status}`; a restart
never re-registers an uploaded media id. `publish` = `POST /v5/pins` (`publishes:true`); lost response ⇒ **unknown**,
reconciled from the board's recent Pins.

Callback: `<APP_BASE_URL>/api/oauth/pinterest/callback`. Settings: `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`,
`PINTEREST_ACCESS_TIER`.
