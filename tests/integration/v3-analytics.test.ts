// V3 analytics semantics through the REAL pipeline and query API (real PostgreSQL, V2 policy via v2Ctx):
// missing vs zero vs unsupported, lifetime vs daily separation, ratio-of-sums engagement rate, DST date boundaries,
// baseline-zero comparisons, late corrections without duplicates, incompatible measures, coverage/freshness by scope,
// rollup ≡ per-post aggregation, demo isolation and cross-tenant isolation.
import { afterAll, describe, expect, it } from 'vitest';
import { contentDetail, contentTable, channels, overview, aggregate, resolveScope, video, audience, bestTime } from '@social-lite/services/analytics/query';
import { syncMetricRegistry, unmappedAdapterMetrics, METRIC_DEFINITIONS } from '@social-lite/services/analytics/registry';
import { seedAnalyticsDemo } from '@social-lite/services/analytics/demo';
import { addMember, closeTestPool, createBrand, createUser, grant, testPool, v2Ctx } from './helpers.js';
import { analyticsTenant, connection, count, filters, observe, publish, pt } from './v3-analytics-helpers.js';

afterAll(closeTestPool);

describe('metric registry', () => {
  it('maps every metric the 10 provider fetchers request; sync is idempotent and immutable per version', async () => {
    expect(unmappedAdapterMetrics()).toEqual([]);
    const first = await syncMetricRegistry(testPool());
    const second = await syncMetricRegistry(testPool());
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(first.inserted + first.unchanged);
    expect(await count(`SELECT count(*) n FROM metric_definitions`)).toBe(METRIC_DEFINITIONS.length);
    // A silent redefinition of an existing (id, version) is refused.
    await testPool().query(`UPDATE metric_definitions SET content_hash='tampered' WHERE metric_id='instagram.post.reach'`);
    await expect(syncMetricRegistry(testPool())).rejects.toThrow(/without a version bump/);
    await testPool().query(`DELETE FROM metric_definitions WHERE metric_id='instagram.post.reach' AND NOT EXISTS (SELECT 1 FROM metric_observations WHERE metric_id='instagram.post.reach')`);
    await syncMetricRegistry(testPool());
  });
});

describe('missing vs zero vs unsupported', () => {
  it('keeps observed 0, not-reported and unsupported networks distinct (never 0 for missing)', async () => {
    const t = await analyticsTenant();
    const ig = await connection(t.workspaceId, t.brandId, 'instagram');
    const tg = await connection(t.workspaceId, t.brandId, 'telegram');
    const a = await publish(t, t.brandId, ig, 'instagram', '2026-10-05T10:00:00Z', { title: 'IG zero likes' });
    const tgPost = await publish(t, t.brandId, tg, 'telegram', '2026-10-05T11:00:00Z', { title: 'TG post' });
    await observe(a, [pt('views', 120), pt('reach', 90), pt('likes', 0)], '2026-10-06T09:00:00Z', [{ name: 'comments', reason: 'Not reported for this post' }]);
    const tab = await contentTable(t.ctx, filters({ from: '2026-10-01', to: '2026-10-31' }));
    const row = tab.rows.find((r) => r.delivery_id === a)!;
    const m = (name: string) => row.metrics.find((x) => x.native_metric === name)!;
    expect(m('likes')).toMatchObject({ value: 0, status: 'zero' });
    expect(m('comments')).toMatchObject({ value: null, status: 'unsupported' });
    expect(m('saved')).toMatchObject({ value: null, status: 'unsupported' }); // fetched OK, not returned ⇒ unsupported for this post
    expect(m('views')).toMatchObject({ value: 120, status: 'ok', basis: 'lifetime' });
    const tgRow = tab.rows.find((r) => r.delivery_id === tgPost)!;
    expect(tgRow.metrics).toEqual([]);
    const ov = await overview(t.ctx, filters({ from: '2026-10-01', to: '2026-10-31' }));
    const eng = ov.kpis.find((k) => k.measure === 'engagements')!;
    expect(eng.value).toBe(0); // the one IG post observed 0 likes
    expect(eng.health.coverage).toMatchObject({ selected: 2, eligible: 1, with_data: 1, unsupported: 1 });
    expect(eng.health.status).toBe('zero');
    expect(eng.health.reasons.some((r) => r.status === 'unsupported' && r.provider === 'telegram')).toBe(true);
    expect(eng.basis_label).toBe('Lifetime performance of posts published in this period');
    // An eligible post never fetched is "not fetched", not 0.
    const b = await publish(t, t.brandId, ig, 'instagram', '2026-10-07T10:00:00Z');
    const ov2 = await overview(t.ctx, filters({ from: '2026-10-07', to: '2026-10-07' }));
    const eng2 = ov2.kpis.find((k) => k.measure === 'engagements')!;
    expect(eng2.value).toBeNull();
    expect(eng2.health.status).toBe('not_fetched');
    const p = ov2.trend.combined!.points[0]!;
    expect(p).toMatchObject({ value: null, status: 'missing', eligible: 1, with_data: 0 });
    void b;
  });
});

