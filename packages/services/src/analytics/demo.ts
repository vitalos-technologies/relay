// Synthetic analytics fixtures (V3 spec §9 "predictable synthetic demo fixtures"):
//  - DEMO WORKSPACES ONLY (workspaces.is_demo) and never in production. Data lives on synthetic, paused mock
//    connections (connections.is_synthetic) with source='synthetic' facts, so it can never enter live or simulated
//    queries (query.ts dataset predicates) and is never synced/refreshed (sync gate, legacy refresh skip).
//  - Deterministic: the same seed + anchor date produce the same posts, timestamps, thumbnails and values.
//  - Coherent: lifetime counters grow with age after publication (snapshots at +1/+2/+3/+7/+14/+30 days), weekly
//    seasonality, a gentle upward trend, a campaign uplift and provider-shaped metric ratios.
//  - generateLargeHistory(): the same generator, parameterised for V3.1 benchmarks (small by default).
import { createHash, randomUUID } from 'node:crypto';
import { AppError, type Provider } from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx, type PoolClient, type Queryable } from '@social-lite/db';
import { config } from '../config.js';
import { rollupSelectSql } from './ingest.js';
import { ENGAGEMENT_FAMILIES, definitionsFor, ensureMetricRegistry, fetchedPostDefinitions, type MetricDefinition } from './registry.js';
import { addDays, localMidnightUtc } from './semantics.js';

