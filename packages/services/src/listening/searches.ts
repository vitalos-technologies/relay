// Saved searches (brief §15): brand names + aliases, keywords, exclusions, supported Boolean expressions, language,
// source and kind filters. Definitions are versioned (listening_search_versions); a definition change bumps the version
// and re-matches stored mentions in the background ('listening.rematch_requested' → listening-ingest).
import { AppError, notFound } from '@social-lite/core';
import {
  compileSearch, matchSearch, prepareText, PUBLIC_KINDS, QueryError, SEARCH_ROLES, type SavedSearchDto, type SearchDefinition,
} from '@social-lite/core/contracts/v35-listening';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { searchAccepts } from './ingest.js';
import { allSources, defaultDataset } from './sources.js';
import { canListen, datasetOf, listeningBrands, loadSearch, requireBrand, LISTENING_MANAGE, type ObservationRow, type SearchRow } from './shared.js';

const entry = z.string().trim().min(1).max(80);
const LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl'] as const;

export const definitionSchema = z.object({
  terms: z.array(entry).max(20).default([]),
  keywords: z.array(entry).max(30).default([]),
  exclusions: z.array(entry).max(30).default([]),
  boolean: z.string().trim().max(500).nullable().default(null),
  languages: z.array(z.enum(LANGS)).max(LANGS.length).default([]),
  sources: z.array(z.string().max(60)).max(20).default([]),
  kinds: z.array(z.enum(PUBLIC_KINDS as unknown as ['comment', 'mention', 'review'])).max(3).default([]),
});

export const createSearchSchema = definitionSchema.extend({
  brand_id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(SEARCH_ROLES).default('own'),
}).strict();

export const updateSearchSchema = definitionSchema.partial().extend({
  name: z.string().trim().min(1).max(80).optional(),
  role: z.enum(SEARCH_ROLES).optional(),
  expected_version: z.number().int().min(1),
}).strict();

export const previewSchema = definitionSchema.extend({ brand_id: z.string().uuid(), dataset: z.enum(['live', 'simulated']).optional() }).strict();

/** Validate a definition: known sources, a matchable query. QueryError → 422 with the character position. */
export function validateDefinition(d: SearchDefinition): void {
  const known = new Set(allSources().map((s) => s.key));
  const bad = d.sources.filter((s) => !known.has(s));
  if (bad.length) throw new AppError('validation_failed', 'Unknown source', { sources: `Unknown: ${bad.join(', ')}` });
  try {
    compileSearch(d);
  } catch (e) {
    if (e instanceof QueryError) throw new AppError('validation_failed', e.message, { boolean: `${e.message} (at character ${e.position + 1})` }, { position: e.position });
    throw e;
  }
}

const defOf = (s: Pick<SearchRow, 'terms' | 'keywords' | 'exclusions' | 'boolean_query' | 'languages' | 'sources' | 'kinds'>): SearchDefinition => ({
  terms: s.terms, keywords: s.keywords, exclusions: s.exclusions, boolean: s.boolean_query, languages: s.languages, sources: s.sources, kinds: s.kinds,
});

