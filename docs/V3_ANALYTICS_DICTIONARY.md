# Relay V3 — Analytics dictionary

> Generated from `packages/services/src/analytics/registry.ts` by `scripts/analytics-dictionary.ts` — do not edit by hand. Provider facts verified 2026-11-07 (sources in `packages/providers/src/<provider>/metrics.ts`).

## How to read this

- **Metric id** `<provider>.<scope>.<native metric>` + **version**. Definitions are immutable per (metric_id, version). Changing a definition adds a new version; facts keep the version they were observed under.
- **Time basis** — `lifetime`: cumulative total since publication, observed at a moment (stored as an as-of snapshot, never as “activity that day”); `window`: provider total over a rolling window (Pinterest ≤ 90 days: equals lifetime while the Pin is younger than the window); `snapshot`: point-in-time gauge (followers); `daily`: provider-defined day bucket.
- **Aggregation** — `sum`: additive across posts; `latest`: snapshot gauge, one latest value per account, never summed over dates; `ratio_of_sums`: Σ numerator ÷ Σ denominator; `none`: not aggregated.
- **Family** decides what may be combined: only metrics of the SAME family are ever added; unique families (reach) are never added across accounts or networks; cross-network totals are labelled with their native components.
- **Paid**: `organic`, `mixed` (network total includes boosted/promoted distribution), `paid` (excluded from Relay analytics).
- **Availability**: `available`, `permission_required` (needs an approved scope/role), `in_development` (network marks it so), `not_fetched` (supported by the network, not requested by the current adapter), `excluded`.
- **Delay**: data is complete through `observed_at − delay` (shown as the series “through” date).

## Families

| Family | Label | Cross-network | Unique people | In “Engagements” |
|---|---|---|---|---|
| `views` | Views | labelled sum | no | no |
| `impressions` | Impressions | labelled sum | no | no |
| `reach` | Reach (unique accounts) | never combined | yes | no |
| `likes` | Likes & reactions | labelled sum | no | yes |
| `comments` | Comments & replies | labelled sum | no | yes |
| `shares` | Shares & reposts | labelled sum | no | yes |
| `quotes` | Quotes | labelled sum | no | yes |
| `saves` | Saves & bookmarks | labelled sum | no | yes |
| `clicks` | Clicks | labelled sum | no | no |
| `link_clicks` | Outbound link clicks | labelled sum | no | no |
| `interactions_total` | Network total interactions | never combined | no | no |
| `watch_time` | Watch time | labelled sum | no | no |
| `avg_view_duration` | Average view duration | never combined | no | no |
| `followers_gained` | Followers gained | labelled sum | no | no |
| `followers` | Followers | labelled sum | no | no |
| `audience` | Audience breakdown | never combined | yes | no |
| `retention` | Audience retention | never combined | no | no |
| `revenue` | Revenue | never combined | no | no |

## Measures (what the analytics views can show)

| Measure | Label | Unit | Built from |
|---|---|---|---|
| `posts_published` | Posts published | count | app records (published deliveries) |
| `engagements` | Engagements | count | likes + comments + shares + quotes + saves |
| `engagement_rate_views` | Engagement rate (by views) | percent | Σ engagements ÷ Σ views over posts reporting both |
| `engagement_rate_impressions` | Engagement rate (by impressions) | percent | Σ engagements ÷ Σ impressions over posts reporting both |
| `views` | Views | count | views |
| `impressions` | Impressions | count | impressions |
| `reach` | Reach (sum of per-post unique counts) | count | reach |
| `likes` | Likes & reactions | count | likes |
| `comments` | Comments & replies | count | comments |
| `shares` | Shares & reposts | count | shares |
| `quotes` | Quotes | count | quotes |
| `saves` | Saves & bookmarks | count | saves |
| `clicks` | Clicks | count | clicks |
| `link_clicks` | Outbound link clicks | count | link_clicks |
| `watch_time` | Watch time | minutes | watch_time |
| `avg_view_duration` | Average view duration | seconds | Σ watch time (s) ÷ Σ views over videos reporting both |
| `followers` | Followers (latest snapshot) | count | latest follower snapshot per account |

## Instagram

