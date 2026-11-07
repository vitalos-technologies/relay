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
