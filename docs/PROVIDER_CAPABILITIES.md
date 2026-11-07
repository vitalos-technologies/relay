# Provider capabilities

Evidence date **2026-11-06**. Details, sources and error tables: [meta.md](providers/meta.md) · [telegram.md](providers/telegram.md) · [x.md](providers/x.md).

**Status of every provider: implemented and locally verified against simulators and recorded-request contract tests. No live provider publication has been performed** (no credentials or designated test destinations were supplied).

| | Instagram | Facebook | Telegram | X |
|---|---|---|---|---|
| Destination | Professional (business/creator) account linked to a Page | Page | Channel where the bot is admin with *Post Messages* | Authorising user |
| Connection | Facebook Login (Meta app), explicit account pick | Facebook Login, explicit Page pick | Bot token + channel (`@name` or `-100…`), verified; existing webhook untouched | OAuth 2.0 + PKCE |
| API | Graph **v26.0** (pinned) | Graph **v26.0** | Bot API (10.3 changelog) | X API v2 |
| Formats | Single image, carousel (2–10, image/video), Reel (media required) | Text, link, single image, multi-photo, video | Text (+link preview, URL buttons), photo, album (2–10), video | Text/link, 1–4 images, video |
| Text limit | 2,200 code points, 30 hashtags, 20 mentions | 10,000 (conservative; assumed) | 4,096 / caption 1,024 UTF-16 | 280 weighted (URLs = 23) |
| Image | JPEG, aspect 4:5 – 1.91:1 | JPEG/PNG | JPEG/PNG ≤ 10 MB | JPEG/PNG |
| Two-step publish | Containers (children → carousel/reel) → status poll → `media_publish` | Unpublished photos → feed `attached_media`; video upload | `sendMediaGroup` / `sendVideo` | Media upload (chunked for video, status poll) → post |
| Reconcile Unknown | Container status + recent media | Recent page posts | **Unsupported** → manual resolution | Recent user posts (billable read) |
| Edit / delete | No (links to native post) | No | No | No |
| Metrics (V1.1) | Media insights | Post insights | Unavailable (Bot API) | Public metrics (billable read, budgeted) |
| Required scopes | `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement` (+ `business_management` if needed) | `pages_show_list`, `pages_manage_posts`, `pages_read_engagement` | n/a (bot admin right) | `tweet.read tweet.write users.read media.write offline.access` |
| Main gate | Meta App Review + Business Verification | Meta App Review | Bot admin permission | Developer app + prepaid credits |
| Callback | `<APP_BASE_URL>/api/oauth/instagram/callback` | `<APP_BASE_URL>/api/oauth/facebook/callback` | – | `<APP_BASE_URL>/api/oauth/x/callback` |

Capabilities are exposed per destination (`connections.capabilities`, `ChannelCapabilities`) and validated when composing, scheduling and at dispatch.

## Not verified (needs the access spike with real accounts)

- Meta: exact permission set for business-owned Pages; whether App Review requires Facebook Login for Business `config_id`; Facebook caption limit.
- X: exact error bodies for credit exhaustion (based partly on third-party sources); current per-request prices for this project.
- All: token expiry/refresh behaviour, real rate-limit headers, end-to-end publication and revoke/reconnect on real accounts.

## V3 providers (register, reviewed 2026-11-07)

Details, sources (URL + fetch date), verified vs assumed, error tables: [tiktok.md](providers/tiktok.md) ·
[youtube.md](providers/youtube.md) · [linkedin.md](providers/linkedin.md) · [threads.md](providers/threads.md) ·
[pinterest.md](providers/pinterest.md) · [bluesky.md](providers/bluesky.md).
**Live-test status for all six: not tested** (simulators + recorded-request contract tests only; no credentials).

| | TikTok | YouTube | LinkedIn | Threads | Pinterest | Bluesky |
|---|---|---|---|---|---|---|
| Destination | Creator (open_id) | Channel | Member, or Organization (approved Page role) | Profile | **Board** (explicit pick) | Account (DID) |
| Auth | Login Kit OAuth (no PKCE) | Google OAuth + PKCE, offline | OAuth 2.0 (60-day token) | Threads OAuth (own app) → 60-day token | OAuth, Basic auth, continuous refresh | **App password** (atproto OAuth not yet) |
| API | Content Posting API v2 | Data API v3 + Analytics v2 | REST `LinkedIn-Version: 202610` | Threads API v1.0 | API v5 (OpenAPI 5.28.0) | XRPC (`app.bsky.feed.post`) |
| Formats | Video; photos (1–35, PULL_FROM_URL) | Video only | Text, image, 2–20 images, video | Text, image, video, carousel 2–20 | Image, 2–5 images, video | Text, 1–4 images |
| Text | 2,200 UTF-16 | title 100 + description 5,000 bytes | 3,000 (assumed) | 500 (emoji = UTF-8 bytes) | description 800, title 100 | 300 graphemes / 3,000 bytes |
| Required fields | privacy (no default), consent | title, privacy, made-for-kids | – | – | board | – |
| Async | chunked upload → status | resumable upload → processing | image/video processing | container status | video media status | – |
| Reconcile Unknown | status by publish_id | session status + videos.list | org: posts by author; member: manual | container status (definitive) | board Pins | getRecord(rkey) (definitive) |
| Native scheduling | no | **publishAt** (cancel needs force-ssl) | no | no | no | no |
| Metrics | video query (public posts only) | Analytics reports | org share stats / member post analytics | media insights | Pin analytics (≤ 90 d) | like/repost/reply/quote counts |
| Main gate | Direct Post **audit + intended use**; unaudited ⇒ SELF_ONLY/private; inbox/manual handoff | OAuth verification, 100 uploads/day bucket | Community Management API for orgs | App review (advanced access) | Trial ⇒ Pins visible only to you | none (user app password) |
| Callback | `<APP_BASE_URL>/api/oauth/tiktok/callback` | `…/api/oauth/youtube/callback` | `…/api/oauth/linkedin/callback` | `…/api/oauth/threads/callback` | `…/api/oauth/pinterest/callback` | – |