| Metric id | v | Native | Name | Unit | Scope | Family | Aggregation | Basis | Paid | Availability | Fetched | Scopes | Delay h | Retention |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `instagram.post.views` | 1 | `views` | Views | count | post | views | sum | lifetime | organic | available | yes | `instagram_basic` `instagram_manage_insights` `pages_read_engagement` | 24 | — |
| `instagram.post.reach` | 1 | `reach` | Reach | count | post | reach | sum | lifetime | organic | available | yes | `instagram_basic` `instagram_manage_insights` `pages_read_engagement` | 24 | — |
| `instagram.post.likes` | 1 | `likes` | Likes | count | post | likes | sum | lifetime | organic | available | yes | `instagram_basic` `instagram_manage_insights` `pages_read_engagement` | 24 | — |
| `instagram.post.comments` | 1 | `comments` | Comments | count | post | comments | sum | lifetime | organic | available | yes | `instagram_basic` `instagram_manage_insights` `pages_read_engagement` | 24 | — |
| `instagram.post.saved` | 1 | `saved` | Saves | count | post | saves | sum | lifetime | organic | available | yes | `instagram_basic` `instagram_manage_insights` `pages_read_engagement` | 24 | — |
| `instagram.post.shares` | 1 | `shares` | Shares | count | post | shares | sum | lifetime | organic | available | yes | `instagram_basic` `instagram_manage_insights` `pages_read_engagement` | 24 | — |
| `instagram.post.total_interactions` | 1 | `total_interactions` | Total interactions (Instagram) | count | post | interactions_total | sum | lifetime | organic | available | yes | `instagram_basic` `instagram_manage_insights` `pages_read_engagement` | 24 | — |
| `instagram.account.followers_count` | 1 | `followers_count` | Followers | count | account | followers | latest | snapshot | organic | not_fetched | no | — | 0 | — |
| `instagram.account.follower_demographics` | 1 | `follower_demographics` by country | Follower countries | count | account | audience | none | snapshot | organic | not_fetched | no | `instagram_manage_insights` | 0 | — |

- **Views** (`instagram.post.views`): Times the media was played or displayed (replaces impressions/plays for media after 2024-07-02).
- **Reach** (`instagram.post.reach`): Unique accounts that saw the media. A unique count: not additive across posts or networks.
- **Likes** (`instagram.post.likes`): Likes on the media.
- **Comments** (`instagram.post.comments`): Comments on the media.
- **Saves** (`instagram.post.saved`): Unique saves of the media.
- **Shares** (`instagram.post.shares`): Shares of the media.
- **Total interactions (Instagram)** (`instagram.post.total_interactions`): Instagram composite of likes, saves, comments and shares (minus unlikes/unsaves/deleted comments). Not added to Relay engagements (would double count).
- **Followers** (`instagram.account.followers_count`): Follower count of the account at the time of observation (snapshot). Not requested by the current adapter.
- **Follower countries** (`instagram.account.follower_demographics`): Follower distribution by country (Instagram reports demographics only for accounts with ≥ 100 followers). Threshold: 100.

## Facebook

| Metric id | v | Native | Name | Unit | Scope | Family | Aggregation | Basis | Paid | Availability | Fetched | Scopes | Delay h | Retention |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `facebook.post.post_media_view` | 1 | `post_media_view` | Views | count | post | views | sum | lifetime | mixed | available | yes | `read_insights` `pages_read_engagement` | 24 | — |
| `facebook.post.post_total_media_view_unique` | 1 | `post_total_media_view_unique` | Viewers | count | post | reach | sum | lifetime | mixed | available | yes | `read_insights` `pages_read_engagement` | 24 | — |
| `facebook.post.post_clicks` | 1 | `post_clicks` | Clicks | count | post | clicks | sum | lifetime | mixed | available | yes | `read_insights` `pages_read_engagement` | 24 | — |
| `facebook.post.post_reactions_by_type_total` | 1 | `post_reactions_by_type_total` by reaction_type | Reactions | count | post | likes | sum | lifetime | mixed | available | yes | `read_insights` `pages_read_engagement` | 24 | — |
| `facebook.account.page_follows` | 1 | `page_follows` | Followers | count | account | followers | latest | snapshot | organic | not_fetched | no | — | 0 | — |

