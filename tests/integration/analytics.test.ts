// Native analytics (V1.1): fetch/snapshot semantics, X read budget, Telegram unavailable, simulated labelling,
// throttled on-demand refresh, daily job and brand permissions — fake transports, REAL PostgreSQL.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterContext, HttpRequest, HttpResponse, Provider } from '@social-lite/core';
import { claimDelivery, createPost, processDelivery, publishNow } from '@social-lite/services';
import {
  listAnalytics, refreshDeliveryMetrics, requestMetricsRefresh, runDailyMetricsRefresh, type AnalyticsDeps,
} from '@social-lite/services/analytics/index';
import { addMember, closeTestPool, createBrand, createUser, ctxFor, tenant, testPool } from './helpers.js';
import { scriptedWorld, seedConnections, seedReadyImage } from './engine-helpers.js';

afterAll(closeTestPool);
beforeEach(async () => {
  await testPool().query(`UPDATE deliveries SET state='cancelled' WHERE state IN ('scheduled','retry_wait','processing','preparing','publishing')`);
});

type T = Awaited<ReturnType<typeof tenant>>;
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function liveConnection(workspaceId: string, brandId: string, provider: Provider): Promise<string> {
  const r = await testPool().query<{ id: string }>(
    `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, status, is_mock) VALUES ($1,$2,$3,$4,$5,'ready',false) RETURNING id`,
    [workspaceId, brandId, provider, `${provider}-${randomUUID().slice(0, 8)}`, `Live ${provider}`]);
  return r.rows[0]!.id;
}

/** Publish a one-destination post through the real pipeline with a scripted adapter returning `providerIds`. */
async function published(t: T, brandId: string, connectionId: string, provider: Provider, providerIds: string[]): Promise<string> {
  const world = scriptedWorld();
  world.scripts[provider] = { publish: () => ({ kind: 'confirmed', providerIds, url: null }) };
  const image = provider === 'instagram' ? await seedReadyImage(t.workspaceId, brandId) : null;
  const draft = { baseText: 'Analytics post', baseLink: null, baseAssetIds: image ? [image] : [], variants: [{ connectionId, inheritText: true, inheritMedia: true }] };
  const { id } = await createPost(t.ownerCtx, brandId, { title: `A ${provider}`, draft }, randomUUID());
  await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [connectionId] }, randomUUID());
  for (let i = 0; i < 5; i++) {
    const c = await claimDelivery('analytics-w');
    if (!c) break;
    await processDelivery(world.deps, c);
  }
  const d = await testPool().query<{ id: string; state: string }>(`SELECT id, state FROM deliveries WHERE post_id=$1`, [id]);
  expect(d.rows[0]!.state).toBe('published');
  return d.rows[0]!.id;
}

function fakeDeps(handler: (req: HttpRequest) => HttpResponse) {
  const calls: HttpRequest[] = [];
  const deps: AnalyticsDeps = {
    getCredentials: async (connectionId) => {
      const c = (await testPool().query(`SELECT * FROM connections WHERE id=$1`, [connectionId])).rows[0];
      const credentials = c.provider === 'x' ? { kind: 'oauth2' as const, accessToken: 'x-user-token' } : { kind: 'meta_page' as const, pageAccessToken: 'page-token' };
      return { credentials, connection: { id: c.id, provider: c.provider, providerAccountId: c.provider_account_id, displayName: c.display_name, metadata: {}, isMock: c.is_mock } };
    },
    adapterContext: async () => ({ transport: { mode: 'live', send: async (req: HttpRequest) => { calls.push(req); return handler(req); } }, now: () => new Date(), config: { apiVersion: 'v26.0' } }) as AdapterContext,
  };
  return { deps, calls };
}

async function snapshots(deliveryId: string) {
  return (await testPool().query(`SELECT metric, dimension, value::float AS value, period, source FROM metric_snapshots WHERE delivery_id=$1 ORDER BY metric, dimension`, [deliveryId])).rows;
}

