// V3.1 §8 global search (command menu) and recent items.
//  - Server-side authorization on every result: each kind is searched only on brands where the caller holds that
//    kind's read permission NOW (fresh policy per request); settings destinations by the permission they need.
//  - Snippets are built only from fields of the matched item the caller may read (post title/base text, campaign
//    description, asset alt text). Never from comments, variant overrides, other brands or workspaces. Snippets are
//    plain text plus highlight ranges (no HTML).
//  - Bounded: ≤ 6 terms, ≤ 20 results per kind, one connection with a statement timeout; cancellable: an aborted
//    request (AbortSignal) cancels the running SQL statement (pg_cancel_backend) and stops further queries.
//  - Revocation/workspace switch: nothing is cached server-side; responses carry workspace_id + policy_version so a
//    client cache keyed by them is dropped on switch/revocation (docs/V3_1_DATA_API.md).
//  - PostgreSQL full-text search ('simple' config, prefix terms) on the expression GIN indexes of migration 021.
import { AppError, notFound, type Permission } from '@social-lite/core';
import {
  SEARCH_KINDS, SEARCH_LIMITS, SETTINGS_DESTINATIONS, type RecentItemsResponse, type SearchKind, type SearchRequest, type SearchResponse, type SearchResult,
} from '@social-lite/core/contracts/v31-data';
import { getPool, many, maybeOne, type PoolClient, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { hasAnywhere } from '../authz.js';
import { assertUuid, authorizeCtx } from '../tenancy.js';
import { excerpt } from '../posts/shared.js';

export class SearchCancelledError extends Error { constructor() { super('search cancelled'); this.name = 'SearchCancelledError'; } }

const KIND_PERMISSION: Record<Exclude<SearchKind, 'setting'>, Permission> = { post: 'content.read', campaign: 'content.read', asset: 'assets.read', brand: 'brands.read' };
const HL_START = '\u0001';
const HL_STOP = '\u0002';
const HEADLINE_OPTS = `StartSel=${HL_START}, StopSel=${HL_STOP}, MaxWords=22, MinWords=8, ShortWord=1, HighlightAll=false, MaxFragments=1, FragmentDelimiter=" … "`;
const RECENT_KEEP = 50;

/** Letters/digits only (no tsquery syntax can be injected), lower-cased, bounded. */
export function searchTerms(q: string): string[] {
  const raw = (q ?? '').slice(0, SEARCH_LIMITS.maxQueryLength).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(raw.map((t) => t.slice(0, 40)))].slice(0, SEARCH_LIMITS.maxTerms);
}

export function toTsQuery(terms: string[]): string {
  return terms.map((t) => `${t}:*`).join(' & ');
}

/** Turn a headline with sentinel markers into plain text + [start, end) highlight ranges. */
export function parseHeadline(h: string | null, max = 220): { text: string | null; highlights: Array<[number, number]> } {
  if (!h) return { text: null, highlights: [] };
  let text = '';
  const highlights: Array<[number, number]> = [];
  let open = -1;
  for (const ch of h.replace(/\s+/g, ' ')) {
    if (ch === HL_START) { open = text.length; continue; }
    if (ch === HL_STOP) { if (open >= 0 && text.length > open) highlights.push([open, text.length]); open = -1; continue; }
    text += ch;
  }
  text = text.trim();
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return { text: text || null, highlights: highlights.filter(([s, e]) => e <= text.length && s < e) };
}

/** Brands (in this workspace) on which the caller holds `perm` now. */
async function brandsWith(db: Queryable, ctx: Ctx, perm: Permission): Promise<string[]> {
  const ids = ctx.access.brandIds ?? (await many<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND archived_at IS NULL`, [ctx.access.workspaceId])).map((b) => b.id);
  return ids.filter((b) => authorizeCtx(ctx, perm, { brandId: b }).allowed);
}

/** Navigation filter for settings destinations (each page enforces its own permissions again). */
function holdsAnywhere(ctx: Ctx, perm: Permission): boolean {
  const a = ctx.access.authz;
  return a ? hasAnywhere(a, perm) : authorizeCtx(ctx, perm).allowed;
}

/** Run fn on one dedicated connection with a statement timeout; abort ⇒ cancel the running statement. */
async function withCancellableClient<T>(signal: AbortSignal | undefined, fn: (c: PoolClient, check: () => void) => Promise<T>): Promise<T> {
  if (signal?.aborted) throw new SearchCancelledError();
  const pool = getPool();
  const client = await pool.connect();
  const pid = (client as unknown as { processID?: number }).processID;
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    if (pid) void pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const check = () => { if (cancelled || signal?.aborted) throw new SearchCancelledError(); };
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Number(SEARCH_LIMITS.timeoutMs)}`);
    const out = await fn(client, check);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (cancelled || signal?.aborted) throw new SearchCancelledError();
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    client.release();
  }
}