- **Views** (`facebook.post.post_media_view`): Number of times the post was on screen (Meta "Media views"). Includes paid distribution if the post was boosted. Meta reports post insights as lifetime totals; the value grows after publication and is observed, not event-timed.
- **Viewers** (`facebook.post.post_total_media_view_unique`): Unique accounts that saw the post at least once (Meta "Viewers"). A unique count: not additive across posts or networks.
- **Clicks** (`facebook.post.post_clicks`): Clicks anywhere in the post.
- **Reactions** (`facebook.post.post_reactions_by_type_total`): Reactions by type (like, love, wow, haha, sorry, anger). Summed over types for totals.
- **Followers** (`facebook.account.page_follows`): Follower count of the account at the time of observation (snapshot). Not requested by the current adapter.

## Telegram

No metrics: the Bot API exposes no post or channel statistics to bots. Shown as **unsupported**, never 0.

## X

| Metric id | v | Native | Name | Unit | Scope | Family | Aggregation | Basis | Paid | Availability | Fetched | Scopes | Delay h | Retention |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `x.post.impression_count` | 1 | `impression_count` | Impressions | count | post | impressions | sum | lifetime | mixed | available | yes | `tweet.read` `users.read` | 0 | — |
| `x.post.like_count` | 1 | `like_count` | Likes | count | post | likes | sum | lifetime | mixed | available | yes | `tweet.read` `users.read` | 0 | — |
| `x.post.repost_count` | 1 | `repost_count` (alias `retweet_count`) | Reposts | count | post | shares | sum | lifetime | mixed | available | yes | `tweet.read` `users.read` | 0 | — |
| `x.post.reply_count` | 1 | `reply_count` | Replies | count | post | comments | sum | lifetime | mixed | available | yes | `tweet.read` `users.read` | 0 | — |
| `x.post.quote_count` | 1 | `quote_count` | Quotes | count | post | quotes | sum | lifetime | mixed | available | yes | `tweet.read` `users.read` | 0 | — |
| `x.post.bookmark_count` | 1 | `bookmark_count` | Bookmarks | count | post | saves | sum | lifetime | mixed | available | yes | `tweet.read` `users.read` | 0 | — |
| `x.account.followers_count` | 1 | `followers_count` | Followers | count | account | followers | latest | snapshot | organic | not_fetched | no | — | 0 | — |

- **Impressions** (`x.post.impression_count`): Times the post was seen (X public metrics). Includes promoted delivery if the post was promoted.
- **Likes** (`x.post.like_count`): Likes.
- **Reposts** (`x.post.repost_count`): Reposts (formerly retweets).
- **Replies** (`x.post.reply_count`): Replies.
- **Quotes** (`x.post.quote_count`): Quote posts.
- **Bookmarks** (`x.post.bookmark_count`): Bookmarks.
- **Followers** (`x.account.followers_count`): Follower count of the account at the time of observation (snapshot). Not requested by the current adapter.

## TikTok

| Metric id | v | Native | Name | Unit | Scope | Family | Aggregation | Basis | Paid | Availability | Fetched | Scopes | Delay h | Retention |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `tiktok.video.view_count` | 1 | `view_count` | Video views | count | video | views | sum | lifetime | organic | available | yes | `video.list` | 24 | — |
| `tiktok.video.like_count` | 1 | `like_count` | Likes | count | video | likes | sum | lifetime | organic | available | yes | `video.list` | 24 | — |
| `tiktok.video.comment_count` | 1 | `comment_count` | Comments | count | video | comments | sum | lifetime | organic | available | yes | `video.list` | 24 | — |
| `tiktok.video.share_count` | 1 | `share_count` | Shares | count | video | shares | sum | lifetime | organic | available | yes | `video.list` | 24 | — |
| `tiktok.account.follower_count` | 1 | `follower_count` | Followers | count | account | followers | latest | snapshot | organic | not_fetched | no | — | 0 | — |