async function toDto(db: Queryable, ctx: Ctx, rows: SearchRow[]): Promise<SavedSearchDto[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const brands = [...new Set(rows.map((r) => r.brand_id))];
  const ds = new Map<string, boolean>();
  for (const b of brands) ds.set(b, (await defaultDataset(ctx.access.workspaceId, [b], db)) === 'simulated');
  const totals = await many<{ search_id: string; d7: number; h24: number }>(db,
    `SELECT lm.search_id, count(*) FILTER (WHERE lm.occurred_at >= now() - interval '7 days')::int AS d7, count(*) FILTER (WHERE lm.occurred_at >= now() - interval '24 hours')::int AS h24
       FROM listening_matches lm JOIN listening_observations o ON o.id = lm.observation_id JOIN listening_searches s ON s.id = lm.search_id
      WHERE lm.search_id = ANY($1::uuid[]) AND lm.occurred_at >= now() - interval '7 days' AND o.removed_at IS NULL AND o.excluded_at IS NULL AND o.duplicate_of IS NULL
        AND o.is_simulated = (SELECT x.sim FROM unnest($2::uuid[], $3::boolean[]) AS x(b, sim) WHERE x.b = s.brand_id)
      GROUP BY lm.search_id`, [ids, brands, brands.map((b) => ds.get(b)!)]);
  const rules = await many<{ search_id: string; n: number }>(db, `SELECT search_id, count(*)::int AS n FROM listening_alert_rules WHERE search_id = ANY($1::uuid[]) AND archived_at IS NULL GROUP BY search_id`, [ids]);
  const users = await many<{ id: string; name: string | null }>(db, `SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.created_by).filter(Boolean)]);
  return rows.map((r) => {
    const t = totals.find((x) => x.search_id === r.id);
    const u = users.find((x) => x.id === r.created_by);
    return {
      id: r.id, brand_id: r.brand_id, name: r.name, role: r.role, ...defOf(r), version: r.version,
      created_by: r.created_by ? { id: r.created_by, name: u?.name ?? null } : null, created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(),
      rematch: { state: r.rematch_state, matched_version: r.matched_version }, totals: { last_7d: t?.d7 ?? 0, last_24h: t?.h24 ?? 0 },
      alert_rules: rules.find((x) => x.search_id === r.id)?.n ?? 0, can_manage: canListen(ctx, r.brand_id, LISTENING_MANAGE),
    };
  });
}

export async function listSearches(ctx: Ctx, q: { brand_id?: string | null } = {}): Promise<{ items: SavedSearchDto[] }> {
  const brands = await listeningBrands(ctx, q.brand_id);
  const rows = await many<SearchRow>(getPool(), `SELECT * FROM listening_searches WHERE workspace_id=$1 AND brand_id = ANY($2::uuid[]) AND archived_at IS NULL ORDER BY CASE role WHEN 'own' THEN 0 WHEN 'competitor' THEN 1 ELSE 2 END, name`, [ctx.access.workspaceId, brands]);
  return { items: await toDto(getPool(), ctx, rows) };
}

export async function getSearch(ctx: Ctx, id: string): Promise<SavedSearchDto & { versions: Array<{ version: number; definition: SearchDefinition; created_at: string; created_by: string | null }> }> {
  const s = await loadSearch(ctx, id);
  const [dto] = await toDto(getPool(), ctx, [s]);
  const versions = await many<{ version: number; definition: SearchDefinition; created_at: Date; created_by: string | null }>(getPool(),
    `SELECT v.version, v.definition, v.created_at, u.name AS created_by FROM listening_search_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.search_id=$1 ORDER BY v.version DESC LIMIT 20`, [id]);
  return { ...dto!, versions: versions.map((v) => ({ version: v.version, definition: v.definition, created_at: v.created_at.toISOString(), created_by: v.created_by })) };
}

export async function createSearch(ctx: Ctx, input: z.infer<typeof createSearchSchema>): Promise<SavedSearchDto> {
  requireBrand(ctx, input.brand_id, LISTENING_MANAGE);
  const d: SearchDefinition = { terms: input.terms, keywords: input.keywords, exclusions: input.exclusions, boolean: input.boolean || null, languages: input.languages, sources: input.sources, kinds: input.kinds };
  validateDefinition(d);
  const s = await withTx(async (tx) => {
    const b = await maybeOne(tx, `SELECT 1 FROM brands WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [input.brand_id, ctx.access.workspaceId]);
    if (!b) throw notFound('Brand');
    const n = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM listening_searches WHERE workspace_id=$1 AND archived_at IS NULL`, [ctx.access.workspaceId]);
    if (n.n >= 100) throw new AppError('invalid_state', 'This workspace has 100 saved searches. Archive one first.');
    const row = await one<SearchRow>(tx,
      `INSERT INTO listening_searches(workspace_id, brand_id, name, role, terms, keywords, exclusions, boolean_query, languages, sources, kinds, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [ctx.access.workspaceId, input.brand_id, input.name, input.role, d.terms, d.keywords, d.exclusions, d.boolean, d.languages, d.sources, d.kinds, ctx.actor.userId]);
    await tx.query(`INSERT INTO listening_search_versions(search_id, version, workspace_id, definition, created_by) VALUES ($1,1,$2,$3,$4)`, [row.id, ctx.access.workspaceId, JSON.stringify(d), ctx.actor.userId]);
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'listening_search', aggregateId: row.id, eventType: 'listening.rematch_requested', payload: { version: 1 } });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: input.brand_id, actorUserId: ctx.actor.userId, action: 'listening.search_created', resourceType: 'listening_search', resourceId: row.id, diff: { name: input.name, role: input.role }, correlationId: ctx.correlationId });
    return row;
  });
  return (await toDto(getPool(), ctx, [s]))[0]!;
}

