// Native post metrics (spec §17, V1.1). Read-only; never creates content.
//  - Metric names are stored in PROVIDER-NATIVE terms (no cross-network renaming or summing).
//  - Telegram: unsupported (the Bot API exposes no channel post statistics) — never reported as 0.
//  - Simulated (mock_) destinations get deterministic, clearly labelled simulated values without
//    any transport call.
// Endpoint facts verified 2026-11-07 — see meta/metrics.ts and x/metrics.ts for the source URLs.
import { createHash } from 'node:crypto';
import type { AdapterContext, Provider, ProviderCredentials, PublishConnection } from '@social-lite/core';
import { facebookMetricsFetcher, instagramMetricsFetcher } from './meta/metrics.js';
import { telegramMetricsFetcher } from './telegram/metrics.js';
import { xMetricsFetcher } from './x/metrics.js';
import { tiktokMetricsFetcher } from './tiktok/metrics.js';
import { youtubeMetricsFetcher } from './youtube/metrics.js';
import { linkedinMetricsFetcher } from './linkedin/metrics.js';
import { threadsMetricsFetcher } from './threads/metrics.js';
import { pinterestMetricsFetcher } from './pinterest/metrics.js';
import { blueskyMetricsFetcher } from './bluesky/metrics.js';

export const METRICS_RESEARCHED_ON = '2026-11-07';

export interface MetricPoint {
  /** Provider-native metric name, e.g. 'reach', 'post_media_view', 'impression_count'. */
  name: string;
  /** Breakdown key for object-valued metrics (e.g. 'like' for post_reactions_by_type_total). */
  dimension: string | null;
  value: number;
  /** Provider period, e.g. 'lifetime'. */
  period: string;
  /** Provider-reported end_time of the window, when present. */
  windowEnd: string | null;
}

export type MetricsOutcome =
  | { kind: 'ok'; points: MetricPoint[]; unavailable: Array<{ name: string; reason: string }> }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'permission_missing'; message: string }
  | { kind: 'reconnect'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'budget'; message: string }
  | { kind: 'rate_limited'; message: string; retryAfterMs: number | null }
  | { kind: 'error'; code: string; message: string };

export interface MetricsTarget {
  connection: PublishConnection;
  credentials: ProviderCredentials;
  /** Provider ids recorded on the delivery; the first one is the post/media id. */
  providerIds: string[];
  publishedAt: string | null;
}

export interface MetricsFetcher {
  readonly provider: Provider;
  /** true when each fetch is a billable API read (X). Callers must meter it BEFORE calling. */
  readonly billableRead: boolean;
  /** Metrics requested, in provider-native names (empty when unsupported). */
  readonly metricNames: readonly string[];
  fetch(ctx: AdapterContext, target: MetricsTarget): Promise<MetricsOutcome>;
}

const FETCHERS: Record<Provider, MetricsFetcher> = {
  facebook: facebookMetricsFetcher,
  instagram: instagramMetricsFetcher,
  telegram: telegramMetricsFetcher,
  x: xMetricsFetcher,
  // V3 (research 2026-11-07; sources in each <provider>/metrics.ts and docs/providers/<provider>.md)
  tiktok: tiktokMetricsFetcher,
  youtube: youtubeMetricsFetcher,
  linkedin: linkedinMetricsFetcher,
  threads: threadsMetricsFetcher,
  pinterest: pinterestMetricsFetcher,
  bluesky: blueskyMetricsFetcher,
};

export function metricsFetcherFor(provider: Provider): MetricsFetcher {
  return FETCHERS[provider];
}