- **Video views** (`tiktok.video.view_count`): Views of a public video (TikTok Display API). Private/draft posts report nothing (unsupported, never 0).
- **Likes** (`tiktok.video.like_count`): Likes.
- **Comments** (`tiktok.video.comment_count`): Comments.
- **Shares** (`tiktok.video.share_count`): Shares.
- **Followers** (`tiktok.account.follower_count`): Follower count of the account at the time of observation (snapshot). Not requested by the current adapter.

## YouTube

| Metric id | v | Native | Name | Unit | Scope | Family | Aggregation | Basis | Paid | Availability | Fetched | Scopes | Delay h | Retention |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `youtube.video.views` | 1 | `views` | Views | count | video | views | sum | lifetime | organic | available | yes | `yt-analytics.readonly` `youtube.readonly` | 72 | — |
| `youtube.video.estimatedMinutesWatched` | 1 | `estimatedMinutesWatched` | Watch time | minutes | video | watch_time | sum | lifetime | organic | available | yes | `yt-analytics.readonly` `youtube.readonly` | 72 | — |
| `youtube.video.averageViewDuration` | 1 | `averageViewDuration` | Average view duration | seconds | video | avg_view_duration | ratio_of_sums | lifetime | organic | available | yes | `yt-analytics.readonly` `youtube.readonly` | 72 | — |
| `youtube.video.likes` | 1 | `likes` | Likes | count | video | likes | sum | lifetime | organic | available | yes | `yt-analytics.readonly` `youtube.readonly` | 72 | — |
| `youtube.video.comments` | 1 | `comments` | Comments | count | video | comments | sum | lifetime | organic | available | yes | `yt-analytics.readonly` `youtube.readonly` | 72 | — |
| `youtube.video.shares` | 1 | `shares` | Shares | count | video | shares | sum | lifetime | organic | available | yes | `yt-analytics.readonly` `youtube.readonly` | 72 | — |
| `youtube.video.subscribersGained` | 1 | `subscribersGained` | Subscribers gained | count | video | followers_gained | sum | lifetime | organic | available | yes | `yt-analytics.readonly` `youtube.readonly` | 72 | — |
| `youtube.video.averageViewPercentage` | 1 | `averageViewPercentage` | Average percentage viewed | percent | video | retention | none | lifetime | organic | not_fetched | no | `yt-analytics.readonly` `youtube.readonly` | 72 | — |
| `youtube.video.estimatedRevenue` | 1 | `estimatedRevenue` | Estimated revenue | count | video | revenue | none | lifetime | paid | excluded | no | `yt-analytics-monetary.readonly` | 72 | — |
| `youtube.account.subscriberCount` | 1 | `subscriberCount` | Subscribers | count | account | followers | latest | snapshot | organic | not_fetched | no | — | 0 | — |
| `youtube.account.viewerPercentage` | 1 | `viewerPercentage` by ageGroup_gender | Viewer age & gender | percent | account | audience | none | snapshot | organic | not_fetched | no | `yt-analytics.readonly` | 0 | — |

- **Views** (`youtube.video.views`): Video views (YouTube Analytics, startDate = publication date ⇒ lifetime). Typically 2–3 days delayed.
- **Watch time** (`youtube.video.estimatedMinutesWatched`): Minutes watched (YouTube Analytics estimate).
- **Average view duration** (`youtube.video.averageViewDuration`): Average seconds watched per view. Aggregated as Σ watch time ÷ Σ views (never an average of averages).
- **Likes** (`youtube.video.likes`): Likes.
- **Comments** (`youtube.video.comments`): Comments.
- **Shares** (`youtube.video.shares`): Shares via the YouTube share button.
- **Subscribers gained** (`youtube.video.subscribersGained`): Subscribers gained from this video.
- **Average percentage viewed** (`youtube.video.averageViewPercentage`): Average share of the video watched. Not requested by the current adapter.
- **Estimated revenue** (`youtube.video.estimatedRevenue`): Monetary data needs a separate scope and is excluded from Relay analytics.
- **Subscribers** (`youtube.account.subscriberCount`): Follower count of the account at the time of observation (snapshot). Not requested by the current adapter.
- **Viewer age & gender** (`youtube.account.viewerPercentage`): Share of logged-in viewers by age group and gender (YouTube withholds rows that do not meet its privacy threshold).

## LinkedIn

