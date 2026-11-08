# LinkedIn provider: versioned REST Posts API (member vs organization)

Code: `packages/providers/src/linkedin/` (`linkedinAdapter`, `linkedinConnector`, `linkedinFake`, `linkedinMetricsFetcher`).
Contract tests: `tests/contracts/v3-linkedin.test.ts` (29 tests).

Research date: **2026-11-07**. API version pinned: **`LinkedIn-Version: 202610`** (default moniker `li-lms-2026-10`;
202511 sunsets 2026-11-16). Override with setting `LINKEDIN_API_VERSION`. **Live-test status: not tested.**

## Sources (fetched 2026-11-07)

| # | URL | Used for |
|---|---|---|
| L1 | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api | Create post, headers, permissions, 201 + `x-restli-id`, find by author, errors |
| L2 | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/post-api-schema | Post schema, visibility, lifecycleState |
| L3 | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api | Images initializeUpload, formats, member GET restriction |
| L4 | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api | Videos initialize/upload parts/finalize, status, specs |
| L5 | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api | 2–20 images |
| L6 | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format | Commentary escaping |
| L7 | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role | organizationAcls, roles |
| L8 | https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow | OAuth endpoints, 60-day tokens, refresh availability |
| L9 | https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2 | `openid profile`, `/v2/userinfo` |
| L10 | https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin | `w_member_social`, member daily limit 150 requests |
| L11 | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics | Org share statistics |
| L12 | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics | Member post analytics |

## Member vs organization access

| | Member (default) | Organization (opt-in) |
|---|---|---|
| Developer products | Share on LinkedIn + Sign In with LinkedIn (OpenID) — self-serve | **Community Management API** — application and review (S4) |
| Scopes | `openid profile w_member_social` | + `w_organization_social r_organization_social rw_organization_admin` (+ `r_member_postAnalytics`) |
| Author | `urn:li:person:{sub}` | `urn:li:organization:{id}` where the member has an APPROVED `ADMINISTRATOR`, `DIRECT_SPONSORED_CONTENT_POSTER` or `CONTENT_ADMIN(ISTRATOR)` role |
| Reconcile Unknown | **unsupported** (`r_member_social` is restricted) → manual | posts by author (`r_organization_social`) |
| Metrics | `memberCreatorPostAnalytics` (needs `r_member_postAnalytics`) | `organizationalEntityShareStatistics` (`rw_organization_admin`) |

Organization scopes are only requested when the operator sets `LINKEDIN_ORGANIZATIONS=true` (requesting scopes the
app lacks fails the authorization with "Invalid scope", L8). Organizations where the member has another role are
listed but not selectable ("needs Content admin or Administrator role").

## Verified facts

- **OAuth (L8)**: `GET https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id&redirect_uri&state&scope`
  (space-delimited); code valid 30 min; `POST https://www.linkedin.com/oauth/v2/accessToken` form `grant_type,
  code, client_id, client_secret, redirect_uri`; access tokens **60 days**; programmatic refresh tokens only for a
  limited set of partners (used when returned). The member must consent to all scopes (no partial grants).
- **Identity (L9)**: `GET https://api.linkedin.com/v2/userinfo` → `sub, name, picture, …`.
- **Headers (L1)**: every `/rest` call sends `Linkedin-Version: YYYYMM` and `X-Restli-Protocol-Version: 2.0.0`.
- **Create post (L1, L2)**: `POST https://api.linkedin.com/rest/posts` `{author, commentary, visibility,
  distribution:{feedDistribution:'MAIN_FEED', targetEntities:[], thirdPartyDistributionChannels:[]},
  lifecycleState:'PUBLISHED', isReshareDisabledByAuthor:false, content?}` → **201**, id in `x-restli-id`
  (`urn:li:share:…` / `urn:li:ugcPost:…`). Visibility `PUBLIC|CONNECTIONS|LOGGED_IN|CONTAINER`.
  View URL `https://www.linkedin.com/feed/update/{urn}/`.
- **Commentary (L6)**: `little` text; reserved `| { } @ [ ] ( ) < > # \ * _ ~` must be backslash-escaped. We escape
  everything except `#word` hashtags.
- **Images (L3, L5)**: `POST /rest/images?action=initializeUpload {initializeUploadRequest:{owner}}` → `uploadUrl,
  image`; upload the bytes to `uploadUrl`; < 36,152,320 pixels; JPG/GIF/PNG; multi-image 2–20; `altText` ≤ 4086.
  Tokens with only `w_member_social` cannot GET `/rest/images` → member images are not polled.
- **Videos (L4)**: MP4, 3 s – 30 min, 75 KB – 500 MB (5 GB API max). `initializeUpload {owner, fileSizeBytes,
  uploadCaptions:false, uploadThumbnail:false}` → `video, uploadInstructions[{uploadUrl, firstByte, lastByte}],
  uploadToken`; `PUT` each part (`application/octet-stream`), keep each `ETag`; `finalizeUpload {video,
  uploadToken, uploadedPartIds}`; `GET /rest/videos/{urn}` → `status` `PROCESSING|AVAILABLE|PROCESSING_FAILED|
  WAITING_UPLOAD`. Upload URLs expire (typically 30 days).
- **Errors (L1)**: 401 `EMPTY_ACCESS_TOKEN` → reconnect; 403 `ACCESS_DENIED` → permission; 422, 400 → invalid;
  409 `CONFLICT` and 5xx on create → **unknown**; 429 → rate limited.
- **Limits (L10)**: member 150 requests/day, application 100,000/day (Share on LinkedIn).
- **Analytics (L11, L12)**: org — lifetime stats per share via `shares=List(urn)` / `ugcPosts=List(urn)`
  (`impressionCount, uniqueImpressionsCount, clickCount, likeCount, commentCount, shareCount, engagement`; absent
  element ⇒ documented as 0); member — one call per `queryType` (`IMPRESSION, MEMBERS_REACHED, REACTION, COMMENT,
  RESHARE`), `aggregation=TOTAL`.

## Assumed

- Commentary limit **3,000 characters** (widely documented; not on the fetched pages).
- Image upload uses `PUT` with the Bearer token (L3 points to the legacy Assets page for the upload step).
- No rate-limit reset header is documented; 429 waits 1 h (daily windows reset at midnight UTC).
- 422 text containing "duplicate" means duplicate content → **unknown** (an earlier attempt may have posted).
- Image byte size limit not documented; app-side cap 10 MB.

## Checkpoints

`prepare` uploads media (no post exists yet): `data.items[{assetId, urn, state, parts:[etag…], nextPart}]`; video
parts resume from `nextPart`; finalize then poll status until `AVAILABLE`. `publish` creates the post
(`publishes:true`). Lost response ⇒ **unknown**: organizations are reconciled by listing posts by author since the
send time and matching commentary; members ⇒ manual resolution.

Callback: `<APP_BASE_URL>/api/oauth/linkedin/callback`. Settings: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
`LINKEDIN_API_VERSION` (default 202610), `LINKEDIN_ORGANIZATIONS`.
