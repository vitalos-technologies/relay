// Bluesky post counts from the public AppView (A4 app.bsky.feed.getPosts, verified 2026-11-07):
//   GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=at://… → posts[].{likeCount, repostCount,
//   replyCount, quoteCount, bookmarkCount}. No impressions/views exist on Bluesky ⇒ never reported.
import { TransportError } from '@social-lite/core';
import type { MetricPoint, MetricsFetcher, MetricsOutcome } from '../metrics.js';
import { ProviderHttpError } from '../shared/http.js';
import { metricsFromClass } from '../shared/classify.js';
import { BSKY_PUBLIC_APPVIEW, classifyBluesky, xrpc } from './api.js';

export const BLUESKY_METRICS = ['likeCount', 'repostCount', 'replyCount', 'quoteCount', 'bookmarkCount'] as const;

export const blueskyMetricsFetcher: MetricsFetcher = {
  provider: 'bluesky',
  billableRead: false,
  metricNames: BLUESKY_METRICS,
  async fetch(ctx, target): Promise<MetricsOutcome> {
    const uri = target.providerIds.find((x) => x.startsWith('at://'));
    if (!uri) return { kind: 'not_found', message: 'No Bluesky post URI was recorded for this delivery.' };
    try {
      const r = await xrpc<{ posts?: Array<Record<string, unknown>> }>(ctx, {
        service: ctx.config.baseUrls?.blueskyAppView ?? BSKY_PUBLIC_APPVIEW, nsid: 'app.bsky.feed.getPosts', method: 'GET', params: { uris: uri }, op: 'bluesky.posts.get', timeoutMs: 15_000,
      });
      const post = (r.data.posts ?? []).find((p) => p.uri === uri);
      if (!post) return { kind: 'not_found', message: 'The post no longer exists on Bluesky (or is not visible).' };
      const points: MetricPoint[] = [];
      const unavailable: Array<{ name: string; reason: string }> = [];
      for (const name of BLUESKY_METRICS) {
        const v = post[name];
        if (typeof v === 'number' && Number.isFinite(v)) points.push({ name, dimension: null, value: v, period: 'lifetime', windowEnd: null });
        else unavailable.push({ name, reason: 'Not reported by Bluesky' });
      }
      return { kind: 'ok', points, unavailable };
    } catch (err) {
      if (err instanceof ProviderHttpError) return metricsFromClass(classifyBluesky(err, ctx.now().getTime()), 'Bluesky');
      if (err instanceof TransportError) return { kind: 'error', code: `transport_${err.kind}`, message: 'Bluesky could not be reached.' };
      throw err;
    }
  },
};