| Metric id | v | Native | Name | Unit | Scope | Family | Aggregation | Basis | Paid | Availability | Fetched | Scopes | Delay h | Retention |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `linkedin.post.impressionCount` | 1 | `impressionCount` | Impressions | count | post | impressions | sum | lifetime | organic | permission_required | yes | `rw_organization_admin` | 24 | — |
| `linkedin.post.uniqueImpressionsCount` | 1 | `uniqueImpressionsCount` | Unique impressions | count | post | reach | sum | lifetime | organic | permission_required | yes | `rw_organization_admin` | 24 | — |
| `linkedin.post.clickCount` | 1 | `clickCount` | Clicks | count | post | clicks | sum | lifetime | organic | permission_required | yes | `rw_organization_admin` | 24 | — |
| `linkedin.post.likeCount` | 1 | `likeCount` | Reactions | count | post | likes | sum | lifetime | organic | permission_required | yes | `rw_organization_admin` | 24 | — |
| `linkedin.post.commentCount` | 1 | `commentCount` | Comments | count | post | comments | sum | lifetime | organic | permission_required | yes | `rw_organization_admin` | 24 | — |
| `linkedin.post.shareCount` | 1 | `shareCount` | Reposts | count | post | shares | sum | lifetime | organic | permission_required | yes | `rw_organization_admin` | 24 | — |
| `linkedin.post.IMPRESSION` | 1 | `IMPRESSION` | Impressions (member) | count | post | impressions | sum | lifetime | organic | permission_required | yes | `r_member_postAnalytics` | 24 | — |
| `linkedin.post.MEMBERS_REACHED` | 1 | `MEMBERS_REACHED` | Members reached | count | post | reach | sum | lifetime | organic | permission_required | yes | `r_member_postAnalytics` | 24 | — |
| `linkedin.post.REACTION` | 1 | `REACTION` | Reactions (member) | count | post | likes | sum | lifetime | organic | permission_required | yes | `r_member_postAnalytics` | 24 | — |
| `linkedin.post.COMMENT` | 1 | `COMMENT` | Comments (member) | count | post | comments | sum | lifetime | organic | permission_required | yes | `r_member_postAnalytics` | 24 | — |
| `linkedin.post.RESHARE` | 1 | `RESHARE` | Reposts (member) | count | post | shares | sum | lifetime | organic | permission_required | yes | `r_member_postAnalytics` | 24 | — |
| `linkedin.account.followerCount` | 1 | `followerCount` | Followers | count | account | followers | latest | snapshot | organic | not_fetched | no | — | 0 | — |
| `linkedin.account.followerCountsByGeoCountry` | 1 | `followerCountsByGeoCountry` by country | Follower countries | count | account | audience | none | snapshot | organic | not_fetched | no | `rw_organization_admin` | 0 | — |

- **Impressions** (`linkedin.post.impressionCount`): Organic impressions of an organization post (organic share statistics; documented: missing ⇒ 0).
- **Unique impressions** (`linkedin.post.uniqueImpressionsCount`): Unique members who saw the organization post. A unique count.
- **Clicks** (`linkedin.post.clickCount`): Clicks on the organization post.
- **Reactions** (`linkedin.post.likeCount`): Reactions (likes) on the organization post.
- **Comments** (`linkedin.post.commentCount`): Comments.
- **Reposts** (`linkedin.post.shareCount`): Reposts.
- **Impressions (member)** (`linkedin.post.IMPRESSION`): Impressions of a member post (memberCreatorPostAnalytics, TOTAL).
- **Members reached** (`linkedin.post.MEMBERS_REACHED`): Unique members reached by a member post. A unique count.
- **Reactions (member)** (`linkedin.post.REACTION`): Reactions on a member post.
- **Comments (member)** (`linkedin.post.COMMENT`): Comments on a member post.
- **Reposts (member)** (`linkedin.post.RESHARE`): Reposts of a member post.
- **Followers** (`linkedin.account.followerCount`): Follower count of the account at the time of observation (snapshot). Not requested by the current adapter.
- **Follower countries** (`linkedin.account.followerCountsByGeoCountry`): Organization followers by country (organizationalEntityFollowerStatistics).

## Threads

