// Metric registry (V3 spec §9) — the CANONICAL definition of every provider-native metric Relay stores.
// Synced to metric_definitions by syncMetricRegistry() (immutable per id+version; content_hash guards redefinition).
// docs/V3_ANALYTICS_DICTIONARY.md is generated from this file (scripts/analytics-dictionary.ts).
//
// Fields: provider metric id (native), human name, unit, scope (account/post/video), aggregation rule, time basis
// (lifetime cumulative vs daily bucket vs snapshot vs rolling window), organic/paid, availability, required
// scopes, retention, provider delay, definition version, and a semantic FAMILY that decides what may be combined.
// Sources for every post metric: packages/providers/src/<provider>/metrics.ts (verified 2026-11-07).
import { createHash } from 'node:crypto';
import type { Provider } from '@social-lite/core';
import type { MeasureKey } from '@social-lite/core/contracts/analytics';
import { withTx, type Queryable } from '@social-lite/db';
import { metricsFetcherFor } from '@social-lite/providers/metrics';

export type MetricUnit = 'count' | 'minutes' | 'seconds' | 'percent';
export type MetricScope = 'account' | 'post' | 'video';
export type Aggregation = 'sum' | 'latest' | 'ratio_of_sums' | 'none';
export type TimeBasis = 'lifetime' | 'window' | 'daily' | 'snapshot';
export type PaidClass = 'organic' | 'mixed' | 'paid';
export type Availability = 'available' | 'permission_required' | 'in_development' | 'not_fetched' | 'excluded' | 'deprecated';

export type MetricFamily =
  | 'views' | 'impressions' | 'reach' | 'likes' | 'comments' | 'shares' | 'quotes' | 'saves' | 'clicks' | 'link_clicks'
  | 'interactions_total' | 'watch_time' | 'avg_view_duration' | 'followers_gained' | 'followers' | 'audience' | 'retention' | 'revenue';

/** Cross-network combination rule per family (spec §9: never sum unique reach; never mix families into one total). */
export const FAMILIES: Record<MetricFamily, { label: string; crossNetwork: 'sum_labelled' | 'never'; unique: boolean; engagement: boolean; exposure: boolean }> = {
  views: { label: 'Views', crossNetwork: 'sum_labelled', unique: false, engagement: false, exposure: true },
  impressions: { label: 'Impressions', crossNetwork: 'sum_labelled', unique: false, engagement: false, exposure: true },
  reach: { label: 'Reach (unique accounts)', crossNetwork: 'never', unique: true, engagement: false, exposure: true },
  likes: { label: 'Likes & reactions', crossNetwork: 'sum_labelled', unique: false, engagement: true, exposure: false },
  comments: { label: 'Comments & replies', crossNetwork: 'sum_labelled', unique: false, engagement: true, exposure: false },
  shares: { label: 'Shares & reposts', crossNetwork: 'sum_labelled', unique: false, engagement: true, exposure: false },
  quotes: { label: 'Quotes', crossNetwork: 'sum_labelled', unique: false, engagement: true, exposure: false },
  saves: { label: 'Saves & bookmarks', crossNetwork: 'sum_labelled', unique: false, engagement: true, exposure: false },
  clicks: { label: 'Clicks', crossNetwork: 'sum_labelled', unique: false, engagement: false, exposure: false },
  link_clicks: { label: 'Outbound link clicks', crossNetwork: 'sum_labelled', unique: false, engagement: false, exposure: false },
  interactions_total: { label: 'Network total interactions', crossNetwork: 'never', unique: false, engagement: false, exposure: false },
  watch_time: { label: 'Watch time', crossNetwork: 'sum_labelled', unique: false, engagement: false, exposure: false },
  avg_view_duration: { label: 'Average view duration', crossNetwork: 'never', unique: false, engagement: false, exposure: false },
  followers_gained: { label: 'Followers gained', crossNetwork: 'sum_labelled', unique: false, engagement: false, exposure: false },
  followers: { label: 'Followers', crossNetwork: 'sum_labelled', unique: false, engagement: false, exposure: false },
  audience: { label: 'Audience breakdown', crossNetwork: 'never', unique: true, engagement: false, exposure: false },
  retention: { label: 'Audience retention', crossNetwork: 'never', unique: false, engagement: false, exposure: false },
  revenue: { label: 'Revenue', crossNetwork: 'never', unique: false, engagement: false, exposure: false },
};

