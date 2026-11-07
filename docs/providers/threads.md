# Threads provider: Threads API (containers → publish), its own OAuth

Code: `packages/providers/src/threads/` (`threadsAdapter`, `threadsConnector`, `threadsFake`, `threadsMetricsFetcher`).
Contract tests: `tests/contracts/v3-threads.test.ts` (24 tests).

Research date: **2026-11-07**. **Live-test status: not tested.** Threads uses its **own** app id/secret and OAuth
(`threads.com/oauth/authorize`); Facebook Login tokens or permissions are never reused.

## Sources (fetched 2026-11-07)

| # | URL | Used for |
|---|---|---|
| H1 | https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions | Authorize window, code exchange, scopes |
| H2 | https://developers.facebook.com/docs/threads/get-started/long-lived-tokens | 1 h short-lived, 60-day long-lived, refresh rules |
| H3 | https://developers.facebook.com/docs/threads/posts | Containers, media types, carousel, publish, 500-char text |
| H4 | https://developers.facebook.com/docs/threads/troubleshooting | Container status, error messages, 24 h expiry, 250 posts/24 h |
| H5 | https://developers.facebook.com/docs/threads/overview | Image/video specs, hosts, version v1.0 |
| H6 | https://developers.facebook.com/docs/threads/threads-media | List user threads (reconcile), permalink |
| H7 | https://developers.facebook.com/docs/threads/threads-profiles | `GET /me?fields=…` |
| H8 | https://developers.facebook.com/docs/threads/insights | Media insights metrics |
| S5 | https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api | (spec reference) |

## Verified facts

- **Hosts (H5)**: `graph.threads.net` or `graph.threads.com`; current examples use `graph.threads.com` (used here),
  version `v1.0`.
- **OAuth (H1, H2)**: `https://threads.com/oauth/authorize?client_id&redirect_uri&scope&response_type=code&state`
  (comma-separated scopes; `threads_basic` mandatory). Codes valid 1 h, single use. `POST
  https://graph.threads.com/oauth/access_token` form `client_id, client_secret, code, grant_type=authorization_code,
  redirect_uri` → `access_token, user_id` (short-lived, **1 h**). Exchange server-side: `GET /access_token?
  grant_type=th_exchange_token&client_secret&access_token` → 60-day token (`expires_in`). Refresh: `GET
  /refresh_access_token?grant_type=th_refresh_token&access_token` (token ≥ 24 h old, unexpired). Tokens travel in the
  query string — the transport redacts `access_token`, `client_secret`, `code` in logs.
- **Scopes**: `threads_basic, threads_content_publish, threads_manage_insights` (+ optional reply scopes, not used).
- **Profile (H7)**: `GET /v1.0/me?fields=id,username,name,threads_profile_picture_url`.
- **Containers (H3)**: `POST /v1.0/{user-id}/threads` with `media_type=TEXT|IMAGE|VIDEO|CAROUSEL`, `text`,
  `image_url`/`video_url` (public URL fetched by Threads), `is_carousel_item=true` for children, `children` (comma
  list) for the carousel parent, `link_attachment` (text posts only) → `{id}`. Publish `POST /v1.0/{user-id}/
  threads_publish` form `creation_id` → `{id}` (media id). Wait ~30 s on average before publishing.
- **Status (H4)**: `GET /{container-id}?fields=status,error_message` → `IN_PROGRESS|FINISHED|PUBLISHED|ERROR|EXPIRED`;
  containers expire after **24 h**; poll about once a minute for ≤ 5 min. Errors: `FAILED_DOWNLOADING_VIDEO,
  FAILED_PROCESSING_AUDIO, FAILED_PROCESSING_VIDEO, INVALID_ASPEC_RATIO, INVALID_BIT_RATE, INVALID_DURATION,
  INVALID_FRAME_RATE, INVALID_AUDIO_CHANNELS, INVALID_AUDIO_CHANNEL_LAYOUT, UNKNOWN`.
- **Limits (H3–H5)**: text **500 characters, emojis counted as their UTF-8 bytes**; carousel 2–20; 250 posts per
  24 h (`GET /{user-id}/threads_publishing_limit?fields=quota_usage,config`). Images JPEG/PNG ≤ 8 MB, aspect ≤ 10:1,
  width 320–1440 (scaled). Video MOV/MP4, H.264/HEVC, AAC ≤ 48 kHz, 23–60 fps, aspect 0.01:1–10:1, width ≤ 1920,
  ≤ 300 s, ≤ 1 GB.
- **Insights (H8)**: `GET /{media-id}/insights?metric=views,likes,replies,reposts,quotes,shares`
  (`threads_manage_insights`); `views`/`shares` are marked "in development"; values via `values[].value` or
  `total_value.value`.

## Assumed

- Graph-style errors `{error:{message,type,code,error_subcode}}`: code 190 → reconnect; 10/200–299 → permission;
  4/17/32/613 → rate limited (no reset header documented; 15 min); publishing-limit exhaustion → budget.
- Topic tags, reply control and alt text are not sent (alt text not covered by H3).

## Required provider fields

None beyond text/media. `variant.link` on a text post is sent as `link_attachment`; otherwise appended to text.

## Checkpoints

`prepare` creates containers (not visible): children first, then the carousel parent; polls status until
`FINISHED` (`pending` with 30 s / 60 s back-off). Checkpoint `{step, data:{items:[{assetId, containerId, status}],
parentId, createdAt}, expiresAt: +23 h}`; expired containers are recreated. `publish` = `threads_publish`
(`publishes:true`). Lost response ⇒ **unknown**; `reconcile` reads the container status — `PUBLISHED` is definitive —
and finds the media id in `GET /{user-id}/threads?fields=id,text,timestamp,permalink&since=…`.

Callback: `<APP_BASE_URL>/api/oauth/threads/callback`. Settings: `THREADS_APP_ID`, `THREADS_APP_SECRET`.
App review (Advanced Access for `threads_basic` / `threads_content_publish` / `threads_manage_insights`) is required
before non-tester accounts can connect (H6 notes tester-only reads without advanced access).