describe('lifetime vs daily', () => {
  it('stores lifetime counters as as-of snapshots, never as daily buckets; observed changes are labelled separately', async () => {
    const t = await analyticsTenant();
    const x = await connection(t.workspaceId, t.brandId, 'x');
    const d = await publish(t, t.brandId, x, 'x', '2026-09-01T08:00:00Z', { format: 'text' });
    await observe(d, [pt('impression_count', 100), pt('like_count', 5)], '2026-09-02T08:00:00Z');
    expect(await count(`SELECT count(*) n FROM metric_daily_facts WHERE resource_id=$1`, [d])).toBe(0); // one snapshot ⇒ no fabricated history
    await observe(d, [pt('impression_count', 160), pt('like_count', 7)], '2026-09-03T08:00:00Z');
    expect(await count(`SELECT count(*) n FROM metric_daily_facts WHERE resource_id=$1 AND fact_kind='reported'`, [d])).toBe(0);
    expect(await count(`SELECT count(*) n FROM metric_cumulative_facts WHERE resource_id=$1 AND basis='lifetime'`, [d])).toBe(4);
    const ch = (await testPool().query(`SELECT value::int v, bucket_date::text FROM metric_daily_facts WHERE resource_id=$1 AND fact_kind='observed_change' AND metric_id='x.post.impression_count'`, [d])).rows;
    expect(ch).toEqual([{ v: 60, bucket_date: '2026-09-03' }]);
    const det = await contentDetail(t.ctx, d, { timezone: 'Europe/London' });
    const h = det.history.find((s) => s.metric_id === 'x.post.impression_count')!;
    expect(h.basis_label).toMatch(/Lifetime total as observed on each date \(not daily activity\)/);
    expect(h.points.map((p) => p.value)).toEqual([100, 160]);
    expect(h.observed_changes).toEqual([expect.objectContaining({ value: 60, date: '2026-09-03' })]);
    // The KPI for the publish day is the LATEST lifetime value (160), not 100 + 160.
    const ov = await overview(t.ctx, filters({ from: '2026-09-01', to: '2026-09-01' }), { measure: 'impressions' });
    expect(ov.trend.combined!.points[0]!.value).toBe(160);
  });
});