/** Families summed into "Engagements" (clicks, views and network composites are NOT engagements here). */
export const ENGAGEMENT_FAMILIES: readonly MetricFamily[] = (Object.keys(FAMILIES) as MetricFamily[]).filter((f) => FAMILIES[f].engagement);

export interface MetricDefinition {
  id: string;
  version: number;
  provider: Provider;
  nativeMetric: string;
  /** Other native names that mean the same thing (e.g. X retweet_count → repost_count). */
  aliases?: readonly string[];
  /** Breakdown key for object-valued metrics (e.g. reaction_type). */
  dimensionKey: string | null;
  name: string;
  description: string;
  unit: MetricUnit;
  scope: MetricScope;
  family: MetricFamily;
  aggregation: Aggregation;
  /** ratio_of_sums: value = Σ numerator × multiplier / Σ denominator (metric ids of the same provider). */
  ratio?: { numerator: string; denominator: string; multiplier: number };
  timeBasis: TimeBasis;
  paid: PaidClass;
  availability: Availability;
  /** Requested by the current adapter (packages/providers/src/<p>/metrics.ts). */
  fetched: boolean;
  requiredScopes: readonly string[];
  /** Provider-side lookback/retention for this metric (days), null = no documented limit. */
  retentionDays: number | null;
  /** Typical reporting delay; data is complete through observed_at − delay. */
  providerDelayHours: number;
  /** Data older than this (for posts still in their refresh horizon) is "stale". */
  freshnessHours: number;
  /** Audience: minimum audience size the provider requires before reporting a breakdown. */
  minThreshold?: number | null;
  notes?: string;
}

type Def = Omit<MetricDefinition, 'id' | 'version' | 'provider' | 'scope' | 'aggregation' | 'paid' | 'availability' | 'fetched' | 'requiredScopes' | 'retentionDays' | 'providerDelayHours' | 'freshnessHours' | 'dimensionKey' | 'unit' | 'timeBasis'>
  & Partial<Pick<MetricDefinition, 'version' | 'aggregation' | 'paid' | 'availability' | 'fetched' | 'requiredScopes' | 'retentionDays' | 'providerDelayHours' | 'freshnessHours' | 'dimensionKey' | 'unit' | 'scope' | 'timeBasis'>>;

function provider(p: Provider, base: Partial<MetricDefinition> & { scope: MetricScope }, defs: Def[]): MetricDefinition[] {
  return defs.map((d) => {
    const scope = d.scope ?? base.scope;
    const out: MetricDefinition = {
      version: 1, aggregation: 'sum', paid: 'organic', availability: 'available', fetched: true, requiredScopes: [], retentionDays: null,
      providerDelayHours: 0, freshnessHours: 48, dimensionKey: null, unit: 'count',
      ...base, ...d, scope, provider: p,
      id: `${p}.${scope}.${d.nativeMetric}`,
    } as MetricDefinition;
    return out;
  });
}

