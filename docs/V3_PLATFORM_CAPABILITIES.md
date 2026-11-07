# V3 platform capabilities

Relay's 10 social networks, as of 2026-11-07 (`v3.0.0`). Sources:
- the adapters' `capabilities()` (`packages/providers/src/<p>/adapter.ts`, `meta/common.ts`);
- the provider register ([PROVIDER_CAPABILITIES.md](PROVIDER_CAPABILITIES.md));
- [providers/*.md](providers/), with source URLs and fetch dates;
- [V3_ANALYTICS_DICTIONARY.md](V3_ANALYTICS_DICTIONARY.md).

## Verification status

| | Count |
|---|---|
| **Verified live** (real account, real API) | **0 of 10.** No developer apps, credentials or designated test destinations exist yet |
| Implemented and tested against labelled fakes / recorded-request contract tests | 10 of 10 |

Contract tests (`tests/contracts/`):

| Network | Tests |
|---|---|
| Meta (Instagram + Facebook) | 89 (`meta` 74, `meta-media` 15) |
| Telegram | 38 |
| X | 40 |
| TikTok | 35 |
| YouTube | 29 |
| LinkedIn | 29 |
| Threads | 24 |
| Pinterest | 22 |
| Bluesky | 25 |
| Shared | `metrics` 9, `media-validation` 9, `transport-allowlist` 3 |

Everything below is what the code does against those fakes. Provider facts come from documentation research, not live calls.

## Publishing

| Network | Destination | Formats (adapter) | Text limit | Required fields | Edit / delete published | Native scheduling | Manual handoff |
|---|---|---|---|---|---|---|---|
| Instagram | Professional account linked to a Page | image, carousel 2–10, Reel | 2,200 chars, 30 hashtags | – | No / No | No | No |
| Facebook | Page | text, link, image, multi-photo, video | 10,000 (assumed) | – | No / No | No | No |
| Telegram | Channel (bot is admin) | text, photo, album 2–10, video | 4,096 / caption 1,024 | – | No / No | No | No (Unknown is resolved by a person; no reconcile API) |
| X | Authorising user | text, 1–4 images, video | 280 weighted | – | No / No | No | No |
| TikTok | Creator (`open_id`) | video; photos 1–35 | 2,200 UTF-16 | privacy (no default), consent | No / No | No | **Yes**: inbox draft (`video.upload` only) or manual download (no posting scope); delivery state `handoff` |
| YouTube | Channel | video only | title 100; description 5,000 bytes | title, privacy, made-for-kids | No / No | **Yes**: `publishAt`, app- or provider-owned per delivery; cancel needs `youtube.force-ssl` | No |
| LinkedIn | Member, or organisation (approved Page role) | text, image, 2–20 images, video | 3,000 (assumed) | – | No / No | No | No (member Unknown is resolved by a person) |
| Threads | Profile | text, image, video, carousel 2–20 | 500 (emoji = UTF-8 bytes) | – | No / No | No | No |
| Pinterest | **Board** (explicit pick) | image, 2–5 images, video | description 800, title 100 | board | No / No | No | No |
| Bluesky | Account (DID) | text, 1–4 images; **no video** | 300 graphemes / 3,000 bytes | – | No / No | No | No |

All adapters report `canEditPublished: false` and `canDeletePublished: false`. Published posts link to the native post.

## Reliability

| Network | Async preparation | Unknown outcome is reconciled by |
|---|---|---|
| Instagram | containers → status poll → `media_publish` | container status + recent media |
| Facebook | unpublished photos / video upload | recent Page posts |
| Telegram | – | **unsupported** (manual) |
| X | chunked media upload + status | recent user posts (billable) |
| TikTok | chunked upload (last chunk publishes) → status | `publish_id` status |
| YouTube | resumable upload (last chunk publishes) → processing | upload session + `videos.list` |
| LinkedIn | image/video upload, multipart video | organisation: posts by author; member: **manual** |
| Threads | containers → status | container status (definitive) |
| Pinterest | video media register/upload → status | board Pins |
| Bluesky | blob upload; deterministic record key | `getRecord(rkey)` (definitive) |

## Analytics (post level)

None of the 10 adapters fetches account-level followers or audience data (`not_fetched`).

| Network | Post metrics fetched | Needs | Notes |
|---|---|---|---|
| Instagram | views, reach, likes, comments, saves, shares, total interactions | `instagram_manage_insights` + `pages_read_engagement` | Requested only when `META_REQUEST_INSIGHTS=true` (after Meta review); otherwise "permission missing" |
| Facebook | media views, unique media views, clicks, reactions by type | `read_insights` + `pages_read_engagement` | Requested only when `META_REQUEST_INSIGHTS=true` (after Meta review) |
| Telegram | none | – | Unsupported by provider (Bot API has no channel statistics); never shown as 0 |
| X | impressions, likes, reposts, replies, quotes, bookmarks | `tweet.read users.read` | Billable reads, budget-metered (`limits.x_monthly_reads`) |
| TikTok | views, likes, comments, shares | `video.list` | Public posts only; private/inbox posts have no public id, so metrics are unavailable |
| YouTube | views, minutes watched, average view duration, likes, comments, shares, subscribers gained | `yt-analytics.readonly` | Revenue excluded; retention % not fetched |
| LinkedIn | organisation: impressions, unique impressions, clicks, likes, comments, shares; member: impressions, members reached, reactions, comments, reshares | `rw_organization_admin` / `r_member_postAnalytics` | All `permission_required`; both scopes are requested only when `LINKEDIN_ORGANIZATIONS=true` |
| Threads | likes, replies, reposts, quotes (+ views, shares) | `threads_manage_insights` | Meta marks views/shares "in development" |
| Pinterest | impressions, saves, Pin clicks, outbound clicks, comments, reactions | `pins:read`, `boards:read` | Window ≤ 90 days |
| Bluesky | likes, reposts, replies, quotes, bookmarks | none (public AppView) | No impressions exist |

## Eligibility and review

| Network | Gate before live use | Without it | Relay behaviour |
|---|---|---|---|
| Instagram | Meta App Review + Business Verification; professional account | Testers only | V1 checklist |
| Facebook | Meta App Review; Page task `CREATE_CONTENT`/`MANAGE` | Testers only | V1 checklist |
| Telegram | Bot added as channel admin with *Post Messages* | Cannot post | Existing webhook never overwritten |
| X | Developer app + prepaid credits | No API access | Workspace X budget |
| TikTok | **Direct Post audit + intended-use review.** TikTok says internal "utility tool" uses are not acceptable; Relay must not misrepresent itself. Photo posts need the media domain verified | Unaudited: `SELF_ONLY` on private accounts, ≤ 5 creators / 24 h | `eligibility: restricted` until `TIKTOK_DIRECT_POST_AUDITED=true`; inbox/manual handoff otherwise. Approval may be refused (capability restriction, not a missing key) |
| YouTube | Google OAuth verification (sensitive scopes); quota audit for more than 100 uploads/day | Unverified-app warnings; 100 `videos.insert`/day | Privacy always explicit; never assumes unverified uploads are private or public |
| LinkedIn | Member: self-serve. Organisation: **Community Management API** review + approved Page role | Member posting only | Org scopes only with `LINKEDIN_ORGANIZATIONS=true`; other roles listed but not selectable |
| Threads | App review for advanced access (`threads_basic`, `threads_content_publish`, `threads_manage_insights`) | App testers only; 250 posts / 24 h | Own Threads app; no Facebook permission reuse |
| Pinterest | Upgrade Trial → Standard (video of OAuth flow + live integration) | Trial: Pins visible only to the creator | `eligibility: restricted` until `PINTEREST_ACCESS_TIER=standard` |
| Bluesky | None; the user creates an app password | – | App password only (atproto OAuth not built); self-hosted servers need `BLUESKY_SELF_HOSTED_HOSTS` |

## Not offered

WhatsApp, Snapchat and Reddit are not publishing adapters and have no connect cards. WhatsApp is queued for the V3.5 inbox (`docs/queue/03f_V3_5_PROMPT.md`), not as feed publishing.