describe('engagement rate', () => {
  it('is Σ engagements ÷ Σ views over posts reporting BOTH (not an average of rates)', async () => {
    const t = await analyticsTenant();
    const ig = await connection(t.workspaceId, t.brandId, 'instagram');
    const bs = await connection(t.workspaceId, t.brandId, 'bluesky');
    const a = await publish(t, t.brandId, ig, 'instagram', '2026-08-03T10:00:00Z');
    const b = await publish(t, t.brandId, ig, 'instagram', '2026-08-04T10:00:00Z');
    const c = await publish(t, t.brandId, bs, 'bluesky', '2026-08-04T12:00:00Z', { format: 'text' });
    await observe(a, [pt('views', 100), pt('likes', 8), pt('comments', 2)], '2026-08-05T10:00:00Z');   // rate 0.10
    await observe(b, [pt('views', 300), pt('likes', 80), pt('saved', 10)], '2026-08-05T10:00:00Z');    // rate 0.30
    await observe(c, [pt('likeCount', 50)], '2026-08-05T10:00:00Z');                                   // no views ⇒ excluded from ER
    const ov = await overview(t.ctx, filters({ from: '2026-08-01', to: '2026-08-07' }));
    const er = ov.kpis.find((k) => k.measure === 'engagement_rate_views')!;
    expect(er.value).toBeCloseTo(100 / 400, 10); // 0.25, not (0.10 + 0.30) / 2 = 0.20
    expect(er.definition.combination).toBe('ratio_of_sums');
    expect(er.definition.components.some((x) => x.role === 'denominator' && x.native_metric === 'views')).toBe(true);
    expect(er.health.coverage).toMatchObject({ selected: 3, eligible: 2, with_data: 2, unsupported: 1 });
    const eng = ov.kpis.find((k) => k.measure === 'engagements')!;
    expect(eng.value).toBe(150); // 10 + 90 + 50 (Bluesky likes are engagements)
    expect(eng.by_network.find((n) => n.provider === 'bluesky')!.value).toBe(50);
  });
});

describe('date boundaries and DST (Europe/London)', () => {
  it('buckets by local publish date with 23/25-hour days and exact range edges', async () => {
    const t = await analyticsTenant();
    const ig = await connection(t.workspaceId, t.brandId, 'instagram');
    // 2026-03-29: clocks go forward at 01:00 GMT. 2026-10-25: clocks go back at 01:00 GMT.
    const posts = [
      ['2026-03-28T23:30:00Z', 1],  // 23:30 GMT 28 Mar
      ['2026-03-29T00:30:00Z', 2],  // 00:30 GMT 29 Mar (before the jump)
      ['2026-03-29T22:59:00Z', 4],  // 23:59 BST 29 Mar
      ['2026-03-29T23:00:00Z', 8],  // 00:00 BST 30 Mar
      ['2026-10-24T23:30:00Z', 16], // 00:30 BST 25 Oct
      ['2026-10-25T23:30:00Z', 32], // 23:30 GMT 25 Oct (25-hour day)
      ['2026-10-26T00:00:00Z', 64], // 00:00 GMT 26 Oct
    ] as const;
    for (const [at, likes] of posts) {
      const d = await publish(t, t.brandId, ig, 'instagram', at);
      await observe(d, [pt('likes', likes)], new Date(new Date(at).getTime() + 86_400_000));
    }
    const day = async (from: string, to = from) => (await overview(t.ctx, filters({ from, to, compare: 'none' }), { measure: 'likes' })).trend.combined!.points;
    expect((await day('2026-03-28')).map((p) => p.value)).toEqual([1]);
    expect((await day('2026-03-29')).map((p) => p.value)).toEqual([6]);
    expect((await day('2026-03-30')).map((p) => p.value)).toEqual([8]);
    expect((await day('2026-10-25')).map((p) => p.value)).toEqual([48]);
    expect((await day('2026-10-26')).map((p) => p.value)).toEqual([64]);
    const span = await overview(t.ctx, filters({ from: '2026-10-24', to: '2026-10-26', compare: 'none' }), { measure: 'likes' });
    expect(span.meta.period).toMatchObject({ start_utc: '2026-10-23T23:00:00.000Z', end_utc: '2026-10-27T00:00:00.000Z', days: 3 });
    expect(span.trend.combined!.points.map((p) => [p.date, p.value, p.status])).toEqual([
      ['2026-10-24', null, 'no_posts'], ['2026-10-25', 48, 'ok'], ['2026-10-26', 64, 'ok']]);
    // Same answer through the per-post path (format filter forces it) as through the cached rollups.
    const viaPosts = await overview(t.ctx, filters({ from: '2026-10-24', to: '2026-10-26', compare: 'none', formats: ['image'] }), { measure: 'likes' });
    expect(viaPosts.trend.combined!.points.map((p) => p.value)).toEqual([null, 48, 64]);
    // A non-London timezone shifts the same instants.
    const ny = await overview(t.ctx, filters({ from: '2026-03-29', to: '2026-03-29', timezone: 'America/New_York', compare: 'none' }), { measure: 'likes' });
    expect(ny.trend.combined!.points[0]!.value).toBe(12); // 22:59Z and 23:00Z are 18:59/19:00 EDT on 29 Mar; 00:30Z is 28 Mar EDT
  });
});

