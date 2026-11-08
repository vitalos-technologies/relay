// X public post metrics. BILLABLE READ: callers must consume the workspace 'x.read' budget before
// calling (services/analytics does, via engine/budget.checkAndConsumeBudget) and skip when exhausted.
//
// Verified 2026-11-07 against the current OpenAPI spec (https://api.x.com/2/openapi.json, version 2.174)
// and https://docs.x.com/x-api/posts/get-post-by-id :
//   GET https://api.x.com/2/tweets/{id}?post.fields=public_metrics   (OAuth 2.0 user token: tweet.read users.read)
//   The field selector is `post.fields` (formerly tweet.fields). PostPublicMetrics requires
//   repost_count, reply_count, like_count, quote_count, bookmark_count, impression_count
//   (repost_count was formerly retweet_count; both are accepted when parsing).
import type { MetricPoint, MetricsFetcher, MetricsOutcome } from '../metrics.js';
import { accessTokenFrom, classifyXError, xCall, XApiError } from './api.js';
import { TransportError } from '@social-lite/core';

export const X_PUBLIC_METRICS = ['impression_count', 'like_count', 'repost_count', 'reply_count', 'quote_count', 'bookmark_count'] as const;

export function parsePublicMetrics(body: unknown): MetricPoint[] | null {
  const data = (body as { data?: { public_metrics?: Record<string, unknown> } } | null)?.data;
  const pm = data?.public_metrics;
  if (!pm || typeof pm !== 'object') return null;
  const out: MetricPoint[] = [];
  for (const [name, v] of Object.entries(pm)) {
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ name, dimension: null, value: v, period: 'lifetime', windowEnd: null });
  }
  return out;
}

export const xMetricsFetcher: MetricsFetcher = {
  provider: 'x',
  billableRead: true,
  metricNames: X_PUBLIC_METRICS,
  async fetch(ctx, target): Promise<MetricsOutcome> {
    const id = target.providerIds.find((x) => /^\d{1,19}$/.test(x)) ?? null;
    if (!id) return { kind: 'not_found', message: 'No X post id was recorded for this delivery.' };
    let token: string;
    try { token = accessTokenFrom(target.credentials); } catch { return { kind: 'reconnect', message: 'The connection has no usable token. Reconnect the X account.' }; }
    try {
      const r = await xCall<unknown>(ctx, { method: 'GET', path: `/2/tweets/${id}`, query: { 'post.fields': 'public_metrics' }, bearer: token, op: 'x.tweets.metrics', timeoutMs: 15_000 });
      const points = parsePublicMetrics(r.data);
      if (!points) {
        const errs = (r.data as { errors?: Array<{ type?: string }> })?.errors;
        if (errs?.some((e) => /resource-not-found/.test(e.type ?? ''))) return { kind: 'not_found', message: 'The post no longer exists on X.' };
        return { kind: 'error', code: 'x_metrics_missing', message: 'X did not return metrics for this post.' };
      }
      const got = new Set(points.map((p) => p.name === 'retweet_count' ? 'repost_count' : p.name));
      return { kind: 'ok', points, unavailable: X_PUBLIC_METRICS.filter((m) => !got.has(m)).map((name) => ({ name, reason: 'Not reported by X' })) };
    } catch (err) {
      if (err instanceof XApiError) {
        if (err.status === 404) return { kind: 'not_found', message: 'The post no longer exists on X.' };
        const c = classifyXError(err, ctx.now().getTime());
        if (c.kind === 'reconnect') return { kind: 'reconnect', message: c.message };
        if (c.kind === 'budget') return { kind: 'budget', message: c.message };
        if (c.kind === 'rate_limited') return { kind: 'rate_limited', message: c.message, retryAfterMs: c.retryAfterMs };
        if (c.kind === 'permission') return { kind: 'permission_missing', message: c.message };
        return { kind: 'error', code: c.code, message: 'X could not return metrics for this post right now.' };
      }
      if (err instanceof TransportError) return { kind: 'error', code: `transport_${err.kind}`, message: 'X could not be reached.' };
      throw err;
    }
  },
};