const META_POST_NOTE = 'Meta reports post insights as lifetime totals; the value grows after publication and is observed, not event-timed.';

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  // ---------------------------------------------------------------- Facebook Page posts
  ...provider('facebook', { scope: 'post', timeBasis: 'lifetime', requiredScopes: ['read_insights', 'pages_read_engagement'], paid: 'mixed', providerDelayHours: 24 }, [
    { nativeMetric: 'post_media_view', name: 'Views', family: 'views', description: 'Number of times the post was on screen (Meta "Media views"). Includes paid distribution if the post was boosted.', notes: META_POST_NOTE },
    { nativeMetric: 'post_total_media_view_unique', name: 'Viewers', family: 'reach', description: 'Unique accounts that saw the post at least once (Meta "Viewers"). A unique count: not additive across posts or networks.' },
    { nativeMetric: 'post_clicks', name: 'Clicks', family: 'clicks', description: 'Clicks anywhere in the post.', paid: 'mixed' },
    { nativeMetric: 'post_reactions_by_type_total', name: 'Reactions', family: 'likes', dimensionKey: 'reaction_type', description: 'Reactions by type (like, love, wow, haha, sorry, anger). Summed over types for totals.' },
  ]),
  // ---------------------------------------------------------------- Instagram media
  ...provider('instagram', { scope: 'post', timeBasis: 'lifetime', requiredScopes: ['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'], paid: 'organic', providerDelayHours: 24 }, [
    { nativeMetric: 'views', name: 'Views', family: 'views', description: 'Times the media was played or displayed (replaces impressions/plays for media after 2024-07-02).' },
    { nativeMetric: 'reach', name: 'Reach', family: 'reach', description: 'Unique accounts that saw the media. A unique count: not additive across posts or networks.' },
    { nativeMetric: 'likes', name: 'Likes', family: 'likes', description: 'Likes on the media.' },
    { nativeMetric: 'comments', name: 'Comments', family: 'comments', description: 'Comments on the media.' },
    { nativeMetric: 'saved', name: 'Saves', family: 'saves', description: 'Unique saves of the media.' },
    { nativeMetric: 'shares', name: 'Shares', family: 'shares', description: 'Shares of the media.' },
    { nativeMetric: 'total_interactions', name: 'Total interactions (Instagram)', family: 'interactions_total', aggregation: 'sum', description: 'Instagram composite of likes, saves, comments and shares (minus unlikes/unsaves/deleted comments). Not added to Relay engagements (would double count).' },
  ]),
  // ---------------------------------------------------------------- X public metrics (billable reads)
  ...provider('x', { scope: 'post', timeBasis: 'lifetime', requiredScopes: ['tweet.read', 'users.read'], paid: 'mixed', providerDelayHours: 0, freshnessHours: 72 }, [
    { nativeMetric: 'impression_count', name: 'Impressions', family: 'impressions', description: 'Times the post was seen (X public metrics). Includes promoted delivery if the post was promoted.' },
    { nativeMetric: 'like_count', name: 'Likes', family: 'likes', description: 'Likes.' },
    { nativeMetric: 'repost_count', aliases: ['retweet_count'], name: 'Reposts', family: 'shares', description: 'Reposts (formerly retweets).' },
    { nativeMetric: 'reply_count', name: 'Replies', family: 'comments', description: 'Replies.' },
    { nativeMetric: 'quote_count', name: 'Quotes', family: 'quotes', description: 'Quote posts.' },
    { nativeMetric: 'bookmark_count', name: 'Bookmarks', family: 'saves', description: 'Bookmarks.' },
  ]),
  // ---------------------------------------------------------------- TikTok (public videos only)
  ...provider('tiktok', { scope: 'video', timeBasis: 'lifetime', requiredScopes: ['video.list'], providerDelayHours: 24 }, [
    { nativeMetric: 'view_count', name: 'Video views', family: 'views', description: 'Views of a public video (TikTok Display API). Private/draft posts report nothing (unsupported, never 0).' },
    { nativeMetric: 'like_count', name: 'Likes', family: 'likes', description: 'Likes.' },
    { nativeMetric: 'comment_count', name: 'Comments', family: 'comments', description: 'Comments.' },
    { nativeMetric: 'share_count', name: 'Shares', family: 'shares', description: 'Shares.' },
  ]),
  // ---------------------------------------------------------------- YouTube Analytics (window from publication = lifetime)
  ...provider('youtube', { scope: 'video', timeBasis: 'lifetime', requiredScopes: ['yt-analytics.readonly', 'youtube.readonly'], providerDelayHours: 72, freshnessHours: 96 }, [
    { nativeMetric: 'views', name: 'Views', family: 'views', description: 'Video views (YouTube Analytics, startDate = publication date ⇒ lifetime). Typically 2–3 days delayed.' },
    { nativeMetric: 'estimatedMinutesWatched', name: 'Watch time', family: 'watch_time', unit: 'minutes', description: 'Minutes watched (YouTube Analytics estimate).' },
    { nativeMetric: 'averageViewDuration', name: 'Average view duration', family: 'avg_view_duration', unit: 'seconds', aggregation: 'ratio_of_sums',
      ratio: { numerator: 'youtube.video.estimatedMinutesWatched', denominator: 'youtube.video.views', multiplier: 60 },
      description: 'Average seconds watched per view. Aggregated as Σ watch time ÷ Σ views (never an average of averages).' },
    { nativeMetric: 'likes', name: 'Likes', family: 'likes', description: 'Likes.' },
    { nativeMetric: 'comments', name: 'Comments', family: 'comments', description: 'Comments.' },
    { nativeMetric: 'shares', name: 'Shares', family: 'shares', description: 'Shares via the YouTube share button.' },
    { nativeMetric: 'subscribersGained', name: 'Subscribers gained', family: 'followers_gained', description: 'Subscribers gained from this video.' },
    { nativeMetric: 'averageViewPercentage', name: 'Average percentage viewed', family: 'retention', unit: 'percent', aggregation: 'none', fetched: false, availability: 'not_fetched',
      description: 'Average share of the video watched. Not requested by the current adapter.' },
    { nativeMetric: 'estimatedRevenue', name: 'Estimated revenue', family: 'revenue', unit: 'count', aggregation: 'none', fetched: false, availability: 'excluded', paid: 'paid',
      requiredScopes: ['yt-analytics-monetary.readonly'], description: 'Monetary data needs a separate scope and is excluded from Relay analytics.' },
  ]),
  // ---------------------------------------------------------------- LinkedIn (organization share statistics)
  ...provider('linkedin', { scope: 'post', timeBasis: 'lifetime', requiredScopes: ['rw_organization_admin'], paid: 'organic', providerDelayHours: 24, availability: 'permission_required' }, [
    { nativeMetric: 'impressionCount', name: 'Impressions', family: 'impressions', description: 'Organic impressions of an organization post (organic share statistics; documented: missing ⇒ 0).' },
    { nativeMetric: 'uniqueImpressionsCount', name: 'Unique impressions', family: 'reach', description: 'Unique members who saw the organization post. A unique count.' },
    { nativeMetric: 'clickCount', name: 'Clicks', family: 'clicks', description: 'Clicks on the organization post.' },
    { nativeMetric: 'likeCount', name: 'Reactions', family: 'likes', description: 'Reactions (likes) on the organization post.' },
    { nativeMetric: 'commentCount', name: 'Comments', family: 'comments', description: 'Comments.' },
    { nativeMetric: 'shareCount', name: 'Reposts', family: 'shares', description: 'Reposts.' },
  ]),
  // ---------------------------------------------------------------- LinkedIn (member creator post analytics)
  ...provider('linkedin', { scope: 'post', timeBasis: 'lifetime', requiredScopes: ['r_member_postAnalytics'], paid: 'organic', providerDelayHours: 24, availability: 'permission_required' }, [
    { nativeMetric: 'IMPRESSION', name: 'Impressions (member)', family: 'impressions', description: 'Impressions of a member post (memberCreatorPostAnalytics, TOTAL).' },
    { nativeMetric: 'MEMBERS_REACHED', name: 'Members reached', family: 'reach', description: 'Unique members reached by a member post. A unique count.' },
    { nativeMetric: 'REACTION', name: 'Reactions (member)', family: 'likes', description: 'Reactions on a member post.' },
    { nativeMetric: 'COMMENT', name: 'Comments (member)', family: 'comments', description: 'Comments on a member post.' },
    { nativeMetric: 'RESHARE', name: 'Reposts (member)', family: 'shares', description: 'Reposts of a member post.' },
  ]),
  // ---------------------------------------------------------------- Threads
  ...provider('threads', { scope: 'post', timeBasis: 'lifetime', requiredScopes: ['threads_basic', 'threads_manage_insights'], providerDelayHours: 24 }, [
    { nativeMetric: 'views', name: 'Views', family: 'views', availability: 'in_development', description: 'Views of the Threads post (marked "in development" by Meta).' },
    { nativeMetric: 'likes', name: 'Likes', family: 'likes', description: 'Likes.' },
    { nativeMetric: 'replies', name: 'Replies', family: 'comments', description: 'Replies.' },
    { nativeMetric: 'reposts', name: 'Reposts', family: 'shares', description: 'Reposts.' },
    { nativeMetric: 'quotes', name: 'Quotes', family: 'quotes', description: 'Quote posts.' },
    { nativeMetric: 'shares', name: 'Shares', family: 'shares', availability: 'in_development', description: 'Shares/sends (marked "in development" by Meta).' },
  ]),
  // ---------------------------------------------------------------- Pinterest (≤ 90-day window ⇒ lifetime only while the Pin is < 90 days old)
  ...provider('pinterest', { scope: 'post', timeBasis: 'window', requiredScopes: ['boards:read', 'pins:read'], retentionDays: 90, providerDelayHours: 48 }, [
    { nativeMetric: 'IMPRESSION', name: 'Impressions', family: 'impressions', description: 'Pin impressions over the reported window (≤ 90 days back).' },
    { nativeMetric: 'SAVE', name: 'Saves', family: 'saves', description: 'Saves of the Pin over the window.' },
    { nativeMetric: 'PIN_CLICK', name: 'Pin clicks', family: 'clicks', description: 'Clicks on the Pin (closeup) over the window.' },
    { nativeMetric: 'OUTBOUND_CLICK', name: 'Outbound clicks', family: 'link_clicks', description: 'Clicks to the destination URL over the window.' },
    { nativeMetric: 'TOTAL_COMMENTS', name: 'Comments', family: 'comments', description: 'Comments over the window.' },
    { nativeMetric: 'TOTAL_REACTIONS', name: 'Reactions', family: 'likes', description: 'Reactions over the window.' },
  ]),
  // ---------------------------------------------------------------- Bluesky (public AppView counts; no views/impressions exist)
  ...provider('bluesky', { scope: 'post', timeBasis: 'lifetime', requiredScopes: [], providerDelayHours: 0, freshnessHours: 48 }, [
    { nativeMetric: 'likeCount', name: 'Likes', family: 'likes', description: 'Likes (public AppView count).' },
    { nativeMetric: 'repostCount', name: 'Reposts', family: 'shares', description: 'Reposts.' },
    { nativeMetric: 'replyCount', name: 'Replies', family: 'comments', description: 'Replies.' },
    { nativeMetric: 'quoteCount', name: 'Quotes', family: 'quotes', description: 'Quote posts.' },
    { nativeMetric: 'bookmarkCount', name: 'Bookmarks', family: 'saves', description: 'Bookmarks.' },
  ]),
  // ---------------------------------------------------------------- Account snapshots (not requested by current adapters)
  // Point-in-time gauges: aggregated as LATEST per account, never summed over dates. Shown as "not fetched" for live
  // connections until an account fetcher exists; demo fixtures populate them (synthetic, labelled).
  ...(['instagram', 'facebook', 'x', 'tiktok', 'youtube', 'linkedin', 'threads', 'pinterest', 'bluesky'] as const).flatMap((p) => provider(p,
    { scope: 'account', timeBasis: 'snapshot', aggregation: 'latest', fetched: false, availability: 'not_fetched', freshnessHours: 48 }, [
      { nativeMetric: ({ instagram: 'followers_count', facebook: 'page_follows', x: 'followers_count', tiktok: 'follower_count', youtube: 'subscriberCount',
        linkedin: 'followerCount', threads: 'followers_count', pinterest: 'follower_count', bluesky: 'followersCount' } as const)[p],
      name: p === 'youtube' ? 'Subscribers' : 'Followers', family: 'followers',
      description: 'Follower count of the account at the time of observation (snapshot). Not requested by the current adapter.' },
    ])),
  // ---------------------------------------------------------------- Audience aggregates (provider-supported, thresholded; not fetched yet)
  ...provider('instagram', { scope: 'account', timeBasis: 'snapshot', aggregation: 'none', fetched: false, availability: 'not_fetched', requiredScopes: ['instagram_manage_insights'] }, [
    { nativeMetric: 'follower_demographics', name: 'Follower countries', family: 'audience', dimensionKey: 'country', minThreshold: 100,
      description: 'Follower distribution by country (Instagram reports demographics only for accounts with ≥ 100 followers).' },
  ]),
  ...provider('youtube', { scope: 'account', timeBasis: 'snapshot', aggregation: 'none', fetched: false, availability: 'not_fetched', requiredScopes: ['yt-analytics.readonly'] }, [
    { nativeMetric: 'viewerPercentage', name: 'Viewer age & gender', family: 'audience', dimensionKey: 'ageGroup_gender', unit: 'percent', minThreshold: null,
      description: 'Share of logged-in viewers by age group and gender (YouTube withholds rows that do not meet its privacy threshold).' },
  ]),
  ...provider('linkedin', { scope: 'account', timeBasis: 'snapshot', aggregation: 'none', fetched: false, availability: 'not_fetched', requiredScopes: ['rw_organization_admin'] }, [
    { nativeMetric: 'followerCountsByGeoCountry', name: 'Follower countries', family: 'audience', dimensionKey: 'country', minThreshold: null,
      description: 'Organization followers by country (organizationalEntityFollowerStatistics).' },
  ]),
];