| Metric id | v | Native | Name | Unit | Scope | Family | Aggregation | Basis | Paid | Availability | Fetched | Scopes | Delay h | Retention |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `threads.post.views` | 1 | `views` | Views | count | post | views | sum | lifetime | organic | in_development | yes | `threads_basic` `threads_manage_insights` | 24 | — |
| `threads.post.likes` | 1 | `likes` | Likes | count | post | likes | sum | lifetime | organic | available | yes | `threads_basic` `threads_manage_insights` | 24 | — |
| `threads.post.replies` | 1 | `replies` | Replies | count | post | comments | sum | lifetime | organic | available | yes | `threads_basic` `threads_manage_insights` | 24 | — |
| `threads.post.reposts` | 1 | `reposts` | Reposts | count | post | shares | sum | lifetime | organic | available | yes | `threads_basic` `threads_manage_insights` | 24 | — |
| `threads.post.quotes` | 1 | `quotes` | Quotes | count | post | quotes | sum | lifetime | organic | available | yes | `threads_basic` `threads_manage_insights` | 24 | — |
| `threads.post.shares` | 1 | `shares` | Shares | count | post | shares | sum | lifetime | organic | in_development | yes | `threads_basic` `threads_manage_insights` | 24 | — |
| `threads.account.followers_count` | 1 | `followers_count` | Followers | count | account | followers | latest | snapshot | organic | not_fetched | no | — | 0 | — |

- **Views** (`threads.post.views`): Views of the Threads post (marked "in development" by Meta).
- **Likes** (`threads.post.likes`): Likes.
- **Replies** (`threads.post.replies`): Replies.
- **Reposts** (`threads.post.reposts`): Reposts.
- **Quotes** (`threads.post.quotes`): Quote posts.
- **Shares** (`threads.post.shares`): Shares/sends (marked "in development" by Meta).
- **Followers** (`threads.account.followers_count`): Follower count of the account at the time of observation (snapshot). Not requested by the current adapter.

## Pinterest

| Metric id | v | Native | Name | Unit | Scope | Family | Aggregation | Basis | Paid | Availability | Fetched | Scopes | Delay h | Retention |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `pinterest.post.IMPRESSION` | 1 | `IMPRESSION` | Impressions | count | post | impressions | sum | window | organic | available | yes | `boards:read` `pins:read` | 48 | 90 d |
| `pinterest.post.SAVE` | 1 | `SAVE` | Saves | count | post | saves | sum | window | organic | available | yes | `boards:read` `pins:read` | 48 | 90 d |
| `pinterest.post.PIN_CLICK` | 1 | `PIN_CLICK` | Pin clicks | count | post | clicks | sum | window | organic | available | yes | `boards:read` `pins:read` | 48 | 90 d |
| `pinterest.post.OUTBOUND_CLICK` | 1 | `OUTBOUND_CLICK` | Outbound clicks | count | post | link_clicks | sum | window | organic | available | yes | `boards:read` `pins:read` | 48 | 90 d |
| `pinterest.post.TOTAL_COMMENTS` | 1 | `TOTAL_COMMENTS` | Comments | count | post | comments | sum | window | organic | available | yes | `boards:read` `pins:read` | 48 | 90 d |
| `pinterest.post.TOTAL_REACTIONS` | 1 | `TOTAL_REACTIONS` | Reactions | count | post | likes | sum | window | organic | available | yes | `boards:read` `pins:read` | 48 | 90 d |
| `pinterest.account.follower_count` | 1 | `follower_count` | Followers | count | account | followers | latest | snapshot | organic | not_fetched | no | — | 0 | — |

- **Impressions** (`pinterest.post.IMPRESSION`): Pin impressions over the reported window (≤ 90 days back).
- **Saves** (`pinterest.post.SAVE`): Saves of the Pin over the window.
- **Pin clicks** (`pinterest.post.PIN_CLICK`): Clicks on the Pin (closeup) over the window.
- **Outbound clicks** (`pinterest.post.OUTBOUND_CLICK`): Clicks to the destination URL over the window.
- **Comments** (`pinterest.post.TOTAL_COMMENTS`): Comments over the window.
- **Reactions** (`pinterest.post.TOTAL_REACTIONS`): Reactions over the window.
- **Followers** (`pinterest.account.follower_count`): Follower count of the account at the time of observation (snapshot). Not requested by the current adapter.

