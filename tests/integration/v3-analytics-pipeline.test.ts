// V3 analytics pipeline + reports (real PostgreSQL + local S3; provider transports are labelled test fakes):
// sync runs/cursors (checkpoints, idempotent job keys, retries without duplicates, cadence), revoked access stops sync
// and exports, per-workspace concurrency, publishing priority, legacy backfill (unsupported never becomes 0),
// saved views with access re-checked on open, CSV/HTML/PDF exports that match filters + authorization, CSV injection.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { AdapterContext, HttpRequest, HttpResponse } from '@social-lite/core';
import type { AnalyticsDeps } from '@social-lite/services/analytics/index';
import { ensureSyncCursors, runConnectionSync } from '@social-lite/services/analytics/sync';
import { backfillLegacySnapshots } from '@social-lite/services/analytics/backfill';
import { contentTable } from '@social-lite/services/analytics/query';
import { createReport, downloadReportExport, getReportExport, listReports, openReport, requestReportExport, runReportExport } from '@social-lite/services/analytics/reports';
import { clearReportExporters, registerReportExporter } from '@social-lite/services/analytics/exporters';
import { purgeAnalyticsRetention } from '@social-lite/services/analytics/retention';
import { addMember, closeTestPool, createBrand, createUser, grant, testPool, v2Ctx } from './helpers.js';
import { analyticsTenant, connection, count, filters, observe, publish, pt } from './v3-analytics-helpers.js';

afterAll(closeTestPool);
afterEach(() => { delete process.env.ANALYTICS_WORKSPACE_CONCURRENCY; delete process.env.ANALYTICS_YIELD_DUE_DELIVERIES; clearReportExporters(); });

const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

function fakeDeps(handler: (req: HttpRequest, n: number) => HttpResponse | Promise<HttpResponse>) {
  const calls: HttpRequest[] = [];
  const deps: AnalyticsDeps = {
    getCredentials: async (connectionId) => {
      const c = (await testPool().query(`SELECT * FROM connections WHERE id=$1`, [connectionId])).rows[0];
      return { credentials: { kind: 'meta_page' as const, pageAccessToken: 'page-token' },
        connection: { id: c.id, provider: c.provider, providerAccountId: c.provider_account_id, displayName: c.display_name, metadata: {}, isMock: c.is_mock } };
    },
    adapterContext: async () => ({ transport: { mode: 'live', send: async (req: HttpRequest) => { calls.push(req); return handler(req, calls.length); } }, now: () => new Date(), config: { apiVersion: 'v26.0' } }) as AdapterContext,
  };
  return { deps, calls };
}

const igInsights = (views: number, likes: number) => json(200, { data: [
  { name: 'views', period: 'lifetime', values: [{ value: views }] }, { name: 'reach', period: 'lifetime', values: [{ value: Math.round(views * 0.7) }] },
  { name: 'likes', period: 'lifetime', values: [{ value: likes }] }, { name: 'comments', period: 'lifetime', values: [{ value: 1 }] },
] });

const recent = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);