describe('comparisons', () => {
  it('baseline zero ⇒ "new"; baseline missing ⇒ "insufficient"; otherwise a defined change', async () => {
    const t = await analyticsTenant();
    const ig = await connection(t.workspaceId, t.brandId, 'instagram');
    const prev = await publish(t, t.brandId, ig, 'instagram', '2026-07-05T10:00:00Z');
    const cur = await publish(t, t.brandId, ig, 'instagram', '2026-07-12T10:00:00Z');
    await observe(prev, [pt('views', 10), pt('likes', 0)], '2026-07-06T10:00:00Z');
    await observe(cur, [pt('views', 50), pt('likes', 5)], '2026-07-13T10:00:00Z');
    const ov = await overview(t.ctx, filters({ from: '2026-07-08', to: '2026-07-14' }));
    const eng = ov.kpis.find((k) => k.measure === 'engagements')!;
    expect(eng.comparison).toMatchObject({ current: 5, previous: 0, state: 'new', change_pct: null });
    expect(ov.meta.previous_period).toMatchObject({ from: '2026-07-01', to: '2026-07-07' });
    const posts = ov.kpis.find((k) => k.measure === 'posts_published')!;
    expect(posts.comparison).toMatchObject({ current: 1, previous: 1, state: 'flat', change_pct: 0 });
    // previous period without data at all ⇒ insufficient (never ∞%).
    const ov2 = await overview(t.ctx, filters({ from: '2026-07-12', to: '2026-07-12' }));
    expect(ov2.kpis.find((k) => k.measure === 'engagements')!.comparison.state).toBe('insufficient');
    expect(ov.insights.some((i) => i.kind === 'calculated' && /previous period/.test(i.text))).toBe(true);
  });
});