export const REGISTRY_VERSION_NOTE = 'Definitions are immutable per (metric_id, version). Changing a definition adds a new version; facts keep the version they were observed under.';

// ------------------------------------------------------------------ lookups
const BY_ID = new Map(METRIC_DEFINITIONS.map((d) => [`${d.id}@${d.version}`, d]));
const LATEST = new Map<string, MetricDefinition>();
for (const d of METRIC_DEFINITIONS) { const cur = LATEST.get(d.id); if (!cur || cur.version < d.version) LATEST.set(d.id, d); }

export function definition(id: string, version?: number): MetricDefinition | undefined {
  return version === undefined ? LATEST.get(id) : BY_ID.get(`${id}@${version}`);
}

export function definitionsFor(p: Provider): MetricDefinition[] {
  return [...LATEST.values()].filter((d) => d.provider === p);
}

/** Map a provider-native point name to its (current) definition. Account scope only when asked. */
export function resolveNative(p: Provider, nativeName: string, scope: 'resource-post' | 'account' = 'resource-post'): MetricDefinition | undefined {
  return [...LATEST.values()].find((d) => d.provider === p && (scope === 'account' ? d.scope === 'account' : d.scope !== 'account')
    && (d.nativeMetric === nativeName || d.aliases?.includes(nativeName)));
}

