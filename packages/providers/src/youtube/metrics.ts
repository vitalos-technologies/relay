// YouTube per-video metrics from the YouTube Analytics API (Y10/Y11, verified 2026-11-07):
//   GET https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate&endDate&metrics=…&filters=video==ID
//   scope yt-analytics.readonly (+ youtube.readonly). rows omitted ⇒ no data yet (unavailable, never 0).
//   Monetary metrics are NOT requested (separate yt-analytics-monetary scope).
import { TransportError } from '@social-lite/core';
import type { MetricPoint, MetricsFetcher, MetricsOutcome } from '../metrics.js';
import { ProviderHttpError, oauthAccessToken } from '../shared/http.js';
import { metricsFromClass } from '../shared/classify.js';
import { grantedScopes } from '../shared/oauth.js';
import { classifyYouTube, ytCall } from './api.js';
import { YT_SCOPE_ANALYTICS } from './oauth.js';

export const YOUTUBE_METRICS = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'likes', 'comments', 'shares', 'subscribersGained'] as const;
const day = (d: Date) => d.toISOString().slice(0, 10);

export const youtubeMetricsFetcher: MetricsFetcher = {
  provider: 'youtube',
  billableRead: false,
  metricNames: YOUTUBE_METRICS,
  async fetch(ctx, target): Promise<MetricsOutcome> {
    const id = target.providerIds[0];
    if (!id) return { kind: 'not_found', message: 'No YouTube video id was recorded for this delivery.' };
    const scopes = grantedScopes(target.credentials);
    if (scopes.length && !scopes.includes(YT_SCOPE_ANALYTICS)) return { kind: 'permission_missing', message: 'YouTube Analytics access (yt-analytics.readonly) was not granted. Reconnect to enable video metrics.' };
    let token: string;
    try { token = oauthAccessToken(target.credentials, 'YouTube'); } catch { return { kind: 'reconnect', message: 'The connection has no usable token. Reconnect YouTube.' }; }
    const now = ctx.now();
    const start = target.publishedAt ? new Date(target.publishedAt) : new Date(now.getTime() - 28 * 86_400_000);
    try {
      const r = await ytCall<{ columnHeaders?: Array<{ name: string }>; rows?: unknown[][] }>(ctx, {
        method: 'GET', base: 'analytics', path: '/v2/reports', bearer: token, op: 'youtube.analytics.reports', timeoutMs: 20_000,
        query: { ids: 'channel==MINE', startDate: day(start), endDate: day(now), metrics: YOUTUBE_METRICS.join(','), filters: `video==${id}` },
      });
      const row = r.data.rows?.[0];
      if (!row) return { kind: 'ok', points: [], unavailable: YOUTUBE_METRICS.map((name) => ({ name, reason: 'No analytics data yet (YouTube Analytics is delayed)' })) };
      const headers = (r.data.columnHeaders ?? []).map((h) => h.name);
      const points: MetricPoint[] = [];
      const unavailable: Array<{ name: string; reason: string }> = [];
      for (const name of YOUTUBE_METRICS) {
        const v = row[headers.indexOf(name)];
        if (typeof v === 'number' && Number.isFinite(v)) points.push({ name, dimension: null, value: v, period: `${day(start)}..${day(now)}`, windowEnd: day(now) });
        else unavailable.push({ name, reason: 'Not reported by YouTube Analytics' });
      }
      return { kind: 'ok', points, unavailable };
    } catch (err) {
      if (err instanceof ProviderHttpError) return metricsFromClass(classifyYouTube(err, now.getTime()), 'YouTube');
      if (err instanceof TransportError) return { kind: 'error', code: `transport_${err.kind}`, message: 'YouTube could not be reached.' };
      throw err;
    }
  },
};