describe('late corrections and retries', () => {
  it('upserts on the fact key: retries do not duplicate, corrections update facts and aggregates, older data never overwrites newer', async () => {
    const t = await analyticsTenant();
    const fb = await connection(t.workspaceId, t.brandId, 'facebook');
    const d = await publish(t, t.brandId, fb, 'facebook', '2026-06-01T09:00:00Z');
    const r1 = await observe(d, [pt('post_media_view', 500), pt('post_reactions_by_type_total', 20, 'lifetime', 'like'), pt('post_reactions_by_type_total', 5, 'lifetime', 'love')], '2026-06-02T09:00:00Z');
    expect(r1).toMatchObject({ written: 3, unchanged: 0 });
    const retry = await observe(d, [pt('post_media_view', 500), pt('post_reactions_by_type_total', 20, 'lifetime', 'like'), pt('post_reactions_by_type_total', 5, 'lifetime', 'love')], '2026-06-02T09:00:00Z');
    expect(retry).toMatchObject({ written: 0, unchanged: 3 });
    expect(await count(`SELECT count(*) n FROM metric_observations WHERE resource_id=$1`, [d])).toBe(3);
    // Same as-of day, later read with a provider correction (reactions went DOWN: spam removed).
    const fix = await observe(d, [pt('post_media_view', 520), pt('post_reactions_by_type_total', 12, 'lifetime', 'like'), pt('post_reactions_by_type_total', 5, 'lifetime', 'love')], '2026-06-02T15:00:00Z');
    expect(fix).toMatchObject({ written: 2, unchanged: 1, corrections: 1 });
    expect(await count(`SELECT count(*) n FROM metric_observations WHERE resource_id=$1`, [d])).toBe(3);
    const o = (await testPool().query(`SELECT revision, previous_value::int pv, value::int v FROM metric_observations WHERE resource_id=$1 AND dimension='like'`, [d])).rows[0];
    expect(o).toEqual({ revision: 2, pv: 20, v: 12 });
    // A late, OLDER observation for the same fact is ignored.
    const stale = await observe(d, [pt('post_reactions_by_type_total', 99, 'lifetime', 'like')], '2026-06-02T10:00:00Z');
    expect(stale).toMatchObject({ written: 0, unchanged: 1 });
    const roll = (await testPool().query(`SELECT value_sum::int v, resources FROM metric_rollups WHERE connection_id=$1 AND metric_key='_derived.engagements'`, [fb])).rows;
    expect(roll).toEqual([{ v: 17, resources: 1 }]);
    const ov = await overview(t.ctx, filters({ from: '2026-06-01', to: '2026-06-01' }));
    expect(ov.kpis.find((k) => k.measure === 'engagements')!.value).toBe(17);
    expect((await contentDetail(t.ctx, d)).corrections).toBe(2);
  });
});

describe('incompatible measures', () => {
  it('never combines views + impressions, nor unique reach across accounts/networks', async () => {
    const t = await analyticsTenant();
    const ig = await connection(t.workspaceId, t.brandId, 'instagram');
    const fb = await connection(t.workspaceId, t.brandId, 'facebook');
    const x = await connection(t.workspaceId, t.brandId, 'x');
    const a = await publish(t, t.brandId, ig, 'instagram', '2026-05-04T10:00:00Z');
    const b = await publish(t, t.brandId, fb, 'facebook', '2026-05-04T11:00:00Z');
    const c = await publish(t, t.brandId, x, 'x', '2026-05-04T12:00:00Z', { format: 'text' });
    await observe(a, [pt('views', 100), pt('reach', 80)], '2026-05-05T10:00:00Z');
    await observe(b, [pt('post_media_view', 200), pt('post_total_media_view_unique', 150)], '2026-05-05T10:00:00Z');
    await observe(c, [pt('impression_count', 1000)], '2026-05-05T10:00:00Z');
    const f = filters({ from: '2026-05-04', to: '2026-05-04', compare: 'none' });
    const reach = await overview(t.ctx, f, { measure: 'reach' });
    expect(reach.trend.combined).toBeNull();
    expect(reach.trend.combined_reason).toMatch(/not combined across accounts or networks/);
    expect(reach.trend.by_network.map((s) => s.total).sort()).toEqual([150, 80]);
    const views = await overview(t.ctx, f, { measure: 'views' });
    expect(views.trend.combined!.total).toBe(300); // IG views + FB views (labelled), X impressions NOT included
    expect(views.trend.combined!.label).toMatch(/definitions differ/);
    expect(views.trend.definition.components.map((x) => x.provider).sort()).toEqual(['facebook', 'instagram']);
    const imp = await overview(t.ctx, f, { measure: 'impressions' });
    expect(imp.trend.combined!.total).toBe(1000);
    expect(views.channels.excluded.map((e) => e.provider)).toEqual(['x']);
  });
});

