// Facebook Page post insights + Instagram media insights (read-only; not billable per call).
//
// Verified 2026-11-07:
//  - Facebook: GET /{post-id}/insights?metric=... (https://developers.facebook.com/docs/graph-api/reference/post/insights)
//    Metric names from https://developers.facebook.com/docs/graph-api/reference/insights ("Page Post Media View",
//    "Page Post Engagement", "Page Post Reactions"). post_impressions* are "Deprecated above Graph API v25", so we
//    request post_media_view / post_total_media_view_unique instead. Permissions: read_insights + pages_read_engagement
//    (Page token of a person with the ANALYZE task). All are lifetime metrics.
//  - Instagram: GET /{ig-media-id}/insights?metric=... (https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights)
//    FEED metrics: views, reach, likes, comments, saved, shares, total_interactions ('impressions' is deprecated for
//    media created after 2024-07-02). Facebook Login permissions: instagram_basic, instagram_manage_insights,
//    pages_read_engagement. Period is always 'lifetime'. Album media has no insights.
//  - Response: { data: [{ name, period, values: [{ value, end_time? }], total_value?: { value } }] }.
//  - Requesting a metric that does not apply returns code 100 for the whole call, so on code 100 we
//    retry metric-by-metric and mark the rejected ones unavailable (never 0).
import type { AdapterContext } from '@social-lite/core';
import { graph, pageToken, type GraphErrorInfo } from './graph.js';
import { normalizeGraphError } from './errors.js';
import type { MetricPoint, MetricsFetcher, MetricsOutcome, MetricsTarget } from '../metrics.js';

export const FACEBOOK_POST_METRICS = ['post_media_view', 'post_total_media_view_unique', 'post_clicks', 'post_reactions_by_type_total'] as const;
export const INSTAGRAM_MEDIA_METRICS = ['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'] as const;
/** Permissions needed for insights in addition to the publishing scopes. */
export const FACEBOOK_INSIGHTS_SCOPES = ['read_insights', 'pages_read_engagement'] as const;
export const INSTAGRAM_INSIGHTS_SCOPES = ['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'] as const;

interface InsightRow {
  name?: unknown; period?: unknown;
  values?: Array<{ value?: unknown; end_time?: unknown }>;
  total_value?: { value?: unknown };
}

/** Parse an insights `data` array into provider-native points. Non-numeric values are skipped, never coerced. */
export function parseInsights(data: unknown): MetricPoint[] {
  const rows = Array.isArray(data) ? (data as InsightRow[]) : [];
  const out: MetricPoint[] = [];
  for (const r of rows) {
    if (typeof r.name !== 'string') continue;
    const period = typeof r.period === 'string' ? r.period : 'lifetime';
    const last = Array.isArray(r.values) && r.values.length ? r.values[r.values.length - 1] : undefined;
    const raw = last?.value !== undefined ? last.value : r.total_value?.value;
    const windowEnd = typeof last?.end_time === 'string' ? last.end_time : null;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      out.push({ name: r.name, dimension: null, value: raw, period, windowEnd });
    } else if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) out.push({ name: r.name, dimension: k, value: v, period, windowEnd });
      }
    }
  }
  return out;
}

function failure(e: GraphErrorInfo, headers: Record<string, string>): MetricsOutcome {
  const n = normalizeGraphError(e, headers);
  if (n.cls === 'reconnect') return { kind: 'reconnect', message: n.message };
  if (n.cls === 'permission') {
    return { kind: 'permission_missing', message: 'Meta did not grant insights access for this account. Reconnect and allow the insights permission.' };
  }
  if (n.cls === 'rate_limit') return { kind: 'rate_limited', message: 'Meta is rate-limiting insights reads. Try again later.', retryAfterMs: n.retryAfterMs ?? null };
  if (e.httpStatus === 404) return { kind: 'not_found', message: 'The post no longer exists on the network.' };
  return { kind: 'error', code: n.code, message: 'Meta could not return insights for this post right now.' };
}

const isInvalidMetric = (e: GraphErrorInfo) => e.code === 100 && e.subcode !== 33;

async function fetchInsights(ctx: AdapterContext, target: MetricsTarget, metrics: readonly string[], op: string): Promise<MetricsOutcome> {
  const token = pageToken(target.credentials);
  if (!token) return { kind: 'reconnect', message: 'The connection has no usable token. Reconnect the account.' };
  const objectId = target.providerIds[0];
  if (!objectId) return { kind: 'not_found', message: 'No post id was recorded for this delivery.' };
  const call = (m: readonly string[]) => graph<{ data?: unknown }>(ctx, { method: 'GET', path: `${encodeURIComponent(objectId)}/insights`, token, params: { metric: m.join(',') }, op });
  const all = await call(metrics);
  if (all.ok) {
    const points = parseInsights(all.data.data);
    const got = new Set(points.map((p) => p.name));
    return { kind: 'ok', points, unavailable: metrics.filter((m) => !got.has(m)).map((name) => ({ name, reason: 'Not reported for this post' })) };
  }
  if (!isInvalidMetric(all.error) || metrics.length < 2) return failure(all.error, all.headers);
  // One metric invalid for this media type / version: isolate it instead of failing everything.
  const points: MetricPoint[] = [];
  const unavailable: Array<{ name: string; reason: string }> = [];
  for (const m of metrics) {
    const r = await call([m]);
    if (r.ok) {
      const p = parseInsights(r.data.data);
      if (p.length) points.push(...p); else unavailable.push({ name: m, reason: 'Not reported for this post' });
    } else if (isInvalidMetric(r.error)) {
      unavailable.push({ name: m, reason: 'Not available for this post type or API version' });
    } else {
      return failure(r.error, r.headers);
    }
  }
  return { kind: 'ok', points, unavailable };
}

export const facebookMetricsFetcher: MetricsFetcher = {
  provider: 'facebook',
  billableRead: false,
  metricNames: FACEBOOK_POST_METRICS,
  fetch: (ctx, target) => fetchInsights(ctx, target, FACEBOOK_POST_METRICS, 'facebook.post.insights'),
};

export const instagramMetricsFetcher: MetricsFetcher = {
  provider: 'instagram',
  billableRead: false,
  metricNames: INSTAGRAM_MEDIA_METRICS,
  fetch: (ctx, target) => fetchInsights(ctx, target, INSTAGRAM_MEDIA_METRICS, 'instagram.media.insights'),
};