## Bluesky

| Metric id | v | Native | Name | Unit | Scope | Family | Aggregation | Basis | Paid | Availability | Fetched | Scopes | Delay h | Retention |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `bluesky.post.likeCount` | 1 | `likeCount` | Likes | count | post | likes | sum | lifetime | organic | available | yes | — | 0 | — |
| `bluesky.post.repostCount` | 1 | `repostCount` | Reposts | count | post | shares | sum | lifetime | organic | available | yes | — | 0 | — |
| `bluesky.post.replyCount` | 1 | `replyCount` | Replies | count | post | comments | sum | lifetime | organic | available | yes | — | 0 | — |
| `bluesky.post.quoteCount` | 1 | `quoteCount` | Quotes | count | post | quotes | sum | lifetime | organic | available | yes | — | 0 | — |
| `bluesky.post.bookmarkCount` | 1 | `bookmarkCount` | Bookmarks | count | post | saves | sum | lifetime | organic | available | yes | — | 0 | — |
| `bluesky.account.followersCount` | 1 | `followersCount` | Followers | count | account | followers | latest | snapshot | organic | not_fetched | no | — | 0 | — |

- **Likes** (`bluesky.post.likeCount`): Likes (public AppView count).
- **Reposts** (`bluesky.post.repostCount`): Reposts.
- **Replies** (`bluesky.post.replyCount`): Replies.
- **Quotes** (`bluesky.post.quoteCount`): Quote posts.
- **Bookmarks** (`bluesky.post.bookmarkCount`): Bookmarks.
- **Followers** (`bluesky.account.followersCount`): Follower count of the account at the time of observation (snapshot). Not requested by the current adapter.

## Query and aggregation examples (synthetic numbers, computed by the production functions)

### 1. Engagement rate is a ratio of sums

Posts: A = 10 engagements / 100 views, B = 90 / 300, C (Bluesky) = 50 engagements and no views.

Result: **25.0%** = 100 ÷ 400 over 2 posts (C excluded: no compatible denominator). The average of per-post rates (20%) is never used.

### 2. Cross-network totals only within a family, always labelled

Instagram views 1,200 + TikTok video views 5,400 ⇒ **6,600** labelled “Views — sum of network-reported values (instagram:views, tiktok:view_count); definitions differ by network”.

Instagram views + X impressions ⇒ refused: “Cannot add Views + Impressions: different measures.”

Instagram reach + Facebook viewers ⇒ refused: “Reach (unique accounts) cannot be combined across networks (instagram, facebook).”

### 3. Average view duration (YouTube)

Video 1: 50 min / 100 views; video 2: 50 min / 300 views ⇒ **15 s** (Σ 6,000 s ÷ Σ 400 views), not the mean of 30 s and 10 s.

### 4. Comparisons

Current 42 vs previous 0 ⇒ state **new** (no percentage). Current 120 vs previous 100 ⇒ **up 20%**. Missing/insufficient previous coverage (< 50 % of eligible posts with data) ⇒ **insufficient**.

### 5. Day boundaries

`from=2026-10-25&to=2026-10-25&tz=Europe/London` ⇒ 2026-10-24T23:00:00.000Z … 2026-10-26T00:00:00.000Z (a 25-hour day). Posts are bucketed by their publish instant in the selected timezone; cached rollups use 15-minute buckets, exact for every real UTC offset.

### 6. Lifetime counters vs daily activity

A post observed with 100 impressions on 2 Sep and 160 on 3 Sep is stored as two **as-of snapshots** (`metric_cumulative_facts`). The post’s value is **160** (latest), labelled “Lifetime performance of posts published in this period”. The difference (+60) is stored separately as an **observed change** (`metric_daily_facts.fact_kind = observed_change`) — it may include corrections and is not an event-time count. A single snapshot never produces a history.

### 7. API examples