/** Post/video metrics the current adapter fetches for a provider. */
export function fetchedPostDefinitions(p: Provider): MetricDefinition[] {
  return definitionsFor(p).filter((d) => d.scope !== 'account' && d.fetched);
}

export function familyOf(id: string): MetricFamily | undefined {
  return definition(id)?.family;
}

/** Providers whose fetched post metrics include a family (eligibility for coverage). */
export function providersWithFamily(family: MetricFamily): Provider[] {
  return [...new Set(METRIC_DEFINITIONS.filter((d) => d.family === family && d.fetched && d.scope !== 'account' && d.availability !== 'excluded').map((d) => d.provider))];
}

export const PROVIDER_TIMEZONE: Partial<Record<Provider, string>> = {
  // Provider-defined day buckets (only used for 'reported' daily facts).
  facebook: 'America/Los_Angeles', instagram: 'America/Los_Angeles', threads: 'America/Los_Angeles', youtube: 'America/Los_Angeles',
};

// ------------------------------------------------------------------ measures (what the UI can select)
export const MEASURES: Record<MeasureKey, { label: string; unit: 'count' | 'percent' | 'minutes' | 'seconds'; families: MetricFamily[]; kind: 'family' | 'engagements' | 'rate' | 'app' | 'ratio' | 'snapshot'; denominator?: 'views' | 'impressions' }> = {
  posts_published: { label: 'Posts published', unit: 'count', families: [], kind: 'app' },
  engagements: { label: 'Engagements', unit: 'count', families: [...ENGAGEMENT_FAMILIES], kind: 'engagements' },
  engagement_rate_views: { label: 'Engagement rate (by views)', unit: 'percent', families: [...ENGAGEMENT_FAMILIES, 'views'], kind: 'rate', denominator: 'views' },
  engagement_rate_impressions: { label: 'Engagement rate (by impressions)', unit: 'percent', families: [...ENGAGEMENT_FAMILIES, 'impressions'], kind: 'rate', denominator: 'impressions' },
  views: { label: 'Views', unit: 'count', families: ['views'], kind: 'family' },
  impressions: { label: 'Impressions', unit: 'count', families: ['impressions'], kind: 'family' },
  reach: { label: 'Reach (sum of per-post unique counts)', unit: 'count', families: ['reach'], kind: 'family' },
  likes: { label: 'Likes & reactions', unit: 'count', families: ['likes'], kind: 'family' },
  comments: { label: 'Comments & replies', unit: 'count', families: ['comments'], kind: 'family' },
  shares: { label: 'Shares & reposts', unit: 'count', families: ['shares'], kind: 'family' },
  quotes: { label: 'Quotes', unit: 'count', families: ['quotes'], kind: 'family' },
  saves: { label: 'Saves & bookmarks', unit: 'count', families: ['saves'], kind: 'family' },
  clicks: { label: 'Clicks', unit: 'count', families: ['clicks'], kind: 'family' },
  link_clicks: { label: 'Outbound link clicks', unit: 'count', families: ['link_clicks'], kind: 'family' },
  watch_time: { label: 'Watch time', unit: 'minutes', families: ['watch_time'], kind: 'family' },
  avg_view_duration: { label: 'Average view duration', unit: 'seconds', families: ['watch_time', 'views'], kind: 'ratio' },
  followers: { label: 'Followers (latest snapshot)', unit: 'count', families: ['followers'], kind: 'snapshot' },
};