describe('coverage and freshness follow the query scope', () => {
  it('counts only the selected accounts and reports the through-date', async () => {
    const t = await analyticsTenant();
    const ig1 = await connection(t.workspaceId, t.brandId, 'instagram', { name: 'IG one' });
    const ig2 = await connection(t.workspaceId, t.brandId, 'instagram', { name: 'IG two' });
    const a = await publish(t, t.brandId, ig1, 'instagram', '2026-04-06T10:00:00Z');
    await publish(t, t.brandId, ig2, 'instagram', '2026-04-06T11:00:00Z');
    await observe(a, [pt('views', 10), pt('likes', 3)], '2026-04-08T10:00:00Z');
    const all = await overview(t.ctx, filters({ from: '2026-04-06', to: '2026-04-06', compare: 'none' }));
    const engAll = all.kpis.find((k) => k.measure === 'engagements')!;
    expect(engAll.health.coverage).toMatchObject({ selected: 2, eligible: 2, with_data: 1, ratio: 0.5 });
    expect(engAll.health.status).toBe('partial_coverage');
    const one = await overview(t.ctx, filters({ from: '2026-04-06', to: '2026-04-06', compare: 'none', connection_ids: [ig1] }));
    const engOne = one.kpis.find((k) => k.measure === 'engagements')!;
    expect(engOne.health.coverage).toMatchObject({ selected: 1, eligible: 1, with_data: 1, ratio: 1 });
    expect(engOne.health.status).toBe('ok');
    // through = observed_at − Instagram's 24 h reporting delay
    expect(engOne.health.freshness).toMatchObject({ observed_to: '2026-04-08T10:00:00.000Z', through: '2026-04-07T10:00:00.000Z', through_date: '2026-04-07' });
    expect(one.meta.scope.accounts.map((x) => x.connection_id)).toEqual([ig1]);
  });
});

describe('rollups', () => {
  it('cached 15-minute rollups equal the per-post aggregation', async () => {
    const t = await analyticsTenant();
    const ig = await connection(t.workspaceId, t.brandId, 'instagram');
    for (let i = 0; i < 6; i++) {
      const d = await publish(t, t.brandId, ig, 'instagram', new Date(Date.UTC(2026, 2, 1, 3 + i * 4, 7 * i)));
      await observe(d, [pt('views', 100 + i), pt('likes', i), pt('comments', 1)], '2026-03-05T10:00:00Z');
    }
    const scope = await resolveScope(t.ctx, filters({ from: '2026-03-01', to: '2026-03-02', timezone: 'Asia/Kolkata' }));
    const key = (a: { connection_id: string; local_date: string; metric_key: string; dimension: string; value: number; resources: number }) => `${a.connection_id}|${a.local_date}|${a.metric_key}|${a.dimension}|${a.value}|${a.resources}`;
    const viaRollup = (await aggregate(scope, scope.period)).map(key).sort();
    const viaPosts = (await aggregate(scope, scope.period, { forcePerPost: true })).map(key).sort();
    expect(viaRollup.length).toBeGreaterThan(5);
    expect(viaRollup).toEqual(viaPosts);
  });
});