describe('provider fetchers', () => {
  it('Facebook: Page post insights are snapshotted in provider-native names with period and source', async () => {
    const t = await tenant();
    const conn = await liveConnection(t.workspaceId, t.brandId, 'facebook');
    const del = await published(t, t.brandId, conn, 'facebook', ['123_456']);
    const { deps, calls } = fakeDeps(() => json(200, { data: [
      { name: 'post_media_view', period: 'lifetime', values: [{ value: 812 }] },
      { name: 'post_total_media_view_unique', period: 'lifetime', values: [{ value: 640 }] },
      { name: 'post_clicks', period: 'lifetime', values: [{ value: 37 }] },
      { name: 'post_reactions_by_type_total', period: 'lifetime', values: [{ value: { like: 20, love: 3 } }] },
    ] }));
    const r = await refreshDeliveryMetrics(del, deps);
    expect(r).toMatchObject({ status: 'ok', points: 5 });
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/v26.0/123_456/insights');
    expect(u.searchParams.get('metric')).toBe('post_media_view,post_total_media_view_unique,post_clicks,post_reactions_by_type_total');
    expect(await snapshots(del)).toEqual([
      { metric: 'post_clicks', dimension: null, value: 37, period: 'lifetime', source: 'provider' },
      { metric: 'post_media_view', dimension: null, value: 812, period: 'lifetime', source: 'provider' },
      { metric: 'post_reactions_by_type_total', dimension: 'like', value: 20, period: 'lifetime', source: 'provider' },
      { metric: 'post_reactions_by_type_total', dimension: 'love', value: 3, period: 'lifetime', source: 'provider' },
      { metric: 'post_total_media_view_unique', dimension: null, value: 640, period: 'lifetime', source: 'provider' },
    ]);
    const page = await listAnalytics(t.ownerCtx, { brand_id: t.brandId });
    expect(page.items[0]).toMatchObject({ delivery_id: del, status: 'ok', source: 'provider', supported: true });
    expect(page.items[0]!.last_refreshed_at).not.toBeNull();
  });

  it('Facebook: an invalid metric (code 100) is isolated and marked unavailable, never 0', async () => {
    const t = await tenant();
    const conn = await liveConnection(t.workspaceId, t.brandId, 'facebook');
    const del = await published(t, t.brandId, conn, 'facebook', ['9_9']);
    const { deps, calls } = fakeDeps((req) => {
      const m = new URL(req.url).searchParams.get('metric')!;
      if (m.includes(',') || m === 'post_clicks') return json(400, { error: { code: 100, message: '(#100) The value must be a valid insights metric', type: 'OAuthException' } });
      return json(200, { data: [{ name: m, period: 'lifetime', values: [{ value: m === 'post_reactions_by_type_total' ? {} : 5 }] }] });
    });
    const r = await refreshDeliveryMetrics(del, deps);
    expect(r?.status).toBe('ok');
    expect(calls).toHaveLength(5);
    const names = (await snapshots(del)).map((s) => s.metric);
    expect(names).toEqual(['post_media_view', 'post_total_media_view_unique']);
    expect(r?.message).toMatch(/post_clicks/);
    expect(r?.message).toMatch(/post_reactions_by_type_total/);
  });

  it('Instagram: missing insights permission => permission_missing, no snapshots', async () => {
    const t = await tenant();
    const conn = await liveConnection(t.workspaceId, t.brandId, 'instagram');
    const del = await published(t, t.brandId, conn, 'instagram', ['17890000000000001']);
    const { deps, calls } = fakeDeps(() => json(403, { error: { code: 10, message: '(#10) Application does not have permission for this action', type: 'OAuthException' } }));
    const r = await refreshDeliveryMetrics(del, deps);
    expect(r?.status).toBe('permission_missing');
    expect(new URL(calls[0]!.url).pathname).toBe('/v26.0/17890000000000001/insights');
    expect(new URL(calls[0]!.url).searchParams.get('metric')).toBe('views,reach,likes,comments,saved,shares,total_interactions');
    expect(await snapshots(del)).toEqual([]);
    const item = (await listAnalytics(t.ownerCtx, { delivery_id: del })).items[0]!;
    expect(item).toMatchObject({ status: 'permission_missing', metrics: [] });
  });

  it('X: public metrics consume the x.read budget before calling; exhausted => skipped without a request', async () => {
    const t = await tenant();
    await testPool().query(`UPDATE workspaces SET limits='{"x_monthly_reads": 1}' WHERE id=$1`, [t.workspaceId]);
    const conn = await liveConnection(t.workspaceId, t.brandId, 'x');
    const del = await published(t, t.brandId, conn, 'x', ['1850000000000000001']);
    const { deps, calls } = fakeDeps(() => json(200, { data: { id: '1850000000000000001', text: 'x', public_metrics: {
      repost_count: 2, reply_count: 1, like_count: 9, quote_count: 0, bookmark_count: 1, impression_count: 420 } } }));
    expect((await refreshDeliveryMetrics(del, deps))?.status).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.x.com/2/tweets/1850000000000000001?post.fields=public_metrics');
    expect(calls[0]!.headers?.authorization).toBe('Bearer x-user-token');
    const used = await testPool().query(`SELECT used::int FROM usage_counters WHERE workspace_id=$1 AND meter='x.read'`, [t.workspaceId]);
    expect(used.rows[0].used).toBe(1);
    expect((await snapshots(del)).find((s) => s.metric === 'impression_count')).toMatchObject({ value: 420, source: 'provider' });
    const second = await refreshDeliveryMetrics(del, deps);
    expect(second?.status).toBe('budget_exhausted');
    expect(calls).toHaveLength(1); // not called
    const item = (await listAnalytics(t.ownerCtx, { delivery_id: del })).items[0]!;
    expect(item.status).toBe('budget_exhausted');
    expect(item.metrics.find((m) => m.name === 'impression_count')?.value).toBe(420); // last known value kept, with its observed_at
    expect(item.billable).toBe(true);
  });

  it('Telegram: unsupported => "Unavailable", no metrics, no network call', async () => {
    const t = await tenant();
    const conn = await liveConnection(t.workspaceId, t.brandId, 'telegram');
    const del = await published(t, t.brandId, conn, 'telegram', ['-1001234567890:55']);
    const { deps, calls } = fakeDeps(() => { throw new Error('must not be called'); });
    expect((await refreshDeliveryMetrics(del, deps))?.status).toBe('unsupported');
    expect(calls).toHaveLength(0);
    const item = (await listAnalytics(t.ownerCtx, { delivery_id: del })).items[0]!;
    expect(item).toMatchObject({ supported: false, status: 'unsupported', metrics: [], expected_metrics: [] });
    expect(item.status_message).toMatch(/Unavailable/);
  });

  it('simulated destinations get labelled simulated values and never touch a transport or the X budget', async () => {
    const t = await tenant();
    await testPool().query(`UPDATE workspaces SET limits='{"x_monthly_reads": 0}' WHERE id=$1`, [t.workspaceId]);
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const del = await published(t, t.brandId, conns.x, 'x', ['mock_x_77']);
    const { deps, calls } = fakeDeps(() => { throw new Error('must not be called'); });
    expect((await refreshDeliveryMetrics(del, deps))?.status).toBe('ok');
    expect(calls).toHaveLength(0);
    const rows = await snapshots(del);
    expect(rows.length).toBe(6);
    expect(rows.every((r) => r.source === 'simulated')).toBe(true);
    expect((await listAnalytics(t.ownerCtx, { delivery_id: del })).items[0]).toMatchObject({ is_mock: true, source: 'simulated', billable: false });
  });
});

