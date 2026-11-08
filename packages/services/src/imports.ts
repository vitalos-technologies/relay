// CSV import (V1.1): parse → per-row, per-destination validation preview → commit creates DRAFTS only.
// Never schedules or publishes. Columns (header row required, case-insensitive):
//   text (required) · title · link · destinations (instagram|facebook|telegram|x, separated by | or ;) ·
//   image_asset_id · scheduled_local_time (YYYY-MM-DDTHH:mm, kept as a suggestion) · timezone · tags (| separated)
import { createHash } from 'node:crypto';
import Papa from 'papaparse';
import { AppError, PROVIDERS, isValidTimeZone, resolveWallTime, type DraftContent, type Provider, type ValidationIssue } from '@social-lite/core';
import { getPool, many } from '@social-lite/db';
import type { Ctx } from './context.js';
import { assertBrand, isUuid, requireAction } from './tenancy.js';
import { brandConnections } from './posts/shared.js';
import { createPost, validateDraft, type PostRow } from './posts/service.js';
import { audit } from './audit.js';

export const MAX_IMPORT_ROWS = 200;
const MAX_CSV_BYTES = 512 * 1024;

export interface ImportRowPreview {
  row: number;            // 1-based data row (excluding header)
  title: string | null;
  text: string;
  link: string | null;
  destinations: Provider[];
  image_asset_id: string | null;
  suggested_time: { local: string; timezone: string; utc: string | null } | null;
  tags: string[];
  ok: boolean;
  issues: Array<Pick<ValidationIssue, 'field' | 'code' | 'message'> & { provider?: Provider }>;
}

export function csvHash(csv: string): string {
  return createHash('sha256').update(csv).digest('hex');
}

function cell(r: Record<string, string>, k: string): string {
  return (r[k] ?? '').trim();
}

export async function previewImport(ctx: Ctx, brandId: string, csv: string) {
  requireAction(ctx, 'drafts.edit');
  if (csv.length > MAX_CSV_BYTES) throw new AppError('payload_too_large', 'The CSV is larger than 512 KB');
  const db = getPool();
  const brand = await assertBrand(ctx, brandId, db);
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim().toLowerCase() });
  if (parsed.errors.length && !parsed.data.length) throw new AppError('validation_failed', `Could not read the CSV: ${parsed.errors[0]!.message}`);
  if (!parsed.meta.fields?.includes('text')) throw new AppError('validation_failed', 'The CSV needs a "text" column', { csv: 'Missing text column' });
  if (parsed.data.length > MAX_IMPORT_ROWS) throw new AppError('validation_failed', `At most ${MAX_IMPORT_ROWS} rows per import`);
  const conns = (await brandConnections(db, ctx.access.workspaceId, brandId)).filter((c) => !c.paused || true);
  const assetIds = parsed.data.map((r) => cell(r, 'image_asset_id')).filter(isUuid);
  const owned = new Set((assetIds.length ? await many<{ id: string }>(db, `SELECT id FROM assets WHERE workspace_id=$1 AND brand_id=$2 AND id = ANY($3::uuid[])`,
    [ctx.access.workspaceId, brandId, assetIds]) : []).map((a) => a.id));

  const rows: ImportRowPreview[] = [];
  for (const [i, r] of parsed.data.entries()) {
    const issues: ImportRowPreview['issues'] = [];
    const text = cell(r, 'text');
    const rawDest = cell(r, 'destinations');
    const wanted = (rawDest ? rawDest.split(/[|;,]/).map((d) => d.trim().toLowerCase()).filter(Boolean) : ['all']);
    const destinations = (wanted.includes('all') ? [...new Set(conns.map((c) => c.provider))] : wanted) as Provider[];
    for (const d of destinations) if (!(PROVIDERS as readonly string[]).includes(d)) issues.push({ field: 'destination', code: 'unknown_provider', message: `Unknown destination "${d}". Use instagram, facebook, telegram or x.` });
    const image = cell(r, 'image_asset_id') || null;
    if (image && (!isUuid(image) || !owned.has(image))) issues.push({ field: 'media', code: 'unknown_asset', message: 'image_asset_id is not an image in this brand’s library.' });
    let suggested: ImportRowPreview['suggested_time'] = null;
    const local = cell(r, 'scheduled_local_time');
    if (local) {
      const tz = cell(r, 'timezone') || brand.timezone;
      if (!isValidTimeZone(tz)) issues.push({ field: 'schedule', code: 'timezone', message: `Unknown time zone "${tz}".` });
      else {
        const t = resolveWallTime(local.replace(' ', 'T').slice(0, 16), tz);
        if (t.kind !== 'ok') issues.push({ field: 'schedule', code: t.kind, message: t.message });
        suggested = { local: local.replace(' ', 'T').slice(0, 16), timezone: tz, utc: t.kind === 'ok' ? t.instant.toISOString() : null };
      }
    }
    // Per-destination validation using the same rules as the composer.
    const chosen = conns.filter((c) => destinations.includes(c.provider));
    for (const d of destinations) if ((PROVIDERS as readonly string[]).includes(d) && !chosen.some((c) => c.provider === d)) {
      issues.push({ field: 'destination', code: 'not_connected', message: `${d} is not connected to this brand.` });
    }
    if (chosen.length) {
      const draft: DraftContent = { baseText: text, baseLink: cell(r, 'link') || null, baseAssetIds: image && owned.has(image) ? [image] : [],
        variants: chosen.map((c) => ({ connectionId: c.id, inheritText: true, inheritMedia: true })) };
      const v = await validateDraft(db, ctx, { brand_id: brandId, draft } as PostRow, chosen.map((c) => c.id));
      for (const is of v.issues) issues.push({ field: is.field, code: is.code, message: is.message, provider: is.provider });
    }
    rows.push({ row: i + 1, title: cell(r, 'title') || null, text, link: cell(r, 'link') || null, destinations, image_asset_id: image, suggested_time: suggested,
      tags: cell(r, 'tags').split('|').map((t) => t.trim()).filter(Boolean).slice(0, 20), ok: issues.length === 0, issues });
  }
  return { csv_hash: csvHash(csv), rows, valid: rows.filter((r) => r.ok).length, invalid: rows.filter((r) => !r.ok).length,
    note: 'Import creates drafts only. Nothing is scheduled or published.' };
}

