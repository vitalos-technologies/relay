// V3.1 PERF: precomputed per-local-day analytics summary (migration 025, metric_rollup_days) must equal the
// 15-minute rollup aggregate it replaces — across DST changes and :30/:45 offsets, under incremental maintenance by
// every writer (rebuild, real ingest), with datasets (provider / simulated / synthetic) never mixing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilters } from '@social-lite/core/contracts/analytics';
import { bulkLoadSynthetic, seedAnalyticsDemo } from '@social-lite/services/analytics/demo';
import { aggregate, overview, resolveScope, type Agg } from '@social-lite/services/analytics/query';
import { backfillSummaryZones, summaryReady } from '@social-lite/services/analytics/summary';
import { definitionsFor } from '@social-lite/services/analytics/registry';
import type { Ctx } from '@social-lite/services';
import { closeTestPool, testPool } from './helpers.js';
import { analyticsTenant, connection, filters, observe, pt, publish } from './v3-analytics-helpers.js';

const db = () => testPool();
beforeAll(() => { testPool(); });
afterAll(closeTestPool);

const ZONES = ['Europe/London', 'America/New_York', 'Asia/Kathmandu', 'America/St_Johns', 'Australia/Lord_Howe', 'America/Santiago'];

const key = (a: Pick<Agg, 'connection_id' | 'local_date' | 'metric_key' | 'definition_version' | 'dimension'>) => [a.connection_id, a.local_date, a.metric_key, a.definition_version, a.dimension].join('|');
const norm = (xs: Agg[]) => xs.map((a) => ({ ...a, min_through: a.min_through?.toISOString() ?? null, min_observed: a.min_observed?.toISOString() ?? null,
  max_observed: a.max_observed?.toISOString() ?? null })).sort((x, y) => key(x).localeCompare(key(y)));

async function both(ctx: Ctx, f: AnalyticsFilters) {
  const sc = await resolveScope(ctx, f);
  return { rollups: norm(await aggregate(sc, sc.period, { forceRollups: true })), summary: norm(await aggregate(sc, sc.period)), ready: await summaryReady(sc.workspaceId, f.timezone) };
}

// Drain every pending zone. The test database is shared by all integration files, so earlier files leave zones with no
// rollups (cells = 0 but still made ready): keep going until a call makes no progress at all.
async function backfillAll() {
  for (let i = 0; i < 1_000; i++) {
    const r = await backfillSummaryZones({ maxCells: 10_000 });
    if (r.ready === 0 && r.cells === 0) return;
  }
}

const strip = (o: unknown) => JSON.stringify(o).replace(/"generated_at":"[^"]+"/g, '');