describe('refresh scheduling', () => {
  it('on-demand refresh is throttled per delivery; the daily job skips recently refreshed deliveries', async () => {
    const t = await tenant();
    const conn = await liveConnection(t.workspaceId, t.brandId, 'facebook');
    const del = await published(t, t.brandId, conn, 'facebook', ['1_2']);
    const { deps, calls } = fakeDeps(() => json(200, { data: [{ name: 'post_media_view', period: 'lifetime', values: [{ value: 1 }] }] }));
    const item = await requestMetricsRefresh(t.ownerCtx, del, deps);
    expect(item.status).toBe('ok');
    expect(item.next_refresh_allowed_at).not.toBeNull();
    await expect(requestMetricsRefresh(t.ownerCtx, del, deps)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(calls).toHaveLength(1);
    // Daily job: this delivery was just attempted => not fetched again.
    const mine = () => calls.filter((c) => new URL(c.url).pathname.includes('/1_2/')).length;
    await runDailyMetricsRefresh(deps, { limit: 2000 });
    expect(mine()).toBe(1);
    await testPool().query(`UPDATE metric_fetch_state SET last_attempt_at=now() - interval '25 hours' WHERE delivery_id=$1`, [del]);
    await runDailyMetricsRefresh(deps, { limit: 2000 });
    expect(mine()).toBe(2);
    const audit = await testPool().query(`SELECT count(*)::int n FROM audit_events WHERE action='metrics.refresh_requested' AND resource_id=$1`, [del]);
    expect(audit.rows[0].n).toBe(1);
  });
});

describe('permissions', () => {
  it('brand grants are respected; other tenants get 404 / nothing', async () => {
    const t = await tenant();
    const brand2 = await createBrand(t.workspaceId, 'Second');
    const c1 = await liveConnection(t.workspaceId, t.brandId, 'facebook');
    const c2 = await liveConnection(t.workspaceId, brand2, 'facebook');
    const d1 = await published(t, t.brandId, c1, 'facebook', ['1_1']);
    const d2 = await published(t, brand2, c2, 'facebook', ['2_2']);
    const viewer = await createUser();
    await addMember(t.workspaceId, viewer.id, 'viewer', [t.brandId]);
    const vCtx = ctxFor(viewer.id, t.workspaceId, 'viewer', [t.brandId]);
    const ids = (await listAnalytics(vCtx, {})).items.map((i) => i.delivery_id);
    expect(ids).toContain(d1);
    expect(ids).not.toContain(d2);
    const { deps } = fakeDeps(() => json(200, { data: [] }));
    await expect(requestMetricsRefresh(vCtx, d2, deps)).rejects.toMatchObject({ code: 'not_found' });
    const other = await tenant();
    expect((await listAnalytics(other.ownerCtx, {})).items.map((i) => i.delivery_id)).not.toContain(d1);
    await expect(requestMetricsRefresh(other.ownerCtx, d1, deps)).rejects.toMatchObject({ code: 'not_found' });
    expect((await listAnalytics(other.ownerCtx, { brand_id: t.brandId })).items).toEqual([]);
  });
});
