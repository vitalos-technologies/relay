// Contract tests for native metrics request/response shapes (no network). Facts verified 2026-11-07:
//  FB  GET graph.facebook.com/{v}/{post-id}/insights?metric=…   (graph-api/reference/post/insights, reference/insights)
//  IG  GET graph.facebook.com/{v}/{ig-media-id}/insights?metric=… (instagram-platform/reference/instagram-media/insights)
//  X   GET api.x.com/2/tweets/{id}?post.fields=public_metrics     (api.x.com/2/openapi.json v2.174)
//  Telegram: unsupported (no Bot API statistics).
import { describe, expect, it } from 'vitest';
import type { AdapterContext, HttpRequest, HttpResponse, ProviderCredentials, PublishConnection } from '@social-lite/core';
import { metricsFetcherFor, simulatedMetrics, type MetricsTarget } from '@social-lite/providers/metrics';
import { parseInsights } from '@social-lite/providers/meta/metrics';
import { parsePublicMetrics } from '@social-lite/providers/x/metrics';

const conn = (provider: PublishConnection['provider']): PublishConnection => ({ id: 'c1', provider, providerAccountId: 'acct', displayName: 'A', metadata: {}, isMock: false });
function ctx(handler: (r: HttpRequest) => HttpResponse, config: AdapterContext['config'] = {}) {
  const calls: HttpRequest[] = [];
  const c: AdapterContext = { transport: { mode: 'live', send: async (r) => { calls.push(r); return handler(r); } }, now: () => new Date('2026-11-07T00:00:00Z'), config };
  return { c, calls };
}
const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });
const target = (provider: PublishConnection['provider'], credentials: ProviderCredentials, ids: string[]): MetricsTarget => ({ connection: conn(provider), credentials, providerIds: ids, publishedAt: null });

