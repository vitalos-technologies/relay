// Client handover export (V2 §7): ONE brand's content, revisions, delivery history and asset list
// (with short-lived signed download links) as a ZIP archive or a single JSON+CSV bundle.
//  - Permission: exports.create on THAT brand (V2 policy; 404 for brands outside the caller's reach).
//  - Scoped by workspace AND brand on every query; credentials, internal comments and other brands'
//    data are never included. Provider tokens are never exported.
//  - Rate-limited per user, budgeted (exports.count reservation → settle/release), audited.
//  - Signed links expire after HANDOVER_LINK_TTL_SECONDS; a link issued before a membership change
//    remains valid until then (documented residual window, spec §9).
import { z } from 'zod';
import { getPool, many, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { csvCell } from '../readmodels.js';
import { enforceRateLimit } from '../ratelimit.js';
import { signedGetUrl } from '../storage.js';
import { brandForPermission } from './scope.js';
import { releaseUsage, reserveUsage, settleUsage } from './budgets.js';
import { zip } from './zip.js';

export const HANDOVER_LINK_TTL_SECONDS = 15 * 60;
export const HANDOVER_RATE = { capacity: 3, refillPerSecond: 3 / 3600 };
const MAX_POSTS = 5_000;

export const handoverRequestSchema = z.object({ format: z.enum(['zip', 'json']).default('zip') }).strict();

const csv = (header: string[], rows: unknown[][]) => [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';

export interface HandoverResult { filename: string; contentType: string; body: Buffer; counts: Record<string, number> }

export async function handoverExport(ctx: Ctx, brandId: string, raw: unknown, db: Queryable = getPool()): Promise<HandoverResult> {
  const { format } = handoverRequestSchema.parse(raw ?? {});
  const brand = await brandForPermission(ctx, brandId, 'exports.create', db);
  await enforceRateLimit('handoverExport', `${ctx.actor.userId}`, HANDOVER_RATE);
  const reservation = await reserveUsage({ workspaceId: ctx.access.workspaceId, meter: 'exports.count', amount: 1, userId: ctx.actor.userId,
    ref: `export:handover:${brand.id}:${ctx.correlationId.slice(0, 40)}`, ttlSeconds: 600 });
  try {
    const ws = ctx.access.workspaceId;
    const posts = await many<{ id: string; title: string | null; tags: string[]; draft: Record<string, unknown>; version: number; created_at: Date; updated_at: Date; archived_at: Date | null; created_by_email: string | null }>(db,
      `SELECT p.id, p.title, p.tags, p.draft, p.version, p.created_at, p.updated_at, p.archived_at, u.email AS created_by_email
         FROM posts p LEFT JOIN users u ON u.id = p.created_by WHERE p.workspace_id=$1 AND p.brand_id=$2 ORDER BY p.created_at LIMIT $3`, [ws, brand.id, MAX_POSTS]);
    const postIds = posts.map((p) => p.id);
    const revisions = postIds.length ? await many<{ id: string; post_id: string; revision_number: number; base_text: string; base_link: string | null; base_asset_ids: string[]; content_hash: string; created_at: Date; created_by_email: string | null }>(db,
      `SELECT r.id, r.post_id, r.revision_number, r.base_text, r.base_link, r.base_asset_ids, r.content_hash, r.created_at, u.email AS created_by_email
         FROM post_revisions r LEFT JOIN users u ON u.id = r.created_by WHERE r.workspace_id=$1 AND r.post_id = ANY($2::uuid[]) ORDER BY r.post_id, r.revision_number`, [ws, postIds]) : [];
    const variants = revisions.length ? await many<{ revision_id: string; connection_id: string; rendered_text: string; link: string | null; format: string; asset_ids: string[] }>(db,
      `SELECT v.revision_id, v.connection_id, v.rendered_text, v.link, v.format, v.asset_ids FROM variants v WHERE v.workspace_id=$1 AND v.revision_id = ANY($2::uuid[])`,
      [ws, revisions.map((r) => r.id)]) : [];
    const deliveries = await many<{ id: string; post_id: string; revision_id: string; provider: string; display_name: string; is_mock: boolean; state: string; due_at: Date; published_at: Date | null; provider_url: string | null; provider_ids: string[]; attempt_count: number; last_error_code: string | null; last_error_message: string | null }>(db,
      `SELECT d.id, d.post_id, d.revision_id, d.provider::text, c.display_name, d.is_mock, d.state::text, d.due_at, d.published_at, d.provider_url, d.provider_ids, d.attempt_count, d.last_error_code, d.last_error_message
         FROM deliveries d JOIN connections c ON c.id = d.connection_id AND c.workspace_id = d.workspace_id
        WHERE d.workspace_id=$1 AND d.brand_id=$2 ORDER BY d.due_at`, [ws, brand.id]);
    const connections = await many<{ id: string; provider: string; display_name: string; username: string | null; is_mock: boolean; status: string; disconnected_at: Date | null }>(db,
      `SELECT id, provider::text, display_name, username, is_mock, status::text, disconnected_at FROM connections WHERE workspace_id=$1 AND brand_id=$2 ORDER BY created_at`, [ws, brand.id]);
    const assets = await many<{ id: string; object_key: string; original_filename: string | null; mime: string | null; bytes: string | null; width: number | null; height: number | null; status: string; alt_text: string | null; tags: string[]; created_at: Date }>(db,
      `SELECT id, object_key, original_filename, mime, bytes, width, height, status, alt_text, tags, created_at FROM assets WHERE workspace_id=$1 AND brand_id=$2 ORDER BY created_at`, [ws, brand.id]);
    const now = new Date();
    const linksExpire = new Date(now.getTime() + HANDOVER_LINK_TTL_SECONDS * 1000);
    const assetRows = await Promise.all(assets.map(async (a) => ({
      id: a.id, filename: a.original_filename, mime: a.mime, bytes: a.bytes === null ? null : Number(a.bytes), width: a.width, height: a.height, status: a.status,
      alt_text: a.alt_text, tags: a.tags, created_at: a.created_at.toISOString(),
      download_url: (a.status === 'ready' || a.status === 'archived') && a.mime
        ? await signedGetUrl(a.object_key, HANDOVER_LINK_TTL_SECONDS, { contentType: a.mime, filename: a.original_filename ?? `${a.id}` }) : null,
    })));
    const connName = (id: string) => connections.find((c) => c.id === id)?.display_name ?? null;
    const content = posts.map((p) => ({
      id: p.id, title: p.title, tags: p.tags, version: p.version, created_at: p.created_at.toISOString(), updated_at: p.updated_at.toISOString(),
      archived_at: p.archived_at?.toISOString() ?? null, created_by: p.created_by_email, working_draft: p.draft,
      revisions: revisions.filter((r) => r.post_id === p.id).map((r) => ({
        revision: r.revision_number, created_at: r.created_at.toISOString(), created_by: r.created_by_email, text: r.base_text, link: r.base_link,
        asset_ids: r.base_asset_ids, content_hash: r.content_hash,
        variants: variants.filter((v) => v.revision_id === r.id).map((v) => ({ destination: connName(v.connection_id), connection_id: v.connection_id, text: v.rendered_text, link: v.link, format: v.format, asset_ids: v.asset_ids })),
      })),
    }));
    const history = deliveries.map((d) => ({
      id: d.id, post_id: d.post_id, revision: revisions.find((r) => r.id === d.revision_id)?.revision_number ?? null, destination: d.display_name, provider: d.provider,
      simulated: d.is_mock, state: d.state, due_at: d.due_at.toISOString(), published_at: d.published_at?.toISOString() ?? null, provider_url: d.provider_url,
      provider_ids: d.provider_ids, attempts: d.attempt_count, error_code: d.last_error_code, error_message: d.last_error_message,
    }));
    const manifest = {
      kind: 'social-lite.client-handover', version: 1, generated_at: now.toISOString(), generated_by: ctx.actor.email,
      brand: { id: brand.id, name: brand.name, timezone: brand.timezone },
      counts: { posts: content.length, revisions: revisions.length, deliveries: history.length, assets: assetRows.length, destinations: connections.length },
      truncated: posts.length >= MAX_POSTS,
      download_links: { ttl_seconds: HANDOVER_LINK_TTL_SECONDS, expire_at: linksExpire.toISOString(), note: 'Asset links are signed and expire; download them promptly. Access tokens and internal notes are never included.' },
      destinations: connections.map((c) => ({ id: c.id, provider: c.provider, name: c.display_name, username: c.username, simulated: c.is_mock, status: c.disconnected_at ? 'disconnected' : c.status })),
    };
    const files = {
      'posts.csv': csv(['post_id', 'title', 'tags', 'version', 'created_at', 'updated_at', 'archived_at', 'created_by', 'latest_revision', 'latest_text'],
        content.map((p) => { const last = p.revisions[p.revisions.length - 1]; return [p.id, p.title, p.tags, p.version, p.created_at, p.updated_at, p.archived_at, p.created_by, last?.revision ?? null, last?.text ?? (p.working_draft as { baseText?: string }).baseText ?? '']; })),
      'revisions.csv': csv(['post_id', 'revision', 'created_at', 'created_by', 'text', 'link', 'content_hash'],
        content.flatMap((p) => p.revisions.map((r) => [p.id, r.revision, r.created_at, r.created_by, r.text, r.link, r.content_hash]))),
      'deliveries.csv': csv(['delivery_id', 'post_id', 'revision', 'destination', 'provider', 'simulated', 'state', 'due_at_utc', 'published_at_utc', 'provider_url', 'provider_ids', 'attempts', 'error_code', 'error_message'],
        history.map((h) => [h.id, h.post_id, h.revision, h.destination, h.provider, h.simulated ? 'yes' : 'no', h.state, h.due_at, h.published_at, h.provider_url, h.provider_ids, h.attempts, h.error_code, h.error_message])),
      'assets.csv': csv(['asset_id', 'filename', 'mime', 'bytes', 'width', 'height', 'status', 'alt_text', 'tags', 'created_at', 'download_url_expires_at', 'download_url'],
        assetRows.map((a) => [a.id, a.filename, a.mime, a.bytes, a.width, a.height, a.status, a.alt_text, a.tags, a.created_at, a.download_url ? linksExpire.toISOString() : null, a.download_url])),
    };
    const counts = manifest.counts;
    const slug = brand.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'brand';
    const stamp = now.toISOString().slice(0, 10);
    let result: HandoverResult;
    if (format === 'json') {
      const body = Buffer.from(JSON.stringify({ manifest, posts: content, deliveries: history, assets: assetRows, csv: files }, null, 2));
      result = { filename: `handover-${slug}-${stamp}.json`, contentType: 'application/json; charset=utf-8', body, counts };
    } else {
      const readme = `Client handover: ${brand.name}\r\nGenerated ${now.toISOString()} by ${ctx.actor.email}\r\n\r\nmanifest.json  brand, destinations, counts\r\nposts.json     every post with all revisions and per-destination variants\r\n*.csv          the same data as spreadsheets (formula-safe)\r\n\r\nAsset download links expire at ${linksExpire.toISOString()}.\r\n`;
      const body = zip([
        { name: 'README.txt', data: readme },
        { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
        { name: 'posts.json', data: JSON.stringify(content, null, 2) },
        { name: 'deliveries.json', data: JSON.stringify(history, null, 2) },
        { name: 'assets.json', data: JSON.stringify(assetRows, null, 2) },
        ...Object.entries(files).map(([name, data]) => ({ name, data })),
      ], now);
      result = { filename: `handover-${slug}-${stamp}.zip`, contentType: 'application/zip', body, counts };
    }
    await audit(db, { workspaceId: ctx.access.workspaceId, brandId: brand.id, actorUserId: ctx.actor.userId, action: 'export.handover', resourceType: 'brand', resourceId: brand.id,
      diff: { format, ...counts, bytes: result.body.length, link_ttl_seconds: HANDOVER_LINK_TTL_SECONDS }, correlationId: ctx.correlationId });
    await settleUsage(reservation.id, 1);
    return result;
  } catch (err) {
    await releaseUsage(reservation.id).catch(() => undefined);
    throw err;
  }
}
