# YouTube provider: Data API v3 resumable upload, native scheduling, Analytics API

Code: `packages/providers/src/youtube/` (`youtubeAdapter`, `youtubeConnector`, `youtubeFake`, `youtubeMetricsFetcher`).
Contract tests: `tests/contracts/v3-youtube.test.ts` (29 tests).

Research date: **2026-11-07**. **Live-test status: not tested** (no Google Cloud project, OAuth verification or
test channel was available).

## Sources (fetched 2026-11-07)

| # | URL | Used for |
|---|---|---|
| Y1 | https://developers.google.com/youtube/v3/docs/videos/insert | URL, scopes, settable properties, errors, quota, unverified-project note |
| Y2 | https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol | Resumable session, chunk rules, 308/Range, status query, 404 restart |
| Y3 | https://developers.google.com/youtube/v3/docs/videos | `status.*`, `processingDetails.*`, title/description/tags limits, `publishAt` rules |
| Y4 | https://developers.google.com/youtube/v3/docs/videos/update | Scopes (`youtube`, `youtube.force-ssl`), 50 units, omitted properties are deleted |
| Y5 | https://developers.google.com/youtube/v3/docs/videos/list | 1 unit, `processingDetails` owner-only |
| Y6 | https://developers.google.com/youtube/v3/docs/thumbnails/set | Thumbnail upload (≤ 50 MB, jpeg/png), ~50 units |
| Y7 | https://developers.google.com/youtube/v3/determine_quota_cost | 10,000 units/day; `videos.insert` own bucket of 100/day |
| Y8 | https://developers.google.com/youtube/v3/docs/errors | `quotaExceeded`, `forbidden`, `insufficientPermissions`, `youtubeSignupRequired` |
| Y9 | https://developers.google.com/youtube/v3/docs/channels/list | `mine=true`, 1 unit |
| Y10 | https://developers.google.com/youtube/analytics/reference/reports/query | Analytics `reports` query |
| Y11 | https://developers.google.com/youtube/analytics/metrics | Metric definitions |
| Y12 | https://developers.google.com/identity/protocols/oauth2/web-server | Google OAuth endpoints, offline access, revoke, granular consent |

## Verified facts

- **OAuth (Y12)**: authorize `https://accounts.google.com/o/oauth2/v2/auth` (`client_id, redirect_uri,
  response_type=code, scope` space-delimited, `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`,
  `state`); token `POST https://oauth2.googleapis.com/token` (`client_id, client_secret, code, redirect_uri,
  grant_type`); refresh (`client_id, client_secret, refresh_token, grant_type=refresh_token`); revoke `POST
  https://oauth2.googleapis.com/revoke` (`token`). The refresh token is only returned on first consent unless
  `prompt=consent`. **Granular consent**: users may deny individual scopes — we check the returned `scope`.
- **Scopes**: required `youtube.upload` (insert, thumbnails.set) and `youtube.readonly` (channels.list mine,
  videos.list); optional `yt-analytics.readonly` (metrics) and `youtube.force-ssl` (videos.update = cancel a native
  schedule, Y4). Without `youtube.force-ssl` **native scheduling is disabled** (pause could not cancel it).
- **Upload (Y1, Y2)**: `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`
  with JSON video resource, `X-Upload-Content-Length`, `X-Upload-Content-Type` → `200` + `Location` (session URI).
  Chunks via `PUT` with `Content-Range: bytes first-last/total`; chunk size a multiple of 256 KB (last exempt), same
  size for all but the last. `308 Resume Incomplete` with `Range: bytes=0-N` (no Range = nothing received);
  `201` with the video resource when complete. Status query: `PUT` `Content-Length: 0`, `Content-Range: bytes */total`.
  500/502/503/504 → resume; **404 → session expired, start a new session**; other 4xx → permanent. Max 256 GB;
  `video/*` or `application/octet-stream`.
- **Settable (Y1)**: `snippet.title, description, tags, categoryId, defaultLanguage`, `status.privacyStatus,
  publishAt, selfDeclaredMadeForKids, containsSyntheticMedia, embeddable, license, publicStatsViewable`;
  `notifySubscribers` query param (default true).
- **Privacy (Y3)**: `private|public|unlisted`; **omitted ⇒ public** (some channel settings default to private) — we
  always send it explicitly. `publishAt` (ISO 8601) only with `privacyStatus=private`, only if never published; a
  past time publishes immediately.
- **Limits (Y3)**: title ≤ 100 characters, no `<` `>`, **required**; description ≤ 5000 **bytes**, no `<` `>`;
  tags total ≤ 500 characters (commas and quotes for tags with spaces count).
- **Processing (Y3, Y5)**: `status.uploadStatus` `uploaded|processed|failed|rejected|deleted`, `failureReason`,
  `rejectionReason`; `processingDetails.processingStatus` `processing|succeeded|failed|terminated` (owner only).
