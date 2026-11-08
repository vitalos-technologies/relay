// V3 analytics test fixtures: live/mock connections, published posts with explicit publish instants, and ingestion
// through the REAL pipeline (ingestPoints → facts → rollups). Real PostgreSQL.
import { randomUUID } from 'node:crypto';
import type { Provider } from '@social-lite/core';
import type { MetricPoint } from '@social-lite/providers/metrics';
import { insertPublishedPosts } from '@social-lite/services/analytics/demo';
import { ingestPoints, recordCoverage, type IngestTarget } from '@social-lite/services/analytics/ingest';
import { parseFilters } from '@social-lite/services/analytics/filters';
import type { AnalyticsFilters } from '@social-lite/core/contracts/analytics';
import { addMember, createBrand, createUser, createWorkspace, testPool, v2Ctx } from './helpers.js';

export async function analyticsTenant(opts: { isDemo?: boolean } = {}) {
  const owner = await createUser();
  const workspaceId = await createWorkspace('Analytics WS', { isDemo: opts.isDemo ?? false });
  const brandId = await createBrand(workspaceId, 'Brand A');
  await addMember(workspaceId, owner.id, 'owner');
  const ctx = await v2Ctx(owner.id, workspaceId);
  return { owner, workspaceId, brandId, ctx };
}

export async function connection(workspaceId: string, brandId: string, provider: Provider, opts: { mock?: boolean; name?: string; accountId?: string } = {}): Promise<string> {
  const mock = opts.mock ?? false;
  const r = await testPool().query<{ id: string }>(
    `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, status, is_mock) VALUES ($1,$2,$3,$4,$5,'ready',$6) RETURNING id`,
    [workspaceId, brandId, provider, opts.accountId ?? `${mock ? 'mock_' : ''}${provider}-${randomUUID().slice(0, 8)}`, opts.name ?? `${provider} account`, mock]);
  return r.rows[0]!.id;
}

export async function publish(t: { workspaceId: string }, brandId: string, connectionId: string, provider: Provider, publishedAt: Date | string,
  o: { title?: string; format?: 'text' | 'image' | 'video' | 'reel' | 'album'; campaignId?: string | null; teamId?: string | null; mock?: boolean; providerIds?: string[] } = {}): Promise<string> {
  const [id] = await insertPublishedPosts([{ workspaceId: t.workspaceId, brandId, connectionId, provider, isMock: o.mock ?? false, publishedAt: new Date(publishedAt),
    title: o.title ?? 'Post', text: o.title ?? 'Post text', format: o.format ?? 'image', campaignId: o.campaignId ?? null, teamId: o.teamId ?? null,
    providerIds: o.providerIds }]);
  return id!;
}

export const pt = (name: string, value: number, period = 'lifetime', dimension: string | null = null, windowEnd: string | null = null): MetricPoint =>
  ({ name, value, period, dimension, windowEnd });

export async function target(deliveryId: string): Promise<IngestTarget> {
  const d = (await testPool().query(`SELECT d.*, c.is_mock FROM deliveries d JOIN connections c ON c.id=d.connection_id WHERE d.id=$1`, [deliveryId])).rows[0];
  return { workspaceId: d.workspace_id, brandId: d.brand_id, connectionId: d.connection_id, provider: d.provider, resourceType: 'post', resourceId: d.id,
    providerObjectId: d.provider_ids[0] ?? null, publishedAt: d.published_at, source: d.is_mock ? 'simulated' : 'provider' };
}

/** Ingest points AND record a successful fetch (coverage), like the sync job does. */
export async function observe(deliveryId: string, points: MetricPoint[], at: Date | string, unavailable: Array<{ name: string; reason: string }> = []) {
  const t = await target(deliveryId);
  const r = await ingestPoints(t, points, new Date(at));
  await recordCoverage(testPool(), t, { state: 'ok', message: null, reported: points.map((p) => p.name), unavailable }, new Date(at), null, null);
  return r;
}

export function filters(over: Partial<AnalyticsFilters> & { from: string; to: string }): AnalyticsFilters {
  return { ...parseFilters(new URLSearchParams(), { timezone: 'Europe/London' }), ...over };
}

export async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await testPool().query(sql, params)).rows[0].n);
}