describe('Facebook Page post insights', () => {
  it('GET /{version}/{post-id}/insights with the documented metric list, token + appsecret_proof as query params', async () => {
    const { c, calls } = ctx(() => ok({ data: [] }), { clientSecret: 'app-secret' });
    await metricsFetcherFor('facebook').fetch(c, target('facebook', { kind: 'meta_page', pageAccessToken: 'PAGE' }, ['111_222', '333']));
    expect(calls).toHaveLength(1);
    const r = calls[0]!;
    expect(r.method).toBe('GET');
    expect(r.publishes).toBeFalsy();
    const u = new URL(r.url);
    expect(`${u.origin}${u.pathname}`).toBe('https://graph.facebook.com/v26.0/111_222/insights');
    expect(u.searchParams.get('metric')).toBe('post_media_view,post_total_media_view_unique,post_clicks,post_reactions_by_type_total');
    expect(u.searchParams.get('access_token')).toBe('PAGE');
    expect(u.searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
    expect(r.op).toBe('facebook.post.insights');
  });

  it('parses numeric and object (breakdown) values; skips non-numeric values instead of coercing to 0', () => {
    expect(parseInsights([
      { name: 'post_media_view', period: 'lifetime', values: [{ value: 10, end_time: '2026-11-06T08:00:00+0000' }] },
      { name: 'post_reactions_by_type_total', period: 'lifetime', values: [{ value: { like: 3, wow: 1 } }] },
      { name: 'post_clicks', period: 'lifetime', values: [{ value: null }] },
      { name: 'views', period: 'lifetime', total_value: { value: 7 } },
    ])).toEqual([
      { name: 'post_media_view', dimension: null, value: 10, period: 'lifetime', windowEnd: '2026-11-06T08:00:00+0000' },
      { name: 'post_reactions_by_type_total', dimension: 'like', value: 3, period: 'lifetime', windowEnd: null },
      { name: 'post_reactions_by_type_total', dimension: 'wow', value: 1, period: 'lifetime', windowEnd: null },
      { name: 'views', dimension: null, value: 7, period: 'lifetime', windowEnd: null },
    ]);
  });

  it('maps Graph errors: 190 => reconnect, 10 => permission_missing, 4 => rate_limited', async () => {
    for (const [code, kind] of [[190, 'reconnect'], [10, 'permission_missing'], [4, 'rate_limited']] as const) {
      const { c } = ctx(() => ({ status: 400, headers: {}, body: JSON.stringify({ error: { code, message: 'x', type: 'OAuthException' } }) }));
      const r = await metricsFetcherFor('facebook').fetch(c, target('facebook', { kind: 'meta_page', pageAccessToken: 'P' }, ['1_2']));
      expect(r.kind).toBe(kind);
    }
  });
});

describe('Instagram media insights', () => {
  it('GET /{version}/{ig-media-id}/insights with FEED metrics (no deprecated impressions)', async () => {
    const { c, calls } = ctx(() => ok({ data: [{ name: 'reach', period: 'lifetime', values: [{ value: 5 }] }] }));
    const r = await metricsFetcherFor('instagram').fetch(c, target('instagram', { kind: 'meta_page', pageAccessToken: 'P' }, ['1789']));
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/v26.0/1789/insights');
    const metrics = u.searchParams.get('metric')!.split(',');
    expect(metrics).toEqual(['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions']);
    expect(metrics).not.toContain('impressions');
    expect(r).toMatchObject({ kind: 'ok', points: [{ name: 'reach', value: 5 }] });
    expect(r.kind === 'ok' && r.unavailable.map((x) => x.name)).toContain('views');
  });
});

describe('X public metrics', () => {
  it('GET /2/tweets/{id}?post.fields=public_metrics with the user bearer token; billable', async () => {
    const fetcher = metricsFetcherFor('x');
    expect(fetcher.billableRead).toBe(true);
    const { c, calls } = ctx(() => ok({ data: { id: '1850', text: 't', public_metrics: { repost_count: 1, reply_count: 2, like_count: 3, quote_count: 4, bookmark_count: 5, impression_count: 6 } } }));
    const r = await fetcher.fetch(c, target('x', { kind: 'oauth2', accessToken: 'USER' }, ['1850']));
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.x.com/2/tweets/1850?post.fields=public_metrics', op: 'x.tweets.metrics' });
    expect(calls[0]!.headers?.authorization).toBe('Bearer USER');
    expect(r.kind === 'ok' && r.points.map((p) => [p.name, p.value])).toEqual([
      ['repost_count', 1], ['reply_count', 2], ['like_count', 3], ['quote_count', 4], ['bookmark_count', 5], ['impression_count', 6]]);
  });

  it('accepts the legacy retweet_count name; maps 401/402/429/404', async () => {
    expect(parsePublicMetrics({ data: { public_metrics: { retweet_count: 9 } } })).toEqual([{ name: 'retweet_count', dimension: null, value: 9, period: 'lifetime', windowEnd: null }]);
    for (const [status, kind] of [[401, 'reconnect'], [402, 'budget'], [429, 'rate_limited'], [404, 'not_found']] as const) {
      const { c } = ctx(() => ({ status, headers: {}, body: JSON.stringify({ title: 'err' }) }));
      expect((await metricsFetcherFor('x').fetch(c, target('x', { kind: 'oauth2', accessToken: 'U' }, ['1'])) ).kind).toBe(kind);
    }
  });

  it('never calls the API without a numeric post id', async () => {
    const { c, calls } = ctx(() => ok({}));
    expect((await metricsFetcherFor('x').fetch(c, target('x', { kind: 'oauth2', accessToken: 'U' }, ['mock_x_1']))).kind).toBe('not_found');
    expect(calls).toHaveLength(0);
  });
});

describe('Telegram and simulated', () => {
  it('Telegram is unsupported without any request (never 0)', async () => {
    const { c, calls } = ctx(() => ok({}));
    const f = metricsFetcherFor('telegram');
    expect(f.metricNames).toEqual([]);
    expect((await f.fetch(c, target('telegram', { kind: 'telegram_bot', botToken: 'b' }, ['-100:1']))).kind).toBe('unsupported');
    expect(calls).toHaveLength(0);
    expect(simulatedMetrics('telegram', 'mock_1', null, new Date()).kind).toBe('unsupported');
  });

  it('simulated metrics are deterministic and use the provider-native names', () => {
    const a = simulatedMetrics('instagram', 'mock_ig_1', '2026-11-06T00:00:00Z', new Date('2026-11-07T00:00:00Z'));
    const b = simulatedMetrics('instagram', 'mock_ig_1', '2026-11-06T00:00:00Z', new Date('2026-11-07T00:00:00Z'));
    expect(a).toEqual(b);
    expect(a.kind === 'ok' && a.points.map((p) => p.name)).toEqual(['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions']);
  });
});