const isTimeout = (err: unknown) => (err as { code?: string }).code === '57014';

export async function globalSearch(ctx: Ctx, req: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
  const started = Date.now();
  const q = String(req.q ?? '').slice(0, SEARCH_LIMITS.maxQueryLength);
  const terms = searchTerms(q);
  const limit = Math.min(Math.max(req.limit ?? SEARCH_LIMITS.perKindDefault, 1), SEARCH_LIMITS.perKindMax);
  const kinds = (req.kinds?.length ? req.kinds : SEARCH_KINDS).filter((k) => SEARCH_KINDS.includes(k));
  const base = { query: q, workspace_id: ctx.access.workspaceId, policy_version: ctx.access.authz?.policyVersion ?? 0 };
  const results: SearchResult[] = [];
  const truncated: SearchKind[] = [];
  let partial = false;
  if (!terms.length) return { ...base, results, truncated, partial, took_ms: Date.now() - started };
  const tsq = toTsQuery(terms);
  const archived = req.include_archived ? '' : 'AND x.archived_at IS NULL';
  await withCancellableClient(signal, async (db, check) => {
    const take = <T>(rows: T[]) => { const more = rows.length > limit; return { rows: rows.slice(0, limit), more }; };
    for (const kind of kinds) {
      check();
      try {
        if (kind === 'post') {
          const brands = await brandsWith(db, ctx, KIND_PERMISSION.post);
          if (!brands.length) continue;
          const r = take(await many<{ id: string; brand_id: string; title: string | null; archived_at: Date | null; updated_at: Date; text: string; hl: string | null }>(db,
            `SELECT x.id, x.brand_id, x.title, x.archived_at, x.updated_at, left(coalesce(x.draft->>'baseText', ''), 300) AS text,
                    ts_headline('simple', translate(left(coalesce(x.draft->>'baseText', ''), 4000), E'\\x01\\x02', ''), q, $5) AS hl
               FROM posts x, to_tsquery('simple', $3) q
              WHERE x.workspace_id=$1 AND x.brand_id = ANY($2::uuid[]) AND x.deleted_at IS NULL ${archived}
                AND to_tsvector('simple', coalesce(x.title, '') || ' ' || coalesce(x.draft->>'baseText', '')) @@ q
              ORDER BY x.updated_at DESC, x.id -- recency, not ts_rank: measured p95 15 ms vs 163 ms (scripts/v31-search-bench.ts)
              LIMIT $4`, [ctx.access.workspaceId, brands, tsq, limit + 1, HEADLINE_OPTS]));
          if (r.more) truncated.push(kind);
          for (const p of r.rows) {
            const h = parseHeadline(p.hl);
            results.push({ kind, id: p.id, title: p.title?.trim() || excerpt(p.text, 60) || 'Untitled post', snippet: h.text, highlights: h.highlights, brand_id: p.brand_id,
              href: `/posts/${p.id}`, meta: { archived: !!p.archived_at, updated_at: p.updated_at.toISOString() } });
          }
        } else if (kind === 'campaign') {
          const brands = await brandsWith(db, ctx, KIND_PERMISSION.campaign);
          if (!brands.length) continue;
          const r = take(await many<{ id: string; brand_id: string; name: string; archived_at: Date | null; hl: string | null }>(db,
            `SELECT x.id, x.brand_id, x.name, x.archived_at,
                    CASE WHEN x.description IS NULL THEN NULL ELSE ts_headline('simple', translate(left(x.description, 2000), E'\\x01\\x02', ''), q, $5) END AS hl
               FROM campaigns x, to_tsquery('simple', $3) q
              WHERE x.workspace_id=$1 AND x.brand_id = ANY($2::uuid[]) ${archived}
                AND to_tsvector('simple', x.name || ' ' || coalesce(x.description, '')) @@ q
              ORDER BY x.name, x.id LIMIT $4`,
            [ctx.access.workspaceId, brands, tsq, limit + 1, HEADLINE_OPTS]));
          if (r.more) truncated.push(kind);
          for (const c of r.rows) {
            const h = parseHeadline(c.hl);
            results.push({ kind, id: c.id, title: c.name, snippet: h.text, highlights: h.highlights, brand_id: c.brand_id, href: `/planner?campaign=${c.id}`, meta: { archived: !!c.archived_at } });
          }
        } else if (kind === 'asset') {
          const brands = await brandsWith(db, ctx, KIND_PERMISSION.asset);
          if (!brands.length) continue;
          const r = take(await many<{ id: string; brand_id: string; original_filename: string | null; status: string; mime: string | null; hl: string | null }>(db,
            `SELECT x.id, x.brand_id, x.original_filename, x.status::text AS status, x.mime,
                    CASE WHEN x.alt_text IS NULL THEN NULL ELSE ts_headline('simple', translate(left(x.alt_text, 1500), E'\\x01\\x02', ''), q, $5) END AS hl
               FROM assets x, to_tsquery('simple', $3) q
              WHERE x.workspace_id=$1 AND x.brand_id = ANY($2::uuid[]) AND x.deleted_at IS NULL AND x.status IN ('ready'${req.include_archived ? ",'archived'" : ''})
                AND to_tsvector('simple', coalesce(x.original_filename, '') || ' ' || coalesce(x.alt_text, '') || ' ' || relay_tags_text(x.tags)) @@ q
              ORDER BY x.created_at DESC, x.id LIMIT $4`, [ctx.access.workspaceId, brands, tsq, limit + 1, HEADLINE_OPTS]));
          if (r.more) truncated.push(kind);
          for (const a of r.rows) {
            const h = parseHeadline(a.hl);
            results.push({ kind, id: a.id, title: a.original_filename ?? 'Untitled file', snippet: h.text, highlights: h.highlights, brand_id: a.brand_id,
              href: `/library?asset=${a.id}`, meta: { status: a.status, mime: a.mime } });
          }
        } else if (kind === 'brand') {
          const brands = await brandsWith(db, ctx, KIND_PERMISSION.brand);
          if (!brands.length) continue;
          const likes = terms.map((t) => `%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
          const r = take(await many<{ id: string; name: string; timezone: string }>(db,
            `SELECT id, name, timezone FROM brands WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND archived_at IS NULL AND name ILIKE ALL($3::text[]) ORDER BY name, id LIMIT $4`,
            [ctx.access.workspaceId, brands, likes, limit + 1]));
          if (r.more) truncated.push(kind);
          for (const b of r.rows) results.push({ kind, id: b.id, title: b.name, snippet: null, highlights: [], brand_id: b.id, href: `/settings/workspace/branding?brand=${b.id}`, meta: { timezone: b.timezone } });
        } else if (kind === 'setting') {
          const hits = SETTINGS_DESTINATIONS.filter((d) => {
            const words = `${d.label} ${d.keywords}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
            return terms.every((t) => words.some((w) => w.startsWith(t)));
          }).filter((d) => !d.requires || holdsAnywhere(ctx, d.requires));
          if (hits.length > limit) truncated.push(kind);
          for (const d of hits.slice(0, limit)) results.push({ kind, id: d.id, title: d.label, snippet: null, highlights: [], brand_id: null, href: d.href, meta: {} });
        }
      } catch (err) {
        if (isTimeout(err) && !signal?.aborted) { partial = true; break; } // bounded: return what was found in time
        throw err;
      }
    }
  }).catch((err) => {
    if (err instanceof SearchCancelledError) throw err;
    if (isTimeout(err)) { partial = true; return; }
    throw err;
  });
  return { ...base, results, truncated, partial, took_ms: Date.now() - started };
}

