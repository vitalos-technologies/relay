// Threads media insights (H8, verified 2026-11-07):
//   GET https://graph.threads.com/v1.0/{media-id}/insights?metric=views,likes,replies,reposts,quotes,shares
//   (threads_basic + threads_manage_insights). `views`/`shares` are marked "in development" by Meta.
import { TransportError } from '@social-lite/core';
import type { MetricPoint, MetricsFetcher, MetricsOutcome } from '../metrics.js';
import { ProviderHttpError, oauthAccessToken } from '../shared/http.js';
import { metricsFromClass } from '../shared/classify.js';
import { THREADS_VERSION, classifyThreads, threadsCall } from './api.js';

export const THREADS_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'] as const;

interface Insight { name?: string; period?: string; values?: Array<{ value?: unknown; end_time?: string }>; total_value?: { value?: unknown } }

export function parseThreadsInsights(data: Insight[]): MetricPoint[] {
  const out: MetricPoint[] = [];
  for (const d of data) {
    if (!d.name) continue;
    const v = d.total_value?.value ?? d.values?.[0]?.value;
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ name: d.name, dimension: null, value: v, period: d.period ?? 'lifetime', windowEnd: d.values?.[0]?.end_time ?? null });
  }
  return out;
}

export const threadsMetricsFetcher: MetricsFetcher = {
  provider: 'threads',
  billableRead: false,
  metricNames: THREADS_METRICS,
  async fetch(ctx, target): Promise<MetricsOutcome> {
    const id = target.providerIds[0];
    if (!id) return { kind: 'not_found', message: 'No Threads media id was recorded for this delivery.' };
    let token: string;
    try { token = oauthAccessToken(target.credentials, 'Threads'); } catch { return { kind: 'reconnect', message: 'Reconnect the Threads account.' }; }
    try {
      const r = await threadsCall<{ data?: Insight[] }>(ctx, { method: 'GET', path: `/${THREADS_VERSION}/${encodeURIComponent(id)}/insights`, token, params: { metric: THREADS_METRICS.join(',') }, op: 'threads.media.insights', timeoutMs: 15_000 });
      const points = parseThreadsInsights(r.data.data ?? []);
      const got = new Set(points.map((p) => p.name));
      return { kind: 'ok', points, unavailable: THREADS_METRICS.filter((m) => !got.has(m)).map((name) => ({ name, reason: 'Not reported by Threads' })) };
    } catch (err) {
      if (err instanceof ProviderHttpError) return metricsFromClass(classifyThreads(err, ctx.now().getTime()), 'Threads');
      if (err instanceof TransportError) return { kind: 'error', code: `transport_${err.kind}`, message: 'Threads could not be reached.' };
      throw err;
    }
  },
};