/** Derived per-post rollup keys (see migration 015 metric_rollups). */
export const DERIVED = {
  engagements: '_derived.engagements',
  erViewsNum: '_derived.er_views.num', erViewsDen: '_derived.er_views.den',
  erImprNum: '_derived.er_impressions.num', erImprDen: '_derived.er_impressions.den',
  /** Average view duration pairing: Σ watch seconds ÷ Σ views over videos reporting both. */
  avdNum: '_derived.avd.num', avdDen: '_derived.avd.den',
} as const;

export const familyKey = (f: MetricFamily) => `_family.${f}`;

// ------------------------------------------------------------------ DB sync
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function contentHash(d: MetricDefinition): string {
  return createHash('sha256').update(canonicalJson(d)).digest('hex').slice(0, 32);
}

function specOf(d: MetricDefinition) {
  return { aliases: d.aliases ?? [], ratio: d.ratio ?? null, min_threshold: d.minThreshold ?? null, notes: d.notes ?? null, unique: FAMILIES[d.family].unique, cross_network: FAMILIES[d.family].crossNetwork };
}

export class RegistryConflictError extends Error {}

let synced: Promise<void> | null = null;

/**
 * Upsert the registry into metric_definitions. Idempotent; refuses to silently change an existing (id, version)
 * (RegistryConflictError) — semantics changes must bump the version.
 */