describe('views: channels, video, audience, best time', () => {
  it('serves native channel metrics, video ratio-of-sums and honest audience/best-time states', async () => {
    const t = await analyticsTenant();
    const yt = await connection(t.workspaceId, t.brandId, 'youtube');
    const tt = await connection(t.workspaceId, t.brandId, 'tiktok');
    const v1 = await publish(t, t.brandId, yt, 'youtube', '2026-02-02T10:00:00Z', { format: 'video' });
    const v2 = await publish(t, t.brandId, yt, 'youtube', '2026-02-03T10:00:00Z', { format: 'video' });
    const v3 = await publish(t, t.brandId, tt, 'tiktok', '2026-02-03T12:00:00Z', { format: 'video' });
    await observe(v1, [pt('views', 100, '2026-02-02..2026-02-10', null, '2026-02-10'), pt('estimatedMinutesWatched', 50, '2026-02-02..2026-02-10', null, '2026-02-10'), pt('averageViewDuration', 30, '2026-02-02..2026-02-10', null, '2026-02-10')], '2026-02-10T12:00:00Z');
    await observe(v2, [pt('views', 300, '2026-02-03..2026-02-10', null, '2026-02-10'), pt('estimatedMinutesWatched', 50, '2026-02-03..2026-02-10', null, '2026-02-10')], '2026-02-10T12:00:00Z');
    await observe(v3, [pt('view_count', 900), pt('like_count', 9)], '2026-02-10T12:00:00Z');
    const f = filters({ from: '2026-02-01', to: '2026-02-07', compare: 'none' });
    const v = await video(t.ctx, f);
    const yb = v.by_network.find((n) => n.provider === 'youtube')!;
    expect(yb.avg_view_duration_seconds).toBeCloseTo((100 * 60) / 400, 10); // Σ watch seconds ÷ Σ views = 15 s (not avg of 30 and 10)
    expect(yb.watch_time_minutes).toBe(100);
    expect(yb.retention.status).toBe('not_fetched');
    expect(v.by_network.find((n) => n.provider === 'tiktok')!.retention.status).toBe('unsupported');
    expect(v.totals.find((x) => x.measure === 'views')!.value).toBe(1300);
    // YouTube window starting on the publish day ⇒ lifetime basis
    expect(await count(`SELECT count(*) n FROM metric_cumulative_facts WHERE resource_id=$1 AND basis='lifetime'`, [v1])).toBe(3);
    const ch = await channels(t.ctx, f);
    const ytRow = ch.rows.find((r) => r.provider === 'youtube')!;
    expect(ytRow.posts_published).toBe(2);
    expect(ytRow.metrics.find((m) => m.native_metric === 'views')!.value).toBe(400);
    expect(ytRow.metrics.find((m) => m.native_metric === 'averageViewDuration')!.value).toBeNull(); // ratio metric never summed
    expect(ytRow.followers.status).toBe('not_fetched');
    const aud = await audience(t.ctx, f);
    expect(aud.accounts.find((a) => a.provider === 'youtube')!.state).toBe('not_fetched');
    expect(aud.accounts.find((a) => a.provider === 'tiktok')!.state).toBe('unsupported');
    const bt = await bestTime(t.ctx, f);
    expect(bt).toMatchObject({ status: 'insufficient_data', slots: [], timezone: 'Europe/London' });
    expect(bt.sample_size).toBeLessThan(bt.required_sample);
  });
});

