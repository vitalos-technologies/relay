// TikTok public video metrics via the Display API video query (T14, verified 2026-11-07):
//   POST https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count
//   body {filters:{video_ids:[…≤20]}}, scope video.list. Only PUBLIC posts have a post id
//   (status/fetch publicaly_available_post_id); private/draft deliveries are 'unsupported', never 0.
import { TransportError } from '@social-lite/core';
import type { MetricPoint, MetricsFetcher, MetricsOutcome } from '../metrics.js';
import { ProviderHttpError, oauthAccessToken } from '../shared/http.js';
import { metricsFromClass } from '../shared/classify.js';
import { TIKTOK_JSON, classifyTikTok, tiktokCall } from './api.js';

export const TIKTOK_METRICS = ['view_count', 'like_count', 'comment_count', 'share_count'] as const;

export const tiktokMetricsFetcher: MetricsFetcher = {
  provider: 'tiktok',
  billableRead: false,
  metricNames: TIKTOK_METRICS,
  async fetch(ctx, target): Promise<MetricsOutcome> {
    const id = target.providerIds.find((x) => /^\d{6,25}$/.test(x)) ?? null;
    if (!id) return { kind: 'unsupported', reason: 'TikTok reports metrics only for public posts; this delivery has no public TikTok post id (private, draft or manual handoff).' };
    let token: string;
    try { token = oauthAccessToken(target.credentials, 'TikTok'); } catch { return { kind: 'reconnect', message: 'The connection has no usable token. Reconnect the TikTok account.' }; }
    try {
      const r = await tiktokCall<{ data?: { videos?: Array<Record<string, unknown>> } }>(ctx, {
        method: 'POST', path: '/v2/video/query/', query: { fields: ['id', ...TIKTOK_METRICS].join(',') }, bearer: token,
        headers: { 'content-type': TIKTOK_JSON }, json: { filters: { video_ids: [id] } }, op: 'tiktok.video.query', timeoutMs: 15_000,
      });
      const v = (r.data.data?.videos ?? []).find((x) => String(x.id) === id);
      if (!v) return { kind: 'not_found', message: 'TikTok did not return this video (deleted or no longer public).' };
      const points: MetricPoint[] = [];
      const unavailable: Array<{ name: string; reason: string }> = [];
      for (const name of TIKTOK_METRICS) {
        const val = v[name];
        if (typeof val === 'number' && Number.isFinite(val)) points.push({ name, dimension: null, value: val, period: 'lifetime', windowEnd: null });
        else unavailable.push({ name, reason: 'Not reported by TikTok' });
      }
      return { kind: 'ok', points, unavailable };
    } catch (err) {
      if (err instanceof ProviderHttpError) return metricsFromClass(classifyTikTok(err, ctx.now().getTime()), 'TikTok');
      if (err instanceof TransportError) return { kind: 'error', code: `transport_${err.kind}`, message: 'TikTok could not be reached.' };
      throw err;
    }
  },
};