export async function updateSearch(ctx: Ctx, id: string, input: z.infer<typeof updateSearchSchema>): Promise<SavedSearchDto> {
  const s = await withTx(async (tx) => {
    const cur = await loadSearch(ctx, id, LISTENING_MANAGE, tx, true);
    if (cur.version !== input.expected_version) throw new AppError('version_conflict', 'Someone changed this search. Reload to see their version.', undefined, { current_version: cur.version });
    const prev = defOf(cur);
    const next: SearchDefinition = {
      terms: input.terms ?? prev.terms, keywords: input.keywords ?? prev.keywords, exclusions: input.exclusions ?? prev.exclusions,
      boolean: input.boolean === undefined ? prev.boolean : (input.boolean || null), languages: input.languages ?? prev.languages, sources: input.sources ?? prev.sources, kinds: input.kinds ?? prev.kinds,
    };
    validateDefinition(next);
    const changed = JSON.stringify(next) !== JSON.stringify(prev);
    const version = changed ? cur.version + 1 : cur.version;
    const row = await one<SearchRow>(tx,
      `UPDATE listening_searches SET name=$2, role=$3, terms=$4, keywords=$5, exclusions=$6, boolean_query=$7, languages=$8, sources=$9, kinds=$10, version=$11,
              rematch_state=CASE WHEN $12 THEN 'pending' ELSE rematch_state END, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, input.name ?? cur.name, input.role ?? cur.role, next.terms, next.keywords, next.exclusions, next.boolean, next.languages, next.sources, next.kinds, version, changed]);
    if (changed) {
      await tx.query(`INSERT INTO listening_search_versions(search_id, version, workspace_id, definition, created_by) VALUES ($1,$2,$3,$4,$5)`, [id, version, ctx.access.workspaceId, JSON.stringify(next), ctx.actor.userId]);
      await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'listening_search', aggregateId: id, eventType: 'listening.rematch_requested', payload: { version } });
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: cur.brand_id, actorUserId: ctx.actor.userId, action: 'listening.search_updated', resourceType: 'listening_search', resourceId: id, diff: { version, definition_changed: changed }, correlationId: ctx.correlationId });
    return row;
  });
  return (await toDto(getPool(), ctx, [s]))[0]!;
}

export async function archiveSearch(ctx: Ctx, id: string): Promise<{ ok: true }> {
  await withTx(async (tx) => {
    const s = await loadSearch(ctx, id, LISTENING_MANAGE, tx, true);
    await tx.query(`UPDATE listening_searches SET archived_at=now(), updated_at=now() WHERE id=$1`, [id]);
    await tx.query(`UPDATE listening_alert_rules SET enabled=false, archived_at=now() WHERE search_id=$1 AND archived_at IS NULL`, [id]);
    await tx.query(`DELETE FROM listening_matches WHERE search_id=$1`, [id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: s.brand_id, actorUserId: ctx.actor.userId, action: 'listening.search_archived', resourceType: 'listening_search', resourceId: id, correlationId: ctx.correlationId });
  });
  return { ok: true };
}

/** Test a definition against stored mentions (last 30 days) without saving it. */
export async function previewSearch(ctx: Ctx, input: z.infer<typeof previewSchema>): Promise<{ scanned: number; matched: number; sample: Array<{ id: string; text: string; occurred_at: string }>; dataset: 'live' | 'simulated' }> {
  requireBrand(ctx, input.brand_id);
  const d: SearchDefinition = { terms: input.terms, keywords: input.keywords, exclusions: input.exclusions, boolean: input.boolean || null, languages: input.languages, sources: input.sources, kinds: input.kinds };
  validateDefinition(d);
  const c = compileSearch(d);
  const dataset = datasetOf(input.dataset) ?? await defaultDataset(ctx.access.workspaceId, [input.brand_id]);
  const rows = await many<ObservationRow>(getPool(),
    `SELECT * FROM listening_observations WHERE workspace_id=$1 AND brand_id=$2 AND is_simulated=$3 AND removed_at IS NULL AND excluded_at IS NULL AND body IS NOT NULL
        AND occurred_at >= now() - interval '30 days' ORDER BY occurred_at DESC LIMIT 2000`, [ctx.access.workspaceId, input.brand_id, dataset === 'simulated']);
  const hits = rows.filter((o) => searchAccepts({ languages: d.languages, sources: d.sources, kinds: d.kinds }, o) && matchSearch(c, prepareText(o.body!)));
  return { scanned: rows.length, matched: hits.length, dataset, sample: hits.slice(0, 5).map((o) => ({ id: o.id, text: o.body!.slice(0, 280), occurred_at: o.occurred_at.toISOString() })) };
}