describe('demo fixtures and tenant isolation', () => {
  it('synthetic demo data never appears in live queries; demo dataset only in demo workspaces', async () => {
    const t = await analyticsTenant({ isDemo: true });
    const demo = await seedAnalyticsDemo({ workspaceId: t.workspaceId, anchor: '2026-10-31', days: 21, postsPerDay: 1 });
    expect(demo.posts).toBeGreaterThan(100);
    const ctx = await v2Ctx(t.owner.id, t.workspaceId);
    const live = await overview(ctx, filters({ from: '2026-10-11', to: '2026-10-31' }));
    expect(live.kpis.find((k) => k.measure === 'posts_published')!.value).toBe(0);
    expect(live.meta.scope.accounts).toEqual([]);
    expect(live.top_content).toEqual([]);
    const d = await overview(ctx, filters({ from: '2026-10-11', to: '2026-10-31', dataset: 'demo' }));
    expect(d.meta.synthetic).toBe(true);
    expect(d.kpis.find((k) => k.measure === 'posts_published')!.value).toBeGreaterThan(100);
    expect(d.kpis.find((k) => k.measure === 'engagements')!.value).toBeGreaterThan(0);
    expect(d.kpis.some((k) => k.measure === 'followers')).toBe(true);
    expect(d.top_content[0]!.thumbnail.kind).toBe('synthetic');
    expect(d.data_health.notes[0]).toMatch(/Synthetic demo data/);
    const aud = await audience(ctx, filters({ from: '2026-10-11', to: '2026-10-31', dataset: 'demo' }));
    const igA = aud.accounts.find((a) => a.provider === 'instagram')!;
    expect(igA.state).toBe('available');
    expect(igA.breakdowns[0]!.buckets.map((b) => b.key)).not.toContain('IS'); // tiny bucket suppressed
    expect(igA.breakdowns[0]!.suppressed).toBeGreaterThan(0);
    // Deterministic: re-seeding yields the same values.
    const again = await seedAnalyticsDemo({ workspaceId: t.workspaceId, anchor: '2026-10-31', days: 21, postsPerDay: 1 });
    expect(again.points).toBe(demo.points);
    const d2 = await overview(ctx, filters({ from: '2026-10-11', to: '2026-10-31', dataset: 'demo' }));
    expect(d2.kpis.map((k) => k.value)).toEqual(d.kpis.map((k) => k.value));
    // Non-demo workspace: demo dataset refused.
    const other = await analyticsTenant({ isDemo: false });
    await expect(overview(other.ctx, filters({ from: '2026-10-11', to: '2026-10-31', dataset: 'demo' }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(seedAnalyticsDemo({ workspaceId: other.workspaceId, anchor: '2026-10-31', days: 3 })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('cross-tenant ids are not found; brand-scoped analysts see only their brands', async () => {
    const a = await analyticsTenant();
    const b = await analyticsTenant();
    const igB = await connection(b.workspaceId, b.brandId, 'instagram');
    const postB = await publish(b, b.brandId, igB, 'instagram', '2026-10-05T10:00:00Z');
    await observe(postB, [pt('views', 5), pt('likes', 1)], '2026-10-06T10:00:00Z');
    await expect(overview(a.ctx, filters({ from: '2026-10-01', to: '2026-10-31', brand_ids: [b.brandId] }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(overview(a.ctx, filters({ from: '2026-10-01', to: '2026-10-31', connection_ids: [igB] }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(contentDetail(a.ctx, postB)).rejects.toMatchObject({ code: 'not_found' });
    // Analyst with a grant on brand A2 only.
    const brandA2 = await createBrand(a.workspaceId, 'Brand A2');
    const igA = await connection(a.workspaceId, a.brandId, 'instagram');
    const igA2 = await connection(a.workspaceId, brandA2, 'instagram');
    const p1 = await publish(a, a.brandId, igA, 'instagram', '2026-10-05T10:00:00Z');
    const p2 = await publish(a, brandA2, igA2, 'instagram', '2026-10-05T10:00:00Z');
    await observe(p1, [pt('likes', 7)], '2026-10-06T10:00:00Z');
    await observe(p2, [pt('likes', 11)], '2026-10-06T10:00:00Z');
    const analyst = await createUser();
    await addMember(a.workspaceId, analyst.id, 'viewer', [brandA2]);
    await grant(a.workspaceId, analyst.id, 'analyst', brandA2);
    const actx = await v2Ctx(analyst.id, a.workspaceId);
    const ov = await overview(actx, filters({ from: '2026-10-01', to: '2026-10-31' }));
    expect(ov.meta.scope.brands.map((x) => x.id)).toEqual([brandA2]);
    expect(ov.kpis.find((k) => k.measure === 'engagements')!.value).toBe(11);
    await expect(overview(actx, filters({ from: '2026-10-01', to: '2026-10-31', brand_ids: [a.brandId] }))).rejects.toMatchObject({ code: 'not_found' });
    // A viewer without analytics.read is refused.
    const viewer = await createUser();
    await addMember(a.workspaceId, viewer.id, 'viewer');
    await expect(overview(await v2Ctx(viewer.id, a.workspaceId), filters({ from: '2026-10-01', to: '2026-10-31' }))).rejects.toMatchObject({ code: 'forbidden' });
  });
});