describe('per-day analytics summary', () => {
  it('equals the rollup aggregate in every tracked zone, incl. DST days and :30/:45 offsets; overview output is identical', async () => {
    const t = await analyticsTenant({ isDemo: true });
    // Synthetic history across both 2026 DST changes (Europe: Mar 29 / Oct 25; US: Mar 8 / Nov 1; Santiago, Lord Howe: own rules).
    await seedAnalyticsDemo({ workspaceId: t.workspaceId, anchor: '2026-11-05', days: 260, postsPerDay: 0.6, providers: ['facebook', 'x'] }); // (no instagram reach rows: v3-analytics' registry test expects none)
    // Zones added AFTER the data exists (e.g. a brand switches time zone): the backfill must produce them completely.
    for (const tz of ZONES) await db().query(`INSERT INTO metric_summary_zones(workspace_id, tz) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t.workspaceId, tz]);
    expect(await summaryReady(t.workspaceId, 'Asia/Kathmandu')).toBe(false); // pending until backfilled → rollups path
    await backfillAll();
    const ranges: Array<[string, string]> = [['2026-03-01', '2026-04-10'], ['2026-10-20', '2026-11-05'], ['2026-02-20', '2026-11-05']];
    for (const tz of ZONES) for (const [from, to] of ranges) {
      const r = await both(t.ctx, filters({ timezone: tz, from, to, dataset: 'demo' }));
      expect(r.ready).toBe(true);
      expect(r.summary.length).toBeGreaterThan(0);
      expect(r.summary).toEqual(r.rollups);
    }
    // Totals + key filter used by the overview equal the sum of the per-day rows (whole overview identical).
    for (const tz of ['Europe/London', 'Asia/Kathmandu']) for (const measure of [null, 'views', 'engagement_rate_views']) {
      const f = filters({ timezone: tz, from: '2026-02-20', to: '2026-11-05', dataset: 'demo' });
      expect(strip(await overview(t.ctx, f, { measure }))).toEqual(strip(await overview(t.ctx, f, { measure, reference: true })));
    }
  }, 300_000);

  it('is maintained incrementally by the real ingest path and stays dataset-isolated (live vs simulated vs demo)', async () => {
    const t = await analyticsTenant();
    await db().query(`UPDATE brands SET timezone='America/New_York' WHERE id=$1`, [t.brandId]); // tracked via trigger
    const live = await connection(t.workspaceId, t.brandId, 'instagram');
    const sim = await connection(t.workspaceId, t.brandId, 'instagram', { mock: true });
    const a = await publish(t, t.brandId, live, 'instagram', '2026-03-29T00:30:00Z'); // Europe/London DST morning
    const b = await publish(t, t.brandId, sim, 'instagram', '2026-03-29T00:30:00Z', { mock: true });
    await backfillAll();
    expect((await db().query(`SELECT tz, status FROM metric_summary_zones WHERE workspace_id=$1 ORDER BY tz`, [t.workspaceId])).rows)
      .toEqual([{ tz: 'America/New_York', status: 'ready' }, { tz: 'Europe/London', status: 'ready' }]);
    // Ingest AFTER the zones are ready: only the triggers keep the summary current.
    await observe(a, [pt('views', 120), pt('likes', 7), pt('comments', 2)], '2026-03-30T09:00:00Z');
    await observe(b, [pt('views', 999), pt('likes', 99)], '2026-03-30T09:00:00Z');
    await observe(a, [pt('views', 150), pt('likes', 9), pt('comments', 3)], '2026-03-31T09:00:00Z'); // correction / growth
    for (const tz of ['Europe/London', 'America/New_York']) {
      const liveR = await both(t.ctx, filters({ timezone: tz, from: '2026-03-20', to: '2026-04-05', dataset: 'live' }));
      const simR = await both(t.ctx, filters({ timezone: tz, from: '2026-03-20', to: '2026-04-05', dataset: 'simulated' }));
      expect(liveR.summary).toEqual(liveR.rollups);
      expect(simR.summary).toEqual(simR.rollups);
      expect(liveR.summary.every((x) => x.connection_id === live)).toBe(true);
      expect(simR.summary.every((x) => x.connection_id === sim)).toBe(true);
      const views = (rows: Array<Pick<Agg, 'metric_key' | 'value'>>) => rows.filter((x) => x.metric_key === '_family.views').reduce((s, x) => s + x.value, 0);
      expect(views(liveR.summary)).toBe(150);
      expect(views(simR.summary)).toBe(999);
    }
    // The 00:30 UTC publication is the 29th in London (01:30 BST) and the 28th in New York (20:30 EDT).
    const london = await both(t.ctx, filters({ timezone: 'Europe/London', from: '2026-03-20', to: '2026-04-05', dataset: 'live' }));
    const ny = await both(t.ctx, filters({ timezone: 'America/New_York', from: '2026-03-20', to: '2026-04-05', dataset: 'live' }));
    expect([...new Set(london.summary.map((x) => x.local_date))]).toEqual(['2026-03-29']);
    expect([...new Set(ny.summary.map((x) => x.local_date))]).toEqual(['2026-03-28']);
    // Deleting a connection removes its summary rows (cascade) — nothing stale remains.
    await db().query(`DELETE FROM posts WHERE id IN (SELECT post_id FROM deliveries WHERE connection_id=$1)`, [sim]);
    await db().query(`DELETE FROM connections WHERE id=$1`, [sim]);
    expect(Number((await db().query(`SELECT count(*) n FROM metric_rollup_days WHERE connection_id=$1`, [sim])).rows[0].n)).toBe(0);
  });

  it('a rebuild (bulk reload) keeps it equal; demo rows never appear in live queries', async () => {
    const t = await analyticsTenant({ isDemo: true });
    const demo = await seedAnalyticsDemo({ workspaceId: t.workspaceId, anchor: '2026-11-05', days: 20, postsPerDay: 1, providers: ['facebook'] });
    await backfillAll();
    const post = (await db().query<{ id: string; published_at: Date }>(`SELECT id, published_at FROM deliveries WHERE connection_id=$1 ORDER BY published_at LIMIT 1`, [demo.connectionIds[0]])).rows[0]!;
    const def = definitionsFor('facebook').find((d) => d.scope !== 'account' && d.fetched && d.dimensionKey == null && d.aggregation !== 'ratio_of_sums')!;
    await bulkLoadSynthetic([{ workspaceId: t.workspaceId, brandId: demo.brandId, connectionId: demo.connectionIds[0]!, provider: 'facebook', resourceType: 'post',
      resourceId: post.id, def, dimension: '', value: 123_456, observedAt: new Date('2026-11-06T00:00:00Z'), publishedAt: post.published_at }]);
    const f = filters({ timezone: 'Europe/London', from: '2026-10-15', to: '2026-11-05', dataset: 'demo' });
    const r = await both(t.ctx, f);
    expect(r.summary).toEqual(r.rollups);
    expect(r.summary.some((x) => x.metric_key === def.id && x.value >= 123_456)).toBe(true);
    const liveR = await both(t.ctx, { ...f, dataset: 'live' });
    expect(liveR.summary).toEqual([]);
    expect(liveR.rollups).toEqual([]);
  });
});
