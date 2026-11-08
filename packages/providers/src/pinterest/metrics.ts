// Pinterest Pin analytics (P1 OpenAPI v5.28.0, verified 2026-11-07):
//   GET /v5/pins/{pin_id}/analytics?start_date&end_date&metric_types=…  (boards:read pins:read)
//   start_date ≤ 90 days back; response {ALL: {summary_metrics, daily_metrics, lifetime_metrics}}.
//   Reported as a window total ("period" = the date range), not lifetime.
import { TransportError } from '@social-lite/core';
import type { MetricPoint, MetricsFetcher, MetricsOutcome } from '../metrics.js';
import { ProviderHttpError, oauthAccessToken } from '../shared/http.js';
import { metricsFromClass } from '../shared/classify.js';
import { classifyPinterest, pinCall } from './api.js';

export const PINTEREST_METRICS = ['IMPRESSION', 'SAVE', 'PIN_CLICK', 'OUTBOUND_CLICK', 'TOTAL_COMMENTS', 'TOTAL_REACTIONS'] as const;
const day = (d: Date) => d.toISOString().slice(0, 10);

export const pinterestMetricsFetcher: MetricsFetcher = {
  provider: 'pinterest',
  billableRead: false,
  metricNames: PINTEREST_METRICS,
  async fetch(ctx, target): Promise<MetricsOutcome> {
    const id = target.providerIds.find((x) => /^\d+$/.test(x) || x.startsWith('mock_'));
    if (!id) return { kind: 'not_found', message: 'No Pinterest Pin id was recorded for this delivery.' };
    let token: string;
    try { token = oauthAccessToken(target.credentials, 'Pinterest'); } catch { return { kind: 'reconnect', message: 'Reconnect the Pinterest account.' }; }
    const now = ctx.now();
    const earliest = new Date(now.getTime() - 89 * 86_400_000);
    const pub = target.publishedAt ? new Date(target.publishedAt) : earliest;
    const start = pub < earliest ? earliest : pub;
    try {
      const r = await pinCall<Record<string, { summary_metrics?: Record<string, unknown> }>>(ctx, {
        method: 'GET', path: `/v5/pins/${encodeURIComponent(id)}/analytics`, bearer: token, op: 'pinterest.pin.analytics', timeoutMs: 15_000,
        query: { start_date: day(start), end_date: day(now), metric_types: PINTEREST_METRICS.join(',') },
      });
      const sm = r.data.ALL?.summary_metrics ?? r.data.all?.summary_metrics ?? {};
      const points: MetricPoint[] = [];
      const unavailable: Array<{ name: string; reason: string }> = [];
      for (const name of PINTEREST_METRICS) {
        const v = sm[name];
        if (typeof v === 'number' && Number.isFinite(v)) points.push({ name, dimension: null, value: v, period: `${day(start)}..${day(now)}`, windowEnd: day(now) });
        else unavailable.push({ name, reason: 'Not reported by Pinterest' });
      }
      return { kind: 'ok', points, unavailable };
    } catch (err) {
      if (err instanceof ProviderHttpError) return metricsFromClass(classifyPinterest(err, now.getTime()), 'Pinterest');
      if (err instanceof TransportError) return { kind: 'error', code: `transport_${err.kind}`, message: 'Pinterest could not be reached.' };
      throw err;
    }
  },
};