```http
GET /api/analytics/overview?brand=<uuid>&from=2026-10-01&to=2026-10-28&tz=Europe/London&measure=engagements
GET /api/analytics/content?network=instagram,tiktok&from=2026-10-01&to=2026-10-28&sort=engagement_rate&dir=desc&page=1&page_size=25
GET /api/analytics/content/<delivery-id>?tz=Europe/London
GET /api/analytics/channels?account=<uuid>,<uuid>&from=2026-10-01&to=2026-10-28&measure=views
GET /api/analytics/video | /audience | /workflow | /best-time ?{same filters}
GET /api/analytics/metrics                       # this dictionary as JSON
POST /api/analytics/reports {"name":"Weekly","view":"overview","query_string":"brand=<uuid>&from=…&to=…&tz=Europe/London","visibility":"workspace"}
POST /api/analytics/exports {"view":"content","format":"csv","query_string":"…"}   → poll GET /api/analytics/exports/<id> → GET …/download
```

Filter keys: `brand`, `account`, `network`, `campaign`, `team`, `format` (comma-separated), `from`, `to` (YYYY-MM-DD, inclusive local dates), `tz`, `compare` (`previous_period`|`none`), `dataset` (`live`|`simulated`|`demo`). Responses: `packages/core/src/contracts/analytics.ts`.

## Pipeline and storage

1. **Sync** (worker queue `analytics-sync`, `services/analytics/sync.ts`): one cursor per account (`sync_cursors`), keyset checkpoint after every post, bounded backfill (≤ 90 days; Pinterest 89; X 30), cadence by post age (6 h → 24 h → weekly → final at the horizon; X billable reads are rarer and budget-metered), exponential back-off, per-workspace concurrency, yields while publishing work is due. Authority re-checked when the job runs and before every item: disconnected / reconnect-required accounts, archived brands and suspended workspaces stop the cursor. Every run is a `sync_runs` row with an idempotent job key.
2. **Raw observations** (`metric_observations`): validated (registry-mapped, finite, non-negative) and deduplicated on the fact key (workspace, account, resource, metric, period, dimension, definition version). A re-read with the same value changes nothing; a different value bumps `revision` and keeps `previous_value` (late correction); an older observation never overwrites a newer one.
3. **Facts**: `metric_cumulative_facts` (lifetime / snapshot / window values as of a UTC date) are separate from `metric_daily_facts` (provider-reported day buckets, and labelled `observed_change` deltas).
4. **Cached aggregates**: `metric_resource_latest` (latest value per post and metric) and `metric_rollups` (15-minute publish buckets, recomputed per touched bucket; derived per-post pairings for engagements and ratio measures). Filters the rollups cannot answer (campaign/team/format) use the identical per-post computation.
5. **Coverage** (`data_coverage`): fetch outcome per post and metric (ok / unsupported / permission missing / delayed / failed / not found / …) — the source of the series states below.
6. **Report API** (`services/analytics/query.ts`, `/api/analytics/**`): authorized per brand with `analytics.read` (exports also `exports.create`), dataset-isolated (`live` = network data of real accounts; `simulated` = mock destinations; `demo` = synthetic fixtures in demo workspaces only).

Legacy V1.1 `metric_snapshots` / `metric_fetch_state` are backfilled idempotently by the worker (`services/analytics/backfill.ts`); unsupported or permission-missing states become coverage rows, never zero values. Retention: raw observations 400 days; facts of an account whose access ended are kept 90 days after disconnection, then purged; facts of posts deleted in Relay are removed; posts deleted on the network keep their last values and stop refreshing.

## Series states

| State | Meaning |
|---|---|
| `ok` | Observed values for every eligible item. |
| `zero` | Observed, and the value is 0. |
| `unsupported` | The network does not provide this metric (for this content type). |
| `permission_missing` | The connection lacks the scope/role (or access was revoked / reconnect needed). |
| `not_fetched` | Never attempted yet, or the adapter does not request it. |
| `stale` | The account has not synced successfully for 48 h while posts are still in their refresh window. |
| `provider_delayed` | The network reports with a delay; recent items have no data yet. |
| `partial_coverage` | Only some eligible items have data (coverage shows how many). |
| `fetch_failed` | The last attempts failed (errors, rate limits, budget). |

Missing values are `null` in the API and blank in exports — never 0 — and charts must not connect them.