- **Quota (Y1, Y7)**: 10,000 units/day for other endpoints; **`videos.insert` has its own bucket: 100 calls/day,
  1 unit each**; videos.list 1; videos.update 50; thumbnails.set ~50; channels.list 1.
- **Unverified projects (Y1, Y3)**: the current pages state "Videos uploaded from unverified API projects are not
  restricted to private viewing mode." Older revisions said the opposite (post-2020 unverified projects); the spec
  noted inconsistency. We **do not hard-code either**: the adapter reports the privacy YouTube returns.
- **Errors (Y8)**: 403 `quotaExceeded` → **budget**; 403 `forbidden`/`insufficientPermissions` → permission;
  401 `youtubeSignupRequired` (no channel) → permission; 401 auth → reconnect; 400 `uploadLimitExceeded` →
  rate limit (retry after 24 h); `invalidTitle/invalidDescription/invalidTags/invalidPublishAt/...` → invalid.
- **Analytics (Y10, Y11)**: `GET https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate&endDate
  &metrics=views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained
  &filters=video==ID` → `columnHeaders[]`, `rows[]` (omitted when no data ⇒ *not available yet*, not 0). Requires
  `yt-analytics.readonly` (+ `youtube.readonly` per the page banner). Monetary metrics are **not** requested.

## Assumed

- PKCE (`code_challenge`, S256) is accepted for Web-application clients alongside `client_secret` (third-party
  reports; not on Y12). We send both.
- Videos longer than 15 minutes need a verified channel (`status.longUploadsStatus` from channels.list; field not on
  Y9). `maxVideoSeconds` is 15 min unless the channel reports `allowed`.
- Cancelling a schedule = `videos.update?part=status` with `privacyStatus=private` and **no `publishAt`** (Y4 says
  omitted properties are deleted). The adapter then re-reads the video and only reports success if `publishAt` is gone.
- Chunk size 8 MiB (32 × 256 KB). Session URI lifetime is unspecified ("finite"); a 404 restarts the upload.
- Shorts classification is decided by YouTube; we never claim "Short".

## Required provider fields (`variant.options.youtube`)

`title` (≤ 100, no `<>`), `privacyStatus` (`public|unlisted|private`, explicit, no default),
`madeForKids` (explicit boolean). Optional: `tags[]`, `categoryId`, `containsSyntheticMedia`, `notifySubscribers`,
and native scheduling `{ schedulingOwner: 'provider', publishAt }` (sent as `privacyStatus: private` + `publishAt`).
The text body becomes the description (≤ 5000 bytes).

## Scheduling owner

One owner per delivery: **app** (default; the worker uploads at the due time with the chosen privacy) or
**provider** (YouTube `publishAt`; upload happens at dispatch, YouTube releases it later). Provider-owned deliveries:
the processing checkpoint carries `data.remoteSchedule {provider, publishAt, videoId}`; the engine
(`services/engine/remote-schedule.ts`) records `deliveries.scheduling_owner='provider'` + `remote_schedule` (migration
014), keeps polling without the 2 h processing timeout until the release, and on pause (`onScopePaused` wakes the
delivery) calls `youtubeAdapter.cancelRemoteSchedule()`: `cancelled` ⇒ delivery **cancelled** (video stays private),
`too_late` ⇒ normal polling, `uncertain`/`unsupported` ⇒ stays `processing` with code `remote_schedule_uncertain`
and the residual risk in the message, retried every 5 min while paused. Tested in
`tests/integration/v3-remote-schedule.test.ts`. **Gap:** the scheduling service still dispatches at `due_at`; for a
useful provider-held release it must set `due_at` to an upload lead time before `publishAt` (lead task).

## Checkpoints (no duplicates)

`prepare`: open a resumable session (no video exists yet), upload every chunk **except the last**, checkpoint
`{step:'uploading', data:{sessionUri, nextByte, total, chunkSize}}`. A restart asks the session for its `Range` and
continues; a 404 starts a new session (the old one never produced a video). `publish` sends the final chunk
(`publishes:true`): `201` → `processing` with the video id; a lost response → **unknown**, reconciled by asking the
same session (`308` ⇒ not created, `200/201` ⇒ created with id). `reconcile` reads `videos.list?part=status,
processingDetails`: processed ⇒ published (`https://www.youtube.com/watch?v=ID`), failed/rejected ⇒ not published.

## Live verification still needed

Upload on a real channel, quota usage, `longUploadsStatus`, schedule cancellation semantics, token refresh, revoke.
Callback: `<APP_BASE_URL>/api/oauth/youtube/callback`. Settings: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
Google OAuth verification (sensitive/restricted scopes) and YouTube API compliance audit (for quota increases) are
operator steps.