/** Commit: re-validates the same CSV (hash must match the preview) and creates drafts for valid rows only. */
export async function commitImport(ctx: Ctx, brandId: string, csv: string, expectedHash: string, idemKey: string | null) {
  if (csvHash(csv) !== expectedHash) throw new AppError('conflict', 'The CSV changed since the preview. Preview it again.');
  const preview = await previewImport(ctx, brandId, csv);
  const conns = await brandConnections(getPool(), ctx.access.workspaceId, brandId);
  const created: Array<{ row: number; post_id: string }> = [];
  for (const r of preview.rows.filter((x) => x.ok)) {
    const ids = conns.filter((c) => r.destinations.includes(c.provider)).map((c) => c.id);
    const res = await createPost(ctx, brandId, {
      title: r.title ?? undefined,
      draft: { baseText: r.text, baseLink: r.link, baseAssetIds: r.image_asset_id ? [r.image_asset_id] : [], variants: ids.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) },
    }, idemKey ? `${idemKey}:${r.row}` : null);
    if (r.tags.length || r.suggested_time) {
      await getPool().query(`UPDATE posts SET tags=$2, source=$3 WHERE id=$1 AND workspace_id=$4`,
        [res.id, r.tags, JSON.stringify({ kind: 'csv_import', row: r.row, csv_hash: preview.csv_hash, suggested_time: r.suggested_time }), ctx.access.workspaceId]);
    }
    created.push({ row: r.row, post_id: res.id });
  }
  await audit(getPool(), { workspaceId: ctx.access.workspaceId, brandId, actorUserId: ctx.actor.userId, action: 'import.committed', resourceType: 'import', resourceId: preview.csv_hash.slice(0, 16),
    diff: { created: created.length, skipped_invalid: preview.invalid }, correlationId: ctx.correlationId });
  return { created, skipped: preview.rows.filter((x) => !x.ok).map((x) => x.row) };
}