// ------------------------------------------------------------------ recent items

type RecentKind = Exclude<SearchKind, 'setting'>;
const RECENT_KINDS: RecentKind[] = ['post', 'campaign', 'asset', 'brand'];

async function loadOne(db: Queryable, ctx: Ctx, kind: RecentKind, id: string): Promise<SearchResult | null> {
  const ws = ctx.access.workspaceId;
  const ok = (brandId: string) => (ctx.access.brandIds === null || ctx.access.brandIds.includes(brandId)) && authorizeCtx(ctx, KIND_PERMISSION[kind], { brandId }).allowed;
  if (kind === 'post') {
    const p = await maybeOne<{ id: string; brand_id: string; title: string | null; text: string; archived_at: Date | null }>(db,
      `SELECT id, brand_id, title, left(coalesce(draft->>'baseText', ''), 300) AS text, archived_at FROM posts WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, [id, ws]);
    if (!p || !ok(p.brand_id)) return null;
    return { kind, id, title: p.title?.trim() || excerpt(p.text, 60) || 'Untitled post', snippet: excerpt(p.text, 160) || null, highlights: [], brand_id: p.brand_id, href: `/posts/${id}`, meta: { archived: !!p.archived_at } };
  }
  if (kind === 'campaign') {
    const c = await maybeOne<{ id: string; brand_id: string; name: string; description: string | null }>(db, `SELECT id, brand_id, name, description FROM campaigns WHERE id=$1 AND workspace_id=$2`, [id, ws]);
    if (!c || !ok(c.brand_id)) return null;
    return { kind, id, title: c.name, snippet: c.description ? excerpt(c.description, 160) : null, highlights: [], brand_id: c.brand_id, href: `/planner?campaign=${id}`, meta: {} };
  }
  if (kind === 'asset') {
    const a = await maybeOne<{ id: string; brand_id: string; original_filename: string | null; status: string }>(db,
      `SELECT id, brand_id, original_filename, status::text AS status FROM assets WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, [id, ws]);
    if (!a || !ok(a.brand_id)) return null;
    return { kind, id, title: a.original_filename ?? 'Untitled file', snippet: null, highlights: [], brand_id: a.brand_id, href: `/library?asset=${id}`, meta: { status: a.status } };
  }
  const b = await maybeOne<{ id: string; name: string }>(db, `SELECT id, name FROM brands WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [id, ws]);
  if (!b || !ok(b.id)) return null;
  return { kind, id, title: b.name, snippet: null, highlights: [], brand_id: b.id, href: `/settings/workspace/branding?brand=${id}`, meta: {} };
}

/** POST /api/search/recent — record that the caller opened an item (only if they can read it now). */
export async function recordRecent(ctx: Ctx, kind: RecentKind, id: string): Promise<{ ok: true }> {
  if (!RECENT_KINDS.includes(kind)) throw new AppError('validation_failed', 'Unknown kind', { kind: 'Unknown' });
  assertUuid(id, 'Item');
  const db = getPool();
  if (!(await loadOne(db, ctx, kind, id))) throw notFound('Item');
  await db.query(
    `INSERT INTO recent_items(workspace_id, user_id, kind, item_id, viewed_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (workspace_id, user_id, kind, item_id) DO UPDATE SET viewed_at=now()`, [ctx.access.workspaceId, ctx.actor.userId, kind, id]);
  await db.query(
    `DELETE FROM recent_items WHERE workspace_id=$1 AND user_id=$2 AND (kind, item_id) IN (
       SELECT kind, item_id FROM recent_items WHERE workspace_id=$1 AND user_id=$2 ORDER BY viewed_at DESC OFFSET $3)`, [ctx.access.workspaceId, ctx.actor.userId, RECENT_KEEP]);
  return { ok: true };
}

/** GET /api/search/recent — the caller's recent items, re-authorized now (revoked/deleted items vanish). */
export async function recentItems(ctx: Ctx, opts: { limit?: number } = {}): Promise<RecentItemsResponse> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), SEARCH_LIMITS.recentMax);
  const db = getPool();
  const rows = await many<{ kind: RecentKind; item_id: string }>(db,
    `SELECT kind, item_id FROM recent_items WHERE workspace_id=$1 AND user_id=$2 ORDER BY viewed_at DESC LIMIT $3`, [ctx.access.workspaceId, ctx.actor.userId, RECENT_KEEP]);
  const items: SearchResult[] = [];
  for (const r of rows) {
    if (items.length >= limit) break;
    const x = await loadOne(db, ctx, r.kind, r.item_id);
    if (x) items.push(x);
  }
  return { workspace_id: ctx.access.workspaceId, policy_version: ctx.access.authz?.policyVersion ?? 0, items };
}