export async function syncMetricRegistry(db?: Queryable): Promise<{ inserted: number; unchanged: number }> {
  const run = async (tx: Queryable) => {
    let inserted = 0; let unchanged = 0;
    await tx.query(`SELECT pg_advisory_xact_lock(727015)`);
    for (const d of METRIC_DEFINITIONS) {
      const hash = contentHash(d);
      const r = await tx.query<{ content_hash: string; inserted: boolean }>(
        `INSERT INTO metric_definitions(metric_id, version, provider, native_metric, dimension_key, name, description, unit, scope, family, aggregation, time_basis, paid,
            availability, fetched, required_scopes, retention_days, provider_delay_hours, freshness_hours, spec, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT (metric_id, version) DO UPDATE SET metric_id = metric_definitions.metric_id
         RETURNING content_hash, (xmax = 0) AS inserted`,
        [d.id, d.version, d.provider, d.nativeMetric, d.dimensionKey, d.name, d.description, d.unit, d.scope, d.family, d.aggregation, d.timeBasis, d.paid,
          d.availability, d.fetched, [...d.requiredScopes], d.retentionDays, d.providerDelayHours, d.freshnessHours, JSON.stringify(specOf(d)), hash]);
      const row = r.rows[0]!;
      if (row.inserted) inserted++;
      else if (row.content_hash !== hash) throw new RegistryConflictError(`metric ${d.id}@${d.version} changed without a version bump`);
      else unchanged++;
    }
    return { inserted, unchanged };
  };
  return db ? run(db) : withTx(run);
}

/** Memoized per process (ingestion calls this before writing facts that reference definitions). */
export function ensureMetricRegistry(): Promise<void> {
  if (!synced) synced = syncMetricRegistry().then(() => undefined).catch((err) => { synced = null; throw err; });
  return synced;
}

/** Test hook: forget the memoized sync (fresh databases). */
export function resetRegistrySync(): void { synced = null; }

/** Consistency check used by tests: every native metric an adapter requests has a definition. */
export function unmappedAdapterMetrics(): Array<{ provider: Provider; metric: string }> {
  const out: Array<{ provider: Provider; metric: string }> = [];
  for (const p of ['facebook', 'instagram', 'telegram', 'x', 'tiktok', 'youtube', 'linkedin', 'threads', 'pinterest', 'bluesky'] as const) {
    for (const m of metricsFetcherFor(p).metricNames) if (!resolveNative(p, m)) out.push({ provider: p, metric: m });
  }
  return out;
}