describe('sync runs and cursors', () => {
  it('checkpoints, never duplicates on retries, honours job keys and the refresh cadence', async () => {
    const t = await analyticsTenant();
    const ig = await connection(t.workspaceId, t.brandId, 'instagram');
    const posts = [await publish(t, t.brandId, ig, 'instagram', recent(30)), await publish(t, t.brandId, ig, 'instagram', recent(20)), await publish(t, t.brandId, ig, 'instagram', recent(10))];
    expect((await ensureSyncCursors({ workspaceId: t.workspaceId })).created).toBe(1);
    const { deps, calls } = fakeDeps(() => igInsights(100, 7));
    const s1 = await runConnectionSync(ig, deps, { jobKey: 'job-1', maxItems: 2 });
    expect(s1).toMatchObject({ status: 'partial', processed: 2, written: 8 });
    const cur = (await testPool().query(`SELECT cursor, lease_owner FROM sync_cursors WHERE connection_id=$1`, [ig])).rows[0];
    expect(cur.cursor.id).toBe(posts[1]); // checkpoint after the second item
    expect(cur.lease_owner).toBeNull();
    expect(await runConnectionSync(ig, deps, { jobKey: 'job-1' })).toMatchObject({ status: 'skipped', stopReason: 'duplicate_job' });
    const s2 = await runConnectionSync(ig, deps, { jobKey: 'job-2' });
    expect(s2).toMatchObject({ status: 'succeeded', processed: 1 });
    expect(calls).toHaveLength(3);
    // Nothing due now (young posts: next read in 6 h) ⇒ a new pass reads nothing.
    expect(await runConnectionSync(ig, deps, { jobKey: 'job-3' })).toMatchObject({ processed: 0, status: 'succeeded' });
    // Force a retry of everything: same values ⇒ zero new rows.
    await testPool().query(`UPDATE data_coverage SET next_attempt_at=now() - interval '1 minute' WHERE connection_id=$1 AND metric_id='*'`, [ig]);
    const before = await count(`SELECT count(*) n FROM metric_observations WHERE connection_id=$1`, [ig]);
    const s4 = await runConnectionSync(ig, deps, { jobKey: 'job-4' });
    expect(s4).toMatchObject({ processed: 3, written: 0, unchanged: 12 });
    expect(await count(`SELECT count(*) n FROM metric_observations WHERE connection_id=$1`, [ig])).toBe(before);
    const runs = (await testPool().query(`SELECT status, items_processed FROM sync_runs WHERE connection_id=$1 ORDER BY started_at`, [ig])).rows;
    expect(runs.map((r) => r.status)).toEqual(['partial', 'succeeded', 'succeeded', 'succeeded']);
    const next = (await testPool().query(`SELECT next_attempt_at FROM data_coverage WHERE resource_id=$1 AND metric_id='*'`, [posts[0]])).rows[0].next_attempt_at;
    expect(next.getTime() - Date.now()).toBeGreaterThan(5 * 3_600_000); // young post: every 6 h
  });

  it('rate limits stop the run with a retry time; failures back off; permission errors are recorded, not zeros', async () => {
    const t = await analyticsTenant();
    const ig = await connection(t.workspaceId, t.brandId, 'instagram');
    const a = await publish(t, t.brandId, ig, 'instagram', recent(40));
    await publish(t, t.brandId, ig, 'instagram', recent(30));
    await ensureSyncCursors({ workspaceId: t.workspaceId });
    const { deps } = fakeDeps((_req, n) => (n === 1 ? json(403, { error: { code: 10, message: '(#10) permission', type: 'OAuthException' } })
      : json(400, { error: { code: 4, message: 'Application request limit reached', type: 'OAuthException' } }, { 'retry-after': '120' })));
    const s = await runConnectionSync(ig, deps, { jobKey: randomUUID() });
    expect(s).toMatchObject({ status: 'partial', stopReason: 'rate_limited', processed: 2 });
    expect((await testPool().query(`SELECT status FROM data_coverage WHERE resource_id=$1 AND metric_id='*'`, [a])).rows[0].status).toBe('permission_missing');
    expect(await count(`SELECT count(*) n FROM metric_observations WHERE connection_id=$1`, [ig])).toBe(0);
    const c = (await testPool().query(`SELECT next_run_at FROM sync_cursors WHERE connection_id=$1`, [ig])).rows[0];
    expect(c.next_run_at.getTime()).toBeGreaterThan(Date.now() + 50_000);
    const ov = (await contentTable(t.ctx, filters({ from: '2026-01-01', to: new Date().toISOString().slice(0, 10) }))).rows.find((r) => r.delivery_id === a)!;
    expect(ov.metrics.every((m) => m.value === null && m.status === 'permission_missing')).toBe(true);
  });

  it('revoked access stops sync before and during a run; reconnect resumes it', async () => {
    const t = await analyticsTenant();
    const ig = await connection(t.workspaceId, t.brandId, 'instagram');
    for (let i = 0; i < 3; i++) await publish(t, t.brandId, ig, 'instagram', recent(50 - i));
    await ensureSyncCursors({ workspaceId: t.workspaceId });
    // Revoked mid-run: the account is disconnected after the first provider call.
    const { deps, calls } = fakeDeps(async (_r, n) => {
      if (n === 1) await testPool().query(`UPDATE connections SET status='disconnected', disconnected_at=now() WHERE id=$1`, [ig]);
      return igInsights(10, 1);
    });
    const s = await runConnectionSync(ig, deps, { jobKey: randomUUID() });
    expect(s).toMatchObject({ status: 'cancelled', stopReason: 'access_revoked', processed: 1 });
    expect(calls).toHaveLength(1);
    expect((await testPool().query(`SELECT status, stop_reason FROM sync_cursors WHERE connection_id=$1`, [ig])).rows[0]).toEqual({ status: 'stopped', stop_reason: 'access_revoked' });
    expect(await runConnectionSync(ig, deps, { jobKey: randomUUID() })).toMatchObject({ status: 'skipped', stopReason: 'access_revoked' });
    expect(calls).toHaveLength(1);
    // Reconnect ⇒ cursor reactivated by the evaluator.
    await testPool().query(`UPDATE connections SET status='ready', disconnected_at=NULL WHERE id=$1`, [ig]);
    expect((await ensureSyncCursors({ workspaceId: t.workspaceId })).reactivated).toBe(1);
    await testPool().query(`UPDATE connections SET status='reconnect_required' WHERE id=$1`, [ig]);
    expect(await runConnectionSync(ig, deps, { jobKey: randomUUID() })).toMatchObject({ status: 'skipped', stopReason: 'reconnect_required' });
    // Telegram never syncs (unsupported), and data of a long-disconnected account is purged by retention.
    const tg = await connection(t.workspaceId, t.brandId, 'telegram');
    await ensureSyncCursors({ workspaceId: t.workspaceId });
    expect((await testPool().query(`SELECT status, stop_reason FROM sync_cursors WHERE connection_id=$1`, [tg])).rows[0]).toEqual({ status: 'stopped', stop_reason: 'unsupported' });
    await testPool().query(`UPDATE connections SET status='disconnected', disconnected_at=now() - interval '200 days' WHERE id=$1`, [ig]);
    expect(await count(`SELECT count(*) n FROM metric_resource_latest WHERE connection_id=$1`, [ig])).toBeGreaterThan(0);
    await purgeAnalyticsRetention();
    expect(await count(`SELECT count(*) n FROM metric_resource_latest WHERE connection_id=$1`, [ig])).toBe(0);
  });

  it('enforces per-workspace concurrency and yields to due publishing work', async () => {
    const t = await analyticsTenant();
    const a = await connection(t.workspaceId, t.brandId, 'instagram', { name: 'A' });
    const b = await connection(t.workspaceId, t.brandId, 'instagram', { name: 'B' });
    await publish(t, t.brandId, a, 'instagram', recent(30));
    const pb = await publish(t, t.brandId, b, 'instagram', recent(30));
    await ensureSyncCursors({ workspaceId: t.workspaceId });
    process.env.ANALYTICS_WORKSPACE_CONCURRENCY = '1';
    await testPool().query(`UPDATE sync_cursors SET lease_owner='other-worker', lease_expires_at=now() + interval '5 minutes' WHERE connection_id=$1`, [a]);
    const { deps, calls } = fakeDeps(() => igInsights(10, 1));
    expect(await runConnectionSync(b, deps, { jobKey: randomUUID() })).toMatchObject({ status: 'skipped', stopReason: 'workspace_concurrency' });
    await testPool().query(`UPDATE sync_cursors SET lease_owner=NULL, lease_expires_at=NULL WHERE connection_id=$1`, [a]);
    // A due publication anywhere makes the sync yield (checkpointed, retried shortly).
    process.env.ANALYTICS_YIELD_DUE_DELIVERIES = '0';
    await testPool().query(`UPDATE deliveries SET state='scheduled', next_attempt_at=now() - interval '1 minute' WHERE id=$1`, [pb]);
    const s = await runConnectionSync(b, deps, { jobKey: randomUUID() });
    await testPool().query(`UPDATE deliveries SET state='published' WHERE id=$1`, [pb]);
    expect(s).toMatchObject({ status: 'partial', stopReason: 'publishing_priority', processed: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('legacy backfill', () => {
  it('moves V1.1 snapshots into the pipeline idempotently; unsupported/permission states stay states, never zeros', async () => {
    const t = await analyticsTenant();
    const ig = await connection(t.workspaceId, t.brandId, 'instagram');
    const tg = await connection(t.workspaceId, t.brandId, 'telegram');
    const fb = await connection(t.workspaceId, t.brandId, 'facebook');
    const d1 = await publish(t, t.brandId, ig, 'instagram', '2026-09-10T10:00:00Z');
    const d2 = await publish(t, t.brandId, tg, 'telegram', '2026-09-10T10:00:00Z');
    const d3 = await publish(t, t.brandId, fb, 'facebook', '2026-09-10T10:00:00Z');
    const snap = (d: string, c: string, metric: string, value: number, at: string, dim: string | null = null, provider = 'instagram') => testPool().query(
      `INSERT INTO metric_snapshots(workspace_id, brand_id, connection_id, delivery_id, provider, provider_object_id, metric, dimension, value, period, observed_at, source)
       VALUES ($1,$2,$3,$4,$5,'obj',$6,$7,$8,'lifetime',$9,'provider')`, [t.workspaceId, t.brandId, c, d, provider, metric, dim, value, at]);
    await snap(d1, ig, 'views', 100, '2026-09-11T10:00:00Z'); await snap(d1, ig, 'likes', 5, '2026-09-11T10:00:00Z');
    await snap(d1, ig, 'views', 140, '2026-09-12T10:00:00Z'); await snap(d1, ig, 'likes', 9, '2026-09-12T10:00:00Z');
    await snap(d1, ig, 'impressions', 999, '2026-09-12T10:00:00Z'); // deprecated name, not in the registry ⇒ rejected
    for (const [d, s] of [[d1, 'ok'], [d2, 'unsupported'], [d3, 'permission_missing']] as const) {
      await testPool().query(`INSERT INTO metric_fetch_state(delivery_id, workspace_id, status, last_attempt_at) VALUES ($1,$2,$3,'2026-09-12T10:00:00Z')`, [d, t.workspaceId, s]);
    }
    await testPool().query(`DELETE FROM system_flags WHERE key='analytics.legacy_backfill'`);
    let r = await backfillLegacySnapshots({ batch: 5000 });
    while (!r.done) r = await backfillLegacySnapshots({ batch: 5000 });
    expect(await count(`SELECT count(*) n FROM metric_observations WHERE resource_id=$1`, [d1])).toBe(4);
    expect(await count(`SELECT count(*) n FROM metric_observations WHERE resource_id = ANY($1::uuid[])`, [[d2, d3]])).toBe(0);
    expect((await testPool().query(`SELECT status FROM data_coverage WHERE resource_id=$1 AND metric_id='*'`, [d2])).rows[0].status).toBe('unsupported');
    expect((await testPool().query(`SELECT status FROM data_coverage WHERE resource_id=$1 AND metric_id='*'`, [d3])).rows[0].status).toBe('permission_missing');
    expect(await count(`SELECT count(*) n FROM metric_daily_facts WHERE resource_id=$1 AND fact_kind='observed_change'`, [d1])).toBe(2);
    // Full re-run from scratch: no duplicates.
    const again = await backfillLegacySnapshots({ batch: 5000, restart: true });
    expect(again.observationsWritten).toBe(0);
    expect(await count(`SELECT count(*) n FROM metric_observations WHERE resource_id=$1`, [d1])).toBe(4);
    const row = (await contentTable(t.ctx, filters({ from: '2026-09-10', to: '2026-09-10' }))).rows;
    expect(row.find((x) => x.delivery_id === d1)!.metrics.find((m) => m.native_metric === 'views')!.value).toBe(140);
    expect(row.find((x) => x.delivery_id === d3)!.status).toBe('permission_missing');
  });
});

async function exported(ctx: Parameters<typeof requestReportExport>[0], body: Record<string, unknown>) {
  const req = await requestReportExport(ctx, body);
  expect(req.status).toBe('queued');
  const done = await runReportExport(req.id);
  return { req, done: done! };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  return rows;
}

describe('reports and exports', () => {
  it('CSV export reproduces the filtered, authorized content table with a manifest and is injection-safe', async () => {
    const t = await analyticsTenant();
    const b2 = await createBrand(t.workspaceId, 'Brand B');
    const ig = await connection(t.workspaceId, t.brandId, 'instagram');
    const ig2 = await connection(t.workspaceId, b2, 'instagram');
    const evil = await publish(t, t.brandId, ig, 'instagram', '2026-10-03T09:00:00Z', { title: '=HYPERLINK("http://evil","x")' });
    const ok = await publish(t, t.brandId, ig, 'instagram', '2026-10-04T09:00:00Z', { title: 'Plain, "quoted" title' });
    const other = await publish(t, b2, ig2, 'instagram', '2026-10-04T09:00:00Z', { title: 'Other brand' });
    await observe(evil, [pt('views', 200), pt('likes', 20)], '2026-10-05T09:00:00Z');
    await observe(ok, [pt('views', 100), pt('likes', 3)], '2026-10-05T09:00:00Z');
    await observe(other, [pt('views', 999), pt('likes', 99)], '2026-10-05T09:00:00Z');
    const qs = `brand=${t.brandId}&from=2026-10-01&to=2026-10-31&tz=Europe/London`;
    const { done } = await exported(t.ctx, { view: 'content', format: 'csv', query_string: qs, sort: 'engagements' });
    expect(done).toMatchObject({ status: 'succeeded', row_count: 2, delivered_format: 'csv' });
    expect(done.manifest).toMatchObject({ timezone: 'Europe/London', view: 'content', dataset: 'live', synthetic: false });
    expect(done.manifest!.query_string).toBe(`brand=${t.brandId}&from=2026-10-01&to=2026-10-31&tz=Europe%2FLondon`);
    const file = await downloadReportExport(t.ctx, done.id);
    const csv = file.body.toString('utf8');
    expect(csv).not.toContain('Other brand');
    expect(csv).toContain(`'=HYPERLINK(""http://evil"",""x"")`);
    const rows = parseCsv(csv);
    expect(rows.find((r) => r[1] === 'timezone')![2]).toBe('Europe/London');
    expect(rows.find((r) => r[1] === 'coverage')![2]).toMatch(/^2 of 2 eligible posts have data/);
    const header = rows.findIndex((r) => r[0] === 'delivery_id');
    const data = rows.slice(header + 1).filter((r) => r.length > 1);
    const api = await contentTable(t.ctx, filters({ from: '2026-10-01', to: '2026-10-31', brand_ids: [t.brandId] }), { sort: 'engagements' });
    expect(data.map((r) => r[0])).toEqual(api.rows.map((r) => r.delivery_id));
    const hdr = rows[header]!;
    expect(data.map((r) => Number(r[hdr.indexOf('engagements')]))).toEqual(api.rows.map((r) => r.engagements));
    expect(data.map((r) => r[hdr.indexOf('likes')])).toEqual(['20', '3']);
    expect(await count(`SELECT count(*) n FROM usage_counters WHERE workspace_id=$1 AND meter='exports.count' AND used=1`, [t.workspaceId])).toBe(1);
    // HTML/PDF: same data, escaped; PDF via server Chromium when available, else HTML with an explicit note.
    const html = await exported(t.ctx, { view: 'overview', format: 'html', query_string: qs });
    const h = (await downloadReportExport(t.ctx, html.done.id)).body.toString('utf8');
    expect(h).toContain('&quot;quoted&quot;');
    expect(h).not.toContain('<a href');
    const pdf = await exported(t.ctx, { view: 'overview', format: 'pdf', query_string: qs });
    const pbody = (await downloadReportExport(t.ctx, pdf.done.id)).body;
    if (pdf.done.delivered_format === 'pdf') expect(pbody.subarray(0, 4).toString()).toBe('%PDF');
    else expect(pdf.done.manifest).toMatchObject({ notes: [expect.stringMatching(/PDF rendering is not available/)] });
  }, 90_000);

  it('exports re-check authority at request, run and download time; external destinations go through ReportExporter', async () => {
    const t = await analyticsTenant();
    const b2 = await createBrand(t.workspaceId, 'Brand B');
    const ig2 = await connection(t.workspaceId, b2, 'instagram');
    const p = await publish(t, b2, ig2, 'instagram', '2026-10-04T09:00:00Z');
    await observe(p, [pt('views', 50), pt('likes', 5)], '2026-10-05T09:00:00Z');
    const u = await createUser();
    await addMember(t.workspaceId, u.id, 'viewer', [b2]);
    const g1 = await grant(t.workspaceId, u.id, 'analyst', b2);
    await grant(t.workspaceId, u.id, 'exporter', b2);
    const uctx = await v2Ctx(u.id, t.workspaceId);
    // Not allowed on the other brand ⇒ 404 at request time.
    await expect(requestReportExport(uctx, { view: 'content', format: 'csv', query_string: `brand=${t.brandId}&from=2026-10-01&to=2026-10-31` })).rejects.toMatchObject({ code: 'not_found' });
    // Analyst without exports.create on the brand ⇒ forbidden.
    const v = await createUser();
    await addMember(t.workspaceId, v.id, 'viewer', [b2]);
    await grant(t.workspaceId, v.id, 'analyst', b2);
    await expect(requestReportExport(await v2Ctx(v.id, t.workspaceId), { view: 'content', format: 'csv', query_string: `brand=${b2}&from=2026-10-01&to=2026-10-31` })).rejects.toMatchObject({ code: 'forbidden' });
    // Allowed request, then access revoked before the job runs ⇒ nothing exported.
    const req = await requestReportExport(uctx, { view: 'content', format: 'csv', query_string: `brand=${b2}&from=2026-10-01&to=2026-10-31` });
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE id=$1`, [g1]);
    const failed = await runReportExport(req.id);
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'access_revoked' }, download_path: null });
    expect(await count(`SELECT count(*) n FROM usage_counters WHERE workspace_id=$1 AND meter='exports.count' AND used > 0`, [t.workspaceId])).toBe(0);
    // Successful export, then access revoked ⇒ download refused.
    const g2 = await grant(t.workspaceId, u.id, 'analyst', b2);
    const ok = await exported(await v2Ctx(u.id, t.workspaceId), { view: 'content', format: 'csv', query_string: `brand=${b2}&from=2026-10-01&to=2026-10-31` });
    expect(ok.done.status).toBe('succeeded');
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE id=$1`, [g2]);
    await expect(downloadReportExport(await v2Ctx(u.id, t.workspaceId).catch(() => uctx), ok.done.id)).rejects.toBeTruthy();
    // Someone else's export is invisible.
    await expect(getReportExport(t.ctx, ok.done.id)).rejects.toMatchObject({ code: 'not_found' });
    // External destination with no exporter connected ⇒ honest failure; a registered exporter receives the rendered report.
    const ext = await exported(t.ctx, { view: 'overview', format: 'html', destination: 'google_doc', destination_ref: { connection_id: randomUUID(), parent_id: null }, query_string: `brand=${b2}&from=2026-10-01&to=2026-10-31` });
    expect(ext.done).toMatchObject({ status: 'failed', error: { code: 'destination_not_connected' } });
    const received: Array<{ title: string; format: string; brandId: string | null; hasHtml: boolean }> = [];
    registerReportExporter({ kinds: ['notion_page'], async export(_ctx, input) {
      received.push({ title: input.title, format: input.format, brandId: input.content.brandId, hasHtml: !!input.html?.includes('Analytics overview') });
      return { id: 'job-1', status: 'queued', destination_kind: 'notion_page', destination_parent_id: 'p', title: input.title, format: input.format, brand_id: input.content.brandId,
        created_at: new Date().toISOString(), completed_at: null, result_url: null, result_external_id: null, sharing_warning: 'Inherits the parent page sharing.', error: null };
    } });
    const np = await exported(t.ctx, { view: 'overview', format: 'html', destination: 'notion_page', destination_ref: { connection_id: randomUUID(), parent_id: 'p' }, query_string: `brand=${b2}&from=2026-10-01&to=2026-10-31` });
    expect(np.done).toMatchObject({ status: 'succeeded', destination_result: { sharing_warning: 'Inherits the parent page sharing.' } });
    expect(received).toEqual([{ title: 'Analytics overview', format: 'html', brandId: b2, hasHtml: true }]);
  }, 60_000);

  it('saved views serialise filters and re-check access when opened', async () => {
    const t = await analyticsTenant();
    const b2 = await createBrand(t.workspaceId, 'Brand B');
    const u = await createUser();
    await addMember(t.workspaceId, u.id, 'viewer', [b2]);
    const g = await grant(t.workspaceId, u.id, 'analyst', b2);
    const uctx = await v2Ctx(u.id, t.workspaceId);
    const rep = await createReport(uctx, { name: 'Brand B weekly', view: 'overview', query_string: `brand=${b2}&from=2026-10-01&to=2026-10-07&tz=Europe/Paris`, visibility: 'workspace' });
    expect(rep.query_string).toBe(`brand=${b2}&from=2026-10-01&to=2026-10-07&tz=Europe%2FParis`);
    expect(rep.filters).toMatchObject({ brand_ids: [b2], timezone: 'Europe/Paris', dataset: 'live' });
    expect(JSON.stringify(rep.filters)).not.toMatch(/Brand B/); // ids only, no names
    const opened = await openReport(uctx, rep.id);
    expect(opened.data.meta.period).toMatchObject({ from: '2026-10-01', to: '2026-10-07', timezone: 'Europe/Paris' });
    await expect(createReport(uctx, { name: 'Sneaky', view: 'overview', query_string: `brand=${t.brandId}` })).rejects.toMatchObject({ code: 'not_found' });
    // Owner of the workspace can open the shared view; a private one is invisible to others.
    expect((await listReports(t.ctx)).map((r) => r.id)).toContain(rep.id);
    const priv = await createReport(t.ctx, { name: 'Mine', view: 'content', query_string: 'from=2026-10-01&to=2026-10-07' });
    await expect(openReport(uctx, priv.id)).rejects.toMatchObject({ code: 'not_found' });
    // Access removed ⇒ the saved view no longer opens.
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE id=$1`, [g]);
    const after = await v2Ctx(u.id, t.workspaceId);
    await expect(openReport(after, rep.id)).rejects.toMatchObject({ code: expect.stringMatching(/not_found|forbidden/) });
  });
});