// ------------------------------------------------------------------ deterministic PRNG
export function prng(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic UUID (v4-shaped) from a seed string. */
export function seededUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ------------------------------------------------------------------ bulk fixture posts (also used by tests)
export interface FixturePost {
  id?: string;
  workspaceId: string; brandId: string; connectionId: string; provider: Provider; isMock: boolean;
  publishedAt: Date; title: string; text: string; format: 'text' | 'image' | 'album' | 'video' | 'reel';
  campaignId?: string | null; teamId?: string | null; providerIds?: string[]; dueAt?: Date; createdBy?: string | null;
}

/** Insert published posts (post → revision → variant → schedule → delivery) in one transaction. Returns delivery ids. */
export async function insertPublishedPosts(posts: FixturePost[], db?: PoolClient): Promise<string[]> {
  const run = async (tx: Queryable) => {
    const ids: string[] = [];
    for (const p of posts) {
      const base = p.id ?? randomUUID();
      const postId = seededUuid(`post:${base}`); const revId = seededUuid(`rev:${base}`); const varId = seededUuid(`var:${base}`);
      const schId = seededUuid(`sch:${base}`); const delId = p.id ?? seededUuid(`del:${base}`);
      const due = p.dueAt ?? p.publishedAt;
      const created = new Date(due.getTime() - 86_400_000);
      await tx.query(
        `INSERT INTO posts(id, workspace_id, brand_id, created_by, title, draft, version, current_revision_id, schedule_generation, campaign_id, team_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,1,$8,$9,$10,$10)`,
        [postId, p.workspaceId, p.brandId, p.createdBy ?? null, p.title, JSON.stringify({ baseText: p.text, baseLink: null, baseAssetIds: [], variants: [] }), revId,
          p.campaignId ?? null, p.teamId ?? null, created]);
      await tx.query(`INSERT INTO post_revisions(id, workspace_id, post_id, revision_number, base_text, content_hash, created_at) VALUES ($1,$2,$3,1,$4,$5,$6)`,
        [revId, p.workspaceId, postId, p.text, createHash('sha256').update(p.text).digest('hex'), created]);
      await tx.query(`INSERT INTO variants(id, workspace_id, revision_id, connection_id, inherit_text, rendered_text, format) VALUES ($1,$2,$3,$4,true,$5,$6)`,
        [varId, p.workspaceId, revId, p.connectionId, p.text, p.format]);
      await tx.query(
        `INSERT INTO schedules(id, workspace_id, brand_id, post_id, revision_id, generation, due_at, input_timezone, input_local_time, publish_before, status, fingerprint, created_at)
         VALUES ($1,$2,$3,$4,$5,1,$6,'UTC',$7,$8,'completed',$9,$10)`,
        [schId, p.workspaceId, p.brandId, postId, revId, due, due.toISOString().slice(0, 16), new Date(due.getTime() + 3_600_000), `fixture:${base}`, created]);
      await tx.query(
        `INSERT INTO deliveries(id, workspace_id, brand_id, post_id, schedule_id, generation, revision_id, variant_id, connection_id, provider, is_mock, state, due_at,
            publish_before, next_attempt_at, attempt_count, provider_ids, published_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,'published',$11,$12,$11,1,$13,$14,$15,$14)`,
        [delId, p.workspaceId, p.brandId, postId, schId, revId, varId, p.connectionId, p.provider, p.isMock, due, new Date(due.getTime() + 3_600_000),
          p.providerIds ?? [`${p.isMock ? 'mock_' : ''}${delId.slice(0, 8)}`], p.publishedAt, created]);
      ids.push(delId);
    }
    return ids;
  };
  return db ? run(db) : withTx(run);
}

// ------------------------------------------------------------------ bulk synthetic facts
export interface SyntheticPoint {
  workspaceId: string; brandId: string; connectionId: string; provider: Provider; resourceType: 'post' | 'account'; resourceId: string;
  def: MetricDefinition; dimension: string; value: number; observedAt: Date; publishedAt: Date | null;
}

/**
 * Bulk-load synthetic points (source='synthetic') then rebuild facts/aggregates for the touched connections. Same
 * tables and keys as the live pipeline (fact-key upserts ⇒ re-running is idempotent).
 */
export async function bulkLoadSynthetic(points: SyntheticPoint[]): Promise<number> {
  if (!points.length) return 0;
  await ensureMetricRegistry();
  const db = getPool();
  const CHUNK = 5000;
  for (let i = 0; i < points.length; i += CHUNK) {
    const c = points.slice(i, i + CHUNK);
    const col = <T>(f: (p: SyntheticPoint) => T) => c.map(f);
    await db.query(
      `INSERT INTO metric_observations(workspace_id, brand_id, connection_id, resource_type, resource_id, provider, metric_id, definition_version, native_metric, dimension,
          period_key, native_period, value, source, observed_at, first_observed_at)
       SELECT w, b, cn, rt, r, pv::provider_kind, m, v, nm, dim, 'asof:' || (o AT TIME ZONE 'UTC')::date, CASE WHEN rt = 'account' THEN 'snapshot' ELSE 'lifetime' END, val, 'synthetic', o, o
         FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::uuid[], $6::text[], $7::text[], $8::int[], $9::text[], $10::text[], $11::numeric[], $12::timestamptz[])
              AS t(w, b, cn, rt, r, pv, m, v, nm, dim, val, o)
       ON CONFLICT (workspace_id, connection_id, resource_type, resource_id, metric_id, period_key, dimension, definition_version)
       DO UPDATE SET value = EXCLUDED.value, observed_at = EXCLUDED.observed_at`,
      [col((p) => p.workspaceId), col((p) => p.brandId), col((p) => p.connectionId), col((p) => p.resourceType), col((p) => p.resourceId), col((p) => p.provider),
        col((p) => p.def.id), col((p) => p.def.version), col((p) => p.def.nativeMetric), col((p) => p.dimension), col((p) => p.value), col((p) => p.observedAt)]);
  }
  const conns = [...new Set(points.map((p) => p.connectionId))];
  const published = new Map(points.filter((p) => p.publishedAt).map((p) => [p.resourceId, p.publishedAt!]));
  await rebuildAggregates(points[0]!.workspaceId, conns, published);
  return points.length;
}

/**
 * Rebuild cumulative facts, observed changes, per-resource latest and rollups for connections from their observations
 * (repair/backfill tool; used by the synthetic loader). Deterministic and idempotent.
 */
export async function rebuildAggregates(workspaceId: string, connectionIds: string[], publishedAt?: Map<string, Date>): Promise<void> {
  const db = getPool();
  await withTx(async (tx) => {
    await tx.query(
      `INSERT INTO metric_cumulative_facts(workspace_id, brand_id, connection_id, resource_type, resource_id, provider, metric_id, definition_version, dimension, as_of_date,
          basis, window_start, value, observed_at, through_at, source)
       SELECT o.workspace_id, o.brand_id, o.connection_id, o.resource_type, o.resource_id, o.provider, o.metric_id, o.definition_version, o.dimension,
              substr(o.period_key, 6)::date, CASE WHEN md.time_basis = 'snapshot' THEN 'snapshot' WHEN md.time_basis = 'window' AND o.window_start IS NOT NULL THEN 'window' ELSE 'lifetime' END,
              o.window_start, o.value, o.observed_at, o.observed_at - make_interval(hours => md.provider_delay_hours), o.source
         FROM metric_observations o JOIN metric_definitions md ON md.metric_id = o.metric_id AND md.version = o.definition_version
        WHERE o.workspace_id = $1 AND o.connection_id = ANY($2::uuid[]) AND o.period_key LIKE 'asof:%'
       ON CONFLICT (workspace_id, connection_id, resource_type, resource_id, metric_id, dimension, definition_version, as_of_date)
       DO UPDATE SET value = EXCLUDED.value, observed_at = EXCLUDED.observed_at, through_at = EXCLUDED.through_at, basis = EXCLUDED.basis`,
      [workspaceId, connectionIds]);
    await tx.query(`DELETE FROM metric_daily_facts WHERE workspace_id = $1 AND connection_id = ANY($2::uuid[]) AND fact_kind = 'observed_change'`, [workspaceId, connectionIds]);
    await tx.query(
      `INSERT INTO metric_daily_facts(workspace_id, brand_id, connection_id, resource_type, resource_id, provider, metric_id, definition_version, dimension, fact_kind,
          bucket_date, bucket_tz, value, period_start, period_end, observed_at, source)
       SELECT workspace_id, brand_id, connection_id, resource_type, resource_id, provider, metric_id, definition_version, dimension, 'observed_change', as_of_date, 'UTC',
              value - prev_value, prev_observed, observed_at, observed_at, source
         FROM (SELECT f.*, lag(f.value) OVER w AS prev_value, lag(f.observed_at) OVER w AS prev_observed
                 FROM metric_cumulative_facts f WHERE f.workspace_id = $1 AND f.connection_id = ANY($2::uuid[]) AND f.basis <> 'window'
               WINDOW w AS (PARTITION BY f.connection_id, f.resource_type, f.resource_id, f.metric_id, f.dimension, f.definition_version ORDER BY f.as_of_date)) x
        WHERE prev_value IS NOT NULL`, [workspaceId, connectionIds]);
    await tx.query(`DELETE FROM metric_resource_latest WHERE workspace_id = $1 AND connection_id = ANY($2::uuid[])`, [workspaceId, connectionIds]);
    await tx.query(
      `INSERT INTO metric_resource_latest(workspace_id, brand_id, connection_id, resource_type, resource_id, provider, metric_id, definition_version, dimension, basis, value,
          as_of_date, observed_at, through_at, published_at, rollup_bucket, source)
       SELECT DISTINCT ON (f.connection_id, f.resource_type, f.resource_id, f.metric_id, f.dimension, f.definition_version)
              f.workspace_id, f.brand_id, f.connection_id, f.resource_type, f.resource_id, f.provider, f.metric_id, f.definition_version, f.dimension, f.basis, f.value,
              f.as_of_date, f.observed_at, f.through_at, d.published_at,
              CASE WHEN d.published_at IS NOT NULL THEN to_timestamp(floor(extract(epoch FROM d.published_at) / 900) * 900) END, f.source
         FROM metric_cumulative_facts f LEFT JOIN deliveries d ON f.resource_type = 'post' AND d.id = f.resource_id
        WHERE f.workspace_id = $1 AND f.connection_id = ANY($2::uuid[])
        ORDER BY f.connection_id, f.resource_type, f.resource_id, f.metric_id, f.dimension, f.definition_version, f.as_of_date DESC, f.observed_at DESC`,
      [workspaceId, connectionIds]);
    await tx.query(`DELETE FROM metric_rollups WHERE workspace_id = $1 AND connection_id = ANY($2::uuid[])`, [workspaceId, connectionIds]);
    await tx.query(
      `INSERT INTO metric_rollups(connection_id, brand_id, provider, source, bucket_start, metric_key, definition_version, dimension, value_sum, resources, min_through_at,
          min_observed_at, max_observed_at, workspace_id)
       SELECT r.*, $1::uuid FROM (${rollupSelectSql('l.workspace_id = $1 AND l.connection_id = ANY($2::uuid[]) AND l.rollup_bucket IS NOT NULL', '$3::text[]')}) r WHERE r.resources > 0`,
      [workspaceId, connectionIds, [...ENGAGEMENT_FAMILIES]]);
  });
  void publishedAt; void db;
}

// ------------------------------------------------------------------ the demo dataset
const DEMO_BRAND = 'Relay Coffee (synthetic analytics demo)';
const DEMO_TZ = 'Europe/London';
const DEMO_PROVIDERS: Provider[] = ['instagram', 'facebook', 'x', 'tiktok', 'youtube', 'linkedin', 'threads', 'pinterest', 'bluesky', 'telegram'];
const TOPICS = [
  ['Autumn blend is here', 'Our new autumn blend: cinnamon, cocoa and a long finish.'], ['Behind the roaster', 'Five minutes with the team that roasts every batch by hand.'],
  ['Latte art Friday', 'Swipe for this week’s best latte art from our baristas.'], ['Brew guide: V60', 'A simple pour-over routine for a brighter cup at home.'],
  ['Farm partner spotlight', 'Meet the co-operative behind our single-origin beans.'], ['Weekend opening hours', 'Opening early this weekend for the city half-marathon.'],
  ['Customer of the month', 'Thank you for 200 visits and counting!'], ['Cold brew how-to', 'Twelve hours, two ingredients, one very smooth cup.'],
  ['Reusable cup rewards', 'Bring your own cup and get 20p off every drink.'], ['New pastry menu', 'Cardamom buns are back by popular demand.'],
] as const;

const FORMAT: Record<Provider, FixturePost['format']> = {
  instagram: 'image', facebook: 'image', x: 'text', tiktok: 'video', youtube: 'video', linkedin: 'text', threads: 'text', pinterest: 'image', bluesky: 'text', telegram: 'text',
};
/** Typical exposure per post (views/impressions) — shapes the synthetic values only. */
const BASE: Partial<Record<Provider, number>> = { instagram: 2400, facebook: 1500, x: 3200, tiktok: 6800, youtube: 1900, linkedin: 900, threads: 1100, pinterest: 2600, bluesky: 0 };
const BEST_HOUR: Record<Provider, number> = { instagram: 18, facebook: 12, x: 9, tiktok: 20, youtube: 17, linkedin: 8, threads: 19, pinterest: 21, bluesky: 10, telegram: 11 };
const FOLLOWERS: Partial<Record<Provider, number>> = { instagram: 12400, facebook: 8300, x: 5100, tiktok: 22100, youtube: 3900, linkedin: 2700, threads: 1900, pinterest: 4300, bluesky: 860 };

/** Ratio of a metric to the post's exposure (or likes for networks without exposure). */
function metricRatio(def: MetricDefinition, r: () => number): number {
  const j = 0.8 + r() * 0.4;
  switch (def.family) {
    case 'views': case 'impressions': return 1;
    case 'reach': return 0.68 * j;
    case 'likes': return 0.045 * j;
    case 'comments': return 0.006 * j;
    case 'shares': return 0.004 * j;
    case 'quotes': return 0.001 * j;
    case 'saves': return 0.007 * j;
    case 'clicks': return 0.012 * j;
    case 'link_clicks': return 0.005 * j;
    case 'interactions_total': return 0.062 * j;
    case 'watch_time': return 0.42 * j; // minutes per view
    case 'avg_view_duration': return 25 * j; // seconds (not summed; derived from watch time/views)
    case 'followers_gained': return 0.002 * j;
    default: return 0;
  }
}

export interface DemoOptions {
  workspaceId: string;
  /** Anchor "today" (UTC date) — fixed in tests for determinism; default today. */
  anchor?: string;
  days?: number;
  postsPerDay?: number;
  seed?: string;
  providers?: Provider[];
  connectionsPerProvider?: number;
  brandName?: string;
}

export interface DemoResult { brandId: string; connectionIds: string[]; posts: number; points: number; synthetic: true }

/** Create (or recreate) the synthetic analytics demo for a DEMO workspace. Deterministic for a given seed + anchor. */
export async function seedAnalyticsDemo(o: DemoOptions): Promise<DemoResult> {
  if (config().APP_ENV === 'production') throw new AppError('forbidden', 'Synthetic analytics fixtures are never created in production.');
  const db = getPool();
  const ws = await maybeOne<{ is_demo: boolean }>(db, `SELECT is_demo FROM workspaces WHERE id=$1`, [o.workspaceId]);
  if (!ws) throw new AppError('not_found', 'Workspace not found');
  if (!ws.is_demo) throw new AppError('forbidden', 'Synthetic analytics fixtures are only created in demo workspaces.');
  await ensureMetricRegistry();
  const seed = o.seed ?? 'relay-analytics-demo-v1';
  const anchor = o.anchor ?? new Date().toISOString().slice(0, 10);
  const days = Math.min(Math.max(o.days ?? 90, 1), 3650);
  const perDay = Math.min(Math.max(o.postsPerDay ?? 1, 0.1), 50);
  const providers = o.providers ?? DEMO_PROVIDERS;
  const perProvider = Math.min(Math.max(o.connectionsPerProvider ?? 1, 1), 50);
  const brandName = o.brandName ?? DEMO_BRAND;
  // Recreate: drop previous synthetic fixtures of this brand (facts cascade with the connections).
  const brand = await maybeOne<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND name=$2`, [o.workspaceId, brandName])
    ?? await one<{ id: string }>(db, `INSERT INTO brands(workspace_id, name, timezone, is_demo) VALUES ($1,$2,$3,true) RETURNING id`, [o.workspaceId, brandName, DEMO_TZ]);
  await withTx(async (tx) => {
    const old = await many<{ id: string }>(tx, `SELECT id FROM connections WHERE workspace_id=$1 AND brand_id=$2 AND is_synthetic`, [o.workspaceId, brand.id]);
    if (old.length) {
      const ids = old.map((c) => c.id);
      const postIds = (await many<{ post_id: string }>(tx, `SELECT DISTINCT post_id FROM deliveries WHERE workspace_id=$1 AND connection_id = ANY($2::uuid[])`, [o.workspaceId, ids])).map((r) => r.post_id);
      await tx.query(`DELETE FROM metric_snapshots WHERE connection_id = ANY($1::uuid[])`, [ids]);
      await tx.query(`DELETE FROM metric_fetch_state WHERE delivery_id IN (SELECT id FROM deliveries WHERE connection_id = ANY($1::uuid[]))`, [ids]);
      await tx.query(`DELETE FROM deliveries WHERE workspace_id=$1 AND connection_id = ANY($2::uuid[])`, [o.workspaceId, ids]);
      await tx.query(`DELETE FROM posts WHERE workspace_id=$1 AND id = ANY($2::uuid[])`, [o.workspaceId, postIds]);
      await tx.query(`DELETE FROM connections WHERE id = ANY($1::uuid[])`, [ids]);
    }
  });
  const campaigns: string[] = [];
  for (const name of ['Autumn launch (demo)', 'Always-on (demo)']) {
    const c = await maybeOne<{ id: string }>(db, `SELECT id FROM campaigns WHERE workspace_id=$1 AND brand_id=$2 AND lower(name)=lower($3) AND archived_at IS NULL`, [o.workspaceId, brand.id, name])
      ?? await one<{ id: string }>(db, `INSERT INTO campaigns(workspace_id, brand_id, name, description) VALUES ($1,$2,$3,'Synthetic demo campaign') RETURNING id`, [o.workspaceId, brand.id, name]);
    campaigns.push(c.id);
  }
  const conns: Array<{ id: string; provider: Provider }> = [];
  for (const p of providers) {
    for (let k = 0; k < perProvider; k++) {
      const id = seededUuid(`${seed}:${o.workspaceId}:conn:${p}:${k}`);
      await db.query(
        `INSERT INTO connections(id, workspace_id, brand_id, provider, provider_account_id, display_name, username, status, is_mock, is_synthetic, paused, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ready',true,true,true,'{"synthetic":true}')`,
        [id, o.workspaceId, brand.id, p, `mock_demo_${p}_${k}_${id.slice(0, 6)}`, `Relay Coffee${perProvider > 1 ? ` ${k + 1}` : ''} (demo)`, `relaycoffee_demo`]);
      conns.push({ id, provider: p });
    }
  }
  // Posts
  const anchorStart = localMidnightUtc(anchor, DEMO_TZ);
  const fixtures: Array<FixturePost & { quality: number; dayIndex: number }> = [];
  for (const c of conns) {
    const r = prng(`${seed}:${c.id}`);
    for (let d = days - 1; d >= 0; d--) {
      const date = addDays(anchor, -d);
      const n = Math.floor(perDay + r() * 0.999) ; // perDay may be fractional
      for (let i = 0; i < n; i++) {
        const dayStart = localMidnightUtc(date, DEMO_TZ);
        const hour = Math.min(23, Math.max(6, BEST_HOUR[c.provider] + Math.round((r() - 0.5) * 8)));
        const publishedAt = new Date(dayStart.getTime() + hour * 3_600_000 + Math.floor(r() * 60) * 60_000);
        if (publishedAt >= anchorStart && publishedAt.getTime() > Date.now()) continue;
        const t = TOPICS[Math.floor(r() * TOPICS.length)]!;
        const dayIndex = days - 1 - d;
        fixtures.push({
          id: seededUuid(`${seed}:${c.id}:${date}:${i}`), workspaceId: o.workspaceId, brandId: brand.id, connectionId: c.id, provider: c.provider, isMock: true,
          publishedAt, title: `${t[0]} (demo)`, text: `${t[1]} #relaydemo`, format: FORMAT[c.provider], campaignId: r() < 0.35 ? campaigns[0]! : r() < 0.5 ? campaigns[1]! : null,
          providerIds: [`mock_demo_${c.provider}_${date}_${i}`],
          quality: (0.55 + r() * 0.9) * (1 + 0.25 * Math.cos(((hour - BEST_HOUR[c.provider]) / 12) * Math.PI)), dayIndex,
        });
      }
    }
  }
  const CH = 300;
  for (let i = 0; i < fixtures.length; i += CH) await insertPublishedPosts(fixtures.slice(i, i + CH));
  // Metrics: lifetime counters observed at +1/+2/+3/+7/+14/+30 days (never in the future of the anchor/now).
  const nowCap = Math.min(Date.now(), localMidnightUtc(addDays(anchor, 1), DEMO_TZ).getTime());
  const points: SyntheticPoint[] = [];
  for (const f of fixtures) {
    const defs = fetchedPostDefinitions(f.provider).filter((d) => d.aggregation !== 'ratio_of_sums' && d.availability !== 'excluded');
    if (!defs.length) continue;
    const r = prng(`${seed}:${f.id}:m`);
    const trend = 1 + 0.004 * f.dayIndex; // gentle growth over the range
    const campaign = f.campaignId ? 1.15 : 1;
    const exposure = Math.max(BASE[f.provider] ?? 0, 0) * f.quality * trend * campaign;
    const likesBase = f.provider === 'bluesky' ? 60 * f.quality * trend : 0;
    const ratios = new Map(defs.map((d) => [d.id, metricRatio(d, r)]));
    for (const ageDays of [1, 2, 3, 7, 14, 30]) {
      const at = new Date(f.publishedAt.getTime() + ageDays * 86_400_000 + 3 * 3_600_000);
      if (at.getTime() > nowCap) break;
      const growth = 1 - Math.exp(-ageDays / 2.2);
      for (const d of defs) {
        const base = f.provider === 'bluesky' ? likesBase * (ratios.get(d.id)! / 0.045) : exposure * ratios.get(d.id)!;
        if (d.dimensionKey === 'reaction_type') {
          points.push({ workspaceId: o.workspaceId, brandId: brand.id, connectionId: f.connectionId, provider: f.provider, resourceType: 'post', resourceId: f.id!, def: d,
            dimension: 'like', value: Math.round(base * growth * 0.8), observedAt: at, publishedAt: f.publishedAt });
          points.push({ workspaceId: o.workspaceId, brandId: brand.id, connectionId: f.connectionId, provider: f.provider, resourceType: 'post', resourceId: f.id!, def: d,
            dimension: 'love', value: Math.round(base * growth * 0.2), observedAt: at, publishedAt: f.publishedAt });
          continue;
        }
        points.push({ workspaceId: o.workspaceId, brandId: brand.id, connectionId: f.connectionId, provider: f.provider, resourceType: 'post', resourceId: f.id!, def: d,
          dimension: '', value: Math.round(base * growth * (d.unit === 'minutes' ? 1 : 1)), observedAt: at, publishedAt: f.publishedAt });
      }
    }
  }
  // Account snapshots (followers, daily at 06:00 local) + Instagram audience (country, thresholded).
  for (const c of conns) {
    const fdef = definitionsFor(c.provider).find((d) => d.family === 'followers');
    if (!fdef || !FOLLOWERS[c.provider]) continue;
    const r = prng(`${seed}:${c.id}:followers`);
    let v = FOLLOWERS[c.provider]! * (0.85 + r() * 0.3);
    for (let d = days - 1; d >= 0; d--) {
      const at = new Date(localMidnightUtc(addDays(anchor, -d), DEMO_TZ).getTime() + 6 * 3_600_000);
      if (at.getTime() > nowCap) break;
      v = v * (1 + 0.0015 + (r() - 0.45) * 0.002);
      if (r() < 0.08) continue; // occasional missed snapshot: shown as a gap, never as 0
      points.push({ workspaceId: o.workspaceId, brandId: brand.id, connectionId: c.id, provider: c.provider, resourceType: 'account', resourceId: c.id, def: fdef,
        dimension: '', value: Math.round(v), observedAt: at, publishedAt: null });
    }
    const adef = definitionsFor(c.provider).find((d) => d.family === 'audience' && d.dimensionKey === 'country');
    if (adef && c.provider === 'instagram') {
      const at = new Date(localMidnightUtc(anchor, DEMO_TZ).getTime() + 6 * 3_600_000);
      if (at.getTime() <= nowCap) {
        const shares: Array<[string, number]> = [['GB', 0.52], ['IE', 0.11], ['US', 0.09], ['FR', 0.06], ['DE', 0.05], ['ES', 0.04], ['NL', 0.03], ['IS', 0.0004]];
        for (const [k, s] of shares) points.push({ workspaceId: o.workspaceId, brandId: brand.id, connectionId: c.id, provider: c.provider, resourceType: 'account',
          resourceId: c.id, def: adef, dimension: k, value: Math.round(v * s), observedAt: at, publishedAt: null });
      }
    }
  }
  await bulkLoadSynthetic(points);
  await db.query(
    `INSERT INTO sync_cursors(workspace_id, brand_id, connection_id, stream, status, stop_reason, backfill_from, next_run_at)
     SELECT workspace_id, brand_id, id, 'post_metrics', 'stopped', 'synthetic', now(), now() FROM connections WHERE id = ANY($1::uuid[]) ON CONFLICT DO NOTHING`,
    [conns.map((c) => c.id)]);
  return { brandId: brand.id, connectionIds: conns.map((c) => c.id), posts: fixtures.length, points: points.length, synthetic: true };
}

/**
 * Large-history generator for V3.1 benchmarks (parameterised; small default). Same deterministic shapes as the demo.
 * Example: generateLargeHistory({ workspaceId, days: 730, postsPerDay: 3, connectionsPerProvider: 4 }).
 */
export async function generateLargeHistory(o: DemoOptions): Promise<DemoResult> {
  return seedAnalyticsDemo({ days: 30, postsPerDay: 1, connectionsPerProvider: 1, ...o, brandName: o.brandName ?? 'Benchmark history (synthetic)', seed: o.seed ?? 'relay-analytics-bench-v1' });
}