/** Short human labels for provider-native names (display only; the stored name is unchanged). */
export const METRIC_LABELS: Record<string, string> = {
  // Facebook Page post insights
  post_media_view: 'Views',
  post_total_media_view_unique: 'Viewers',
  post_clicks: 'Clicks',
  post_reactions_by_type_total: 'Reactions',
  // Instagram media insights
  views: 'Views',
  reach: 'Reach',
  likes: 'Likes',
  comments: 'Comments',
  saved: 'Saves',
  shares: 'Shares',
  total_interactions: 'Interactions',
  // X public_metrics
  impression_count: 'Impressions',
  like_count: 'Likes',
  repost_count: 'Reposts',
  retweet_count: 'Reposts',
  reply_count: 'Replies',
  quote_count: 'Quotes',
  bookmark_count: 'Bookmarks',
  // V3: TikTok video query
  view_count: 'Views',
  comment_count: 'Comments',
  share_count: 'Shares',
  // YouTube Analytics
  estimatedMinutesWatched: 'Watch time (min)',
  averageViewDuration: 'Avg view duration (s)',
  subscribersGained: 'Subscribers gained',
  // LinkedIn (organization share statistics / member post analytics)
  impressionCount: 'Impressions',
  uniqueImpressionsCount: 'Unique impressions',
  clickCount: 'Clicks',
  likeCount: 'Likes',
  commentCount: 'Comments',
  shareCount: 'Reposts',
  IMPRESSION: 'Impressions',
  MEMBERS_REACHED: 'Members reached',
  REACTION: 'Reactions',
  COMMENT: 'Comments',
  RESHARE: 'Reposts',
  // Threads insights
  replies: 'Replies',
  reposts: 'Reposts',
  quotes: 'Quotes',
  // Pinterest Pin analytics
  SAVE: 'Saves',
  PIN_CLICK: 'Pin clicks',
  OUTBOUND_CLICK: 'Outbound clicks',
  TOTAL_COMMENTS: 'Comments',
  TOTAL_REACTIONS: 'Reactions',
  // Bluesky post counts
  repostCount: 'Reposts',
  replyCount: 'Replies',
  quoteCount: 'Quotes',
  bookmarkCount: 'Bookmarks',
};

/**
 * Deterministic SIMULATED metrics for mock_ destinations: seeded by the object id and growing with
 * hours since publication (capped at 7 days). Values are labelled source='simulated' by the caller
 * and are never presented as network-reported. Telegram stays unsupported even when simulated.
 */
export function simulatedMetrics(provider: Provider, objectId: string, publishedAt: string | null, now: Date): MetricsOutcome {
  const fetcher = FETCHERS[provider];
  if (!fetcher.metricNames.length) return { kind: 'unsupported', reason: 'Telegram does not provide post statistics to bots.' };
  const seed = createHash('sha256').update(`${provider}:${objectId}`).digest();
  const ageH = publishedAt ? Math.max(0, Math.min(168, (now.getTime() - new Date(publishedAt).getTime()) / 3_600_000)) : 0;
  const growth = Math.min(1, 0.15 + ageH / 48);
  const base = 200 + seed.readUInt16BE(0) % 1800;
  const views = Math.round(base * growth);
  const frac = (i: number, max: number) => (seed[i]! % 1000) / 1000 * max;
  const points: MetricPoint[] = [];
  const add = (name: string, value: number, dimension: string | null = null) =>
    points.push({ name, dimension, value: Math.max(0, Math.round(value)), period: 'lifetime', windowEnd: null });
  for (const [i, name] of fetcher.metricNames.entries()) {
    if (name === 'post_reactions_by_type_total') {
      add(name, views * frac(10, 0.05), 'like');
      add(name, views * frac(11, 0.01), 'love');
      continue;
    }
    const isAudience = /^(views|reach|impression_count|post_media_view|post_total_media_view_unique|view_count|impressionCount|uniqueImpressionsCount|IMPRESSION|MEMBERS_REACHED)$/.test(name);
    add(name, isAudience ? views * (name === 'reach' || name.endsWith('_unique') ? 0.7 : 1) : views * frac(i + 2, 0.06));
  }
  return { kind: 'ok', points, unavailable: [] };
}
