// Source imports: authorize → select → preview → (this file) request → worker fetch/validate → snapshot → drafts.
// Idempotency key = sha256(source identity + version/fingerprint + brand + action + selection [+ explicit copy nonce]):
// retries never duplicate an import; a person can intentionally ask for another copy (copy_nonce).
// The worker re-checks the requester's CURRENT authority before touching the source or creating anything.
import { createHash, randomUUID } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import type { ImportAction, ImportDto, SuggestionsMode } from '@social-lite/core/contracts/content-hub';
import { getPool, many, maybeOne, withTx } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { loadAccess, requireAction, assertUuid, brandAllowed } from '../tenancy.js';
import { writeOutbox } from '../outbox.js';
import { log } from '../log.js';
import { ingestKind, ingestLimit, ingestServerBytes } from '../media/ingest.js';
import { connectionForBrand, withSource, type ContentConnectionRow } from './connections.js';
import { LIMITS } from './config.js';
import { downloadFile, getFileResolvingShortcut, MIME } from './google.js';
import { fetchDocument, loadSourceItem, recordItemAccessFailure, sourceAppError, type FetchedDocument, type SourceItemRow } from './items.js';
import { sectionText, sha256Hex, type NormalizedSection } from './normalize.js';
import { campaignByName, clampDraftText, createSnapshot, insertDraft, linkPost } from './store.js';
import { SourceAccessError } from './transport.js';

export interface ImportRow {
  id: string; workspace_id: string; brand_id: string; connection_id: string; source_item_id: string | null; snapshot_id: string | null; action: ImportAction;
  idempotency_key: string; status: ImportDto['status']; options: ImportOptions; result: ImportDto['result']; error_code: string | null; error_message: string | null;
  attempts: number; run_id: string | null; requested_by: string | null; created_at: Date; started_at: Date | null; completed_at: Date | null;
}

export interface ImportOptions {
  fingerprint?: string; section_ids?: string[]; suggestions_mode?: SuggestionsMode; combine?: boolean; campaign_name?: string | null;
  connection_ids?: string[]; row_ids?: string[]; mapping_version?: number; create_draft?: boolean; copy_nonce?: string | null; refresh_key?: string;
}

export function importJson(r: ImportRow, deduplicated = false): ImportDto {
  return {
    id: r.id, action: r.action, status: r.status, brand_id: r.brand_id, connection_id: r.connection_id, source_item_id: r.source_item_id, snapshot_id: r.snapshot_id,
    deduplicated, created_at: r.created_at.toISOString(), completed_at: r.completed_at?.toISOString() ?? null, result: r.result ?? {},
    error: r.error_code ? { code: r.error_code, message: r.error_message ?? 'Import failed' } : null,
  };
}

export const importKey = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export interface ImportRequestInput {
  source_item_id: string; action: ImportAction; fingerprint?: string; section_ids?: string[]; suggestions_mode?: SuggestionsMode; combine?: boolean;
  campaign_name?: string | null; connection_ids?: string[]; row_ids?: string[]; create_draft?: boolean; copy_nonce?: string | null;
}

/** Validate + record an import request and enqueue it for the worker (no source calls here). */
export async function requestImport(ctx: Ctx, input: ImportRequestInput): Promise<ImportDto> {
  const item = await loadSourceItem(ctx, input.source_item_id);
  if (item.state !== 'linked') throw new AppError('invalid_state', 'This source is not readable right now (access lost or disconnected).');
  const action = input.action;
  const kindOk: Record<string, SourceItemRow['item_kind'][]> = {
    media_asset: ['drive_file'], doc_drafts: ['google_doc', 'notion_page'], doc_campaign: ['google_doc', 'notion_page'], notion_page_draft: ['notion_page'],
    notion_rows: ['notion_data_source'],
  };
  if (!kindOk[action]?.includes(item.item_kind)) throw new AppError('validation_failed', 'This action does not apply to this source.', { action: 'Not available for this item' });
  await connectionForBrand(ctx, item.connection_id, item.brand_id, action === 'media_asset' ? 'assets.upload' : 'content.create');
  if (action === 'doc_campaign') requireAction(ctx, 'content.edit', { brandId: item.brand_id });
  if (action === 'media_asset' && input.create_draft) requireAction(ctx, 'content.create', { brandId: item.brand_id });

  const opts: ImportOptions = { copy_nonce: input.copy_nonce?.slice(0, 64) || null };
  let identity: unknown[];
  if (action === 'media_asset') {
    opts.create_draft = !!input.create_draft;
    opts.connection_ids = input.connection_ids?.slice(0, 50) ?? [];
    identity = [item.external_id, item.source_version, item.source_checksum, opts.create_draft, [...opts.connection_ids].sort()];
  } else if (action === 'notion_rows') {
    const rows = [...new Set((input.row_ids ?? []).map(String))];
    if (!rows.length || rows.length > LIMITS.notionRowImport) throw new AppError('validation_failed', `Select 1-${LIMITS.notionRowImport} rows.`, { row_ids: 'Select rows to import' });
    const mapping = await maybeOne<{ version: number }>(getPool(), `SELECT version FROM import_mappings WHERE source_item_id=$1 AND workspace_id=$2`, [item.id, ctx.access.workspaceId]);
    if (!mapping) throw new AppError('invalid_state', 'Map the data source properties before importing rows.');
    opts.row_ids = rows.sort();
    opts.mapping_version = mapping.version;
    opts.connection_ids = input.connection_ids?.slice(0, 50) ?? [];
    identity = [item.external_id, opts.row_ids, mapping.version, [...opts.connection_ids].sort()];
  } else {
    if (!input.fingerprint || !/^[0-9a-f]{64}$/.test(input.fingerprint)) throw new AppError('validation_failed', 'Preview the source first.', { fingerprint: 'Preview fingerprint required' });
    const sections = [...new Set((input.section_ids ?? []).map(String))];
    if (!sections.length || sections.length > LIMITS.maxSectionsPerImport) throw new AppError('validation_failed', `Select 1-${LIMITS.maxSectionsPerImport} sections.`, { section_ids: 'Select sections' });
    if (action === 'doc_campaign' && !input.campaign_name?.trim()) throw new AppError('validation_failed', 'Name the campaign.', { campaign_name: 'Required' });
    opts.fingerprint = input.fingerprint;
    opts.section_ids = sections;
    opts.suggestions_mode = input.suggestions_mode && ['exclude', 'accept', 'inline'].includes(input.suggestions_mode) ? input.suggestions_mode : 'exclude';
    opts.combine = !!input.combine;
    opts.campaign_name = action === 'doc_campaign' ? input.campaign_name!.trim().slice(0, 120) : null;
    opts.connection_ids = input.connection_ids?.slice(0, 50) ?? [];
    identity = [item.external_id, input.fingerprint, [...sections].sort(), opts.suggestions_mode, opts.combine, opts.campaign_name, [...opts.connection_ids].sort()];
  }
  const key = importKey([item.connection_id, item.item_kind, ...identity, item.brand_id, action, opts.copy_nonce]);
  return enqueueImport(ctx, { item, action, key, options: opts });
}

/** Insert (or find) the import for an idempotency key; failed/cancelled imports are re-queued, never duplicated. */
export async function enqueueImport(ctx: Ctx, p: { item: SourceItemRow; action: ImportAction; key: string; options: ImportOptions }): Promise<ImportDto> {
  return withTx(async (tx) => {
    const inserted = await maybeOne<ImportRow>(tx,
      `INSERT INTO imports(workspace_id, brand_id, connection_id, source_item_id, action, idempotency_key, options, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING *`,
      [ctx.access.workspaceId, p.item.brand_id, p.item.connection_id, p.item.id, p.action, p.key, JSON.stringify(p.options), ctx.actor.userId]);
    let row = inserted;
    let dedup = false;
    if (!row) {
      const existing = await maybeOne<ImportRow>(tx, `SELECT * FROM imports WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`, [ctx.access.workspaceId, p.key]);
      if (!existing) throw new AppError('conflict', 'Import is being created. Try again.');
      if (existing.status !== 'failed' && existing.status !== 'cancelled') return importJson(existing, true);
      dedup = true;
      row = await maybeOne<ImportRow>(tx,
        `UPDATE imports SET status='queued', error_code=NULL, error_message=NULL, requested_by=$2, completed_at=NULL, started_at=NULL WHERE id=$1 RETURNING *`,
        [existing.id, ctx.actor.userId]);
    }
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'import', aggregateId: row!.id, eventType: 'source.import_requested', payload: { importId: row!.id, action: p.action } });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: p.item.brand_id, actorUserId: ctx.actor.userId, action: 'content_import.requested', resourceType: 'import',
      resourceId: row!.id, diff: { action: p.action, source_item_id: p.item.id, retried: dedup }, correlationId: ctx.correlationId });
    return importJson(row!, dedup);
  });
}

export async function getImport(ctx: Ctx, importId: string): Promise<ImportDto> {
  requireAction(ctx, 'content.read');
  assertUuid(importId, 'Import');
  const r = await maybeOne<ImportRow>(getPool(), `SELECT * FROM imports WHERE id=$1 AND workspace_id=$2`, [importId, ctx.access.workspaceId]);
  if (!r || !brandAllowed(ctx, r.brand_id)) throw notFound('Import');
  return importJson(r);
}

export async function listImports(ctx: Ctx, brandId: string, limit = 30): Promise<ImportDto[]> {
  requireAction(ctx, 'content.read', { brandId });
  if (!brandAllowed(ctx, brandId)) throw notFound('Brand');
  const rows = await many<ImportRow>(getPool(), `SELECT * FROM imports WHERE workspace_id=$1 AND brand_id=$2 ORDER BY created_at DESC LIMIT $3`,
    [ctx.access.workspaceId, brandId, Math.min(limit, 100)]);
  return rows.map((r) => importJson(r));
}

// ------------------------------------------------------------------ worker
/**
 * Context for background work: the requester's CURRENT membership and grants (removed/suspended/narrowed people
 * fail here). Session assurance is not re-evaluated (MFA was enforced when the request was made).
 */
export async function jobCtx(userId: string | null, workspaceId: string, runId: string): Promise<Ctx | null> {
  if (!userId) return null;
  const access = await loadAccess(userId, workspaceId);
  if (!access?.authz) return null;
  access.authz = { ...access.authz, subject: { ...access.authz.subject, assurance: null }, required: new Set(), touchedBrands: new Set() };
  const u = await maybeOne<{ email: string; name: string | null }>(getPool(), `SELECT email, name FROM users WHERE id=$1`, [userId]);
  return { actor: { userId, email: u?.email ?? '', name: u?.name ?? null, sessionId: `job:${runId}` }, access, correlationId: runId };
}

export class RetryLaterError extends Error {
  constructor(message: string, readonly delaySeconds = 30) { super(message); this.name = 'RetryLaterError'; }
}

const MAX_ATTEMPTS = 5;

async function finish(id: string, status: 'completed' | 'partial' | 'failed', patch: { result?: unknown; snapshotId?: string | null; code?: string; message?: string }): Promise<void> {
  await getPool().query(
    `UPDATE imports SET status=$2, result=coalesce($3::jsonb, result), snapshot_id=coalesce($4, snapshot_id), error_code=$5, error_message=$6, completed_at=now() WHERE id=$1`,
    [id, status, patch.result ? JSON.stringify(patch.result) : null, patch.snapshotId ?? null, patch.code ?? null, patch.message?.slice(0, 500) ?? null]);
}

/** Process one import (worker 'source-import' queue). Throws RetryLaterError for transient source failures. */
export async function runImport(importId: string): Promise<ImportDto | null> {
  const runId = randomUUID();
  const row = await maybeOne<ImportRow>(getPool(),
    `UPDATE imports SET status='running', started_at=now(), attempts=attempts+1, run_id=$2
      WHERE id=$1 AND (status='queued' OR (status='running' AND started_at < now() - interval '15 minutes')) RETURNING *`, [importId, runId]);
  if (!row) return null;
  const ctx = await jobCtx(row.requested_by, row.workspace_id, runId);
  if (!ctx) {
    await finish(row.id, 'failed', { code: 'forbidden', message: 'The person who requested this import no longer has access.' });
    return null;
  }
  try {
    const item = await loadSourceItem(ctx, row.source_item_id ?? '00000000-0000-0000-0000-000000000000').catch(() => null);
    if (!item) throw new AppError('not_found', 'The source was removed.');
    if (item.state !== 'linked' && row.action !== 'refresh') throw new AppError('invalid_state', 'The source is not readable right now (access lost or disconnected).');
    const perm = row.action === 'media_asset' ? 'assets.upload' : 'content.create';
    const conn = await connectionForBrand(ctx, row.connection_id, row.brand_id, perm);
    let out: { status: 'completed' | 'partial'; result: ImportDto['result']; snapshotId: string | null };
    switch (row.action) {
      case 'media_asset': out = await runMediaImport(ctx, row, item, conn); break;
      case 'doc_drafts': case 'doc_campaign': case 'notion_page_draft': out = await runDocumentImport(ctx, row, item, conn); break;
      case 'notion_rows': out = await (await import('./rows.js')).runRowsImport(ctx, row, item, conn); break;
      case 'refresh': out = await (await import('./refresh.js')).runRefresh(ctx, row, item, conn); break;
      default: throw new AppError('validation_failed', 'Unknown import action');
    }
    await finish(row.id, out.status, { result: out.result, snapshotId: out.snapshotId });
  } catch (err) {
    const transient = (err instanceof SourceAccessError && err.retryable) || (err instanceof RetryLaterError);
    if (transient && row.attempts < MAX_ATTEMPTS) {
      await getPool().query(`UPDATE imports SET status='queued', error_message=$2 WHERE id=$1`, [row.id, 'Waiting to retry: the source is busy or unavailable.']);
      throw err instanceof RetryLaterError ? err : new RetryLaterError(err.message, (err as SourceAccessError).retryAfterSeconds ?? 30);
    }
    const app = err instanceof AppError ? err : sourceAppError(err);
    log.warn('content_import_failed', { importId: row.id, action: row.action, code: app.code, err: { name: (err as Error).name, message: (err as Error).message } });
    await finish(row.id, 'failed', { code: (app.details?.reason as string | undefined) ?? app.code, message: app.message });
  }
  const done = await maybeOne<ImportRow>(getPool(), `SELECT * FROM imports WHERE id=$1`, [row.id]);
  return done ? importJson(done) : null;
}

// ------------------------------------------------------------------ media (Drive → validated private asset)
async function runMediaImport(ctx: Ctx, row: ImportRow, item: SourceItemRow, conn: ContentConnectionRow) {
  let fetched: { bytes: Buffer; name: string; mime: string; version: string | null; modified: string | null; md5: string | null };
  try {
    fetched = await withSource(conn, async (s) => {
      const { file } = await getFileResolvingShortcut(s.google!, item.external_id);
      if (file.trashed) throw new SourceAccessError('trashed', 'not_found', 404, 'trashed');
      if (file.mimeType === MIME.doc || file.mimeType.startsWith('application/vnd.google-apps.')) throw new AppError('unsupported_media', 'Google Docs Editors files cannot be imported as media.');
      const kind = ingestKind(file.mimeType);
      if (!kind) throw new AppError('unsupported_media', 'Only JPEG/PNG images and MP4/MOV videos can be imported as media.');
      if (file.capabilities?.canDownload === false) throw new AppError('invalid_state', 'The owner turned off downloading for this file.', undefined, { reason: 'download_denied' });
      const limit = ingestLimit(kind);
      if (file.size && Number(file.size) > limit) throw new AppError('payload_too_large', 'The file is larger than the import limit.');
      const bytes = await downloadFile(s.google!, file.id, limit);
      return { bytes, name: file.name, mime: file.mimeType, version: file.version ?? null, modified: file.modifiedTime ?? null, md5: file.md5Checksum ?? null };
    });
  } catch (err) {
    await recordItemAccessFailure(item.id, err);
    if (err instanceof SourceAccessError && err.kind === 'forbidden') throw new AppError('invalid_state', 'Google denied the download (sharing settings or download restrictions).', undefined, { reason: 'download_denied' });
    if (err instanceof SourceAccessError && err.kind === 'too_large') throw new AppError('payload_too_large', 'The file is larger than the import limit.');
    throw err;
  }
  // Integrity: the bytes must match the checksum Drive reports for this revision.
  if (fetched.md5 && createHash('md5').update(fetched.bytes).digest('hex') !== fetched.md5) {
    throw new AppError('validation_failed', 'The downloaded file did not match its checksum. Try again.', undefined, { reason: 'checksum_mismatch' });
  }
  const asset = await ingestServerBytes(ctx, { brandId: row.brand_id, filename: fetched.name, declaredMime: fetched.mime, bytes: fetched.bytes,
    origin: { source: 'google_drive', file_id: item.external_id, version: fetched.version, import_id: row.id } });
  if (asset.status === 'rejected') throw new AppError('unsupported_media', asset.rejection_reason ?? 'The file failed validation.', undefined, { reason: 'media_rejected' });
  return withTx(async (tx) => {
    const snap = await createSnapshot(tx, {
      workspaceId: row.workspace_id, brandId: row.brand_id, itemId: item.id, kind: 'media', fingerprint: sha256Hex(fetched.bytes), title: fetched.name,
      content: { file_id: item.external_id, name: fetched.name, mime: fetched.mime, bytes: fetched.bytes.length, asset_id: asset.id },
      warnings: [], incomplete: false, version: fetched.version, modifiedAt: fetched.modified, sourceChecksum: fetched.md5, checksum: sha256Hex(fetched.bytes),
      assetId: asset.id, importedBy: ctx.actor.userId,
    });
    await tx.query(`UPDATE source_items SET title=$2, mime_type=$3, size_bytes=$4, state='linked', state_detail=NULL WHERE id=$1`, [item.id, fetched.name, fetched.mime, fetched.bytes.length]);
    const postIds: string[] = [];
    if (row.options.create_draft) {
      // Drafts reference the app-owned asset — never the Drive URL.
      const postId = await insertDraft(tx, ctx, { brandId: row.brand_id, title: fetched.name, text: '', assetIds: [asset.id], connectionIds: row.options.connection_ids,
        source: { kind: 'content_hub', source: 'google', item_id: item.id, snapshot_id: snap.id, import_id: row.id } });
      await linkPost(tx, ctx, { brandId: row.brand_id, postId, itemId: item.id, snapshotId: snap.id, importId: row.id, sectionIds: [], text: '' });
      postIds.push(postId);
    }
    await audit(tx, { workspaceId: row.workspace_id, brandId: row.brand_id, actorUserId: ctx.actor.userId, action: 'content_import.completed', resourceType: 'import', resourceId: row.id,
      diff: { action: row.action, asset_id: asset.id, snapshot_id: snap.id }, correlationId: ctx.correlationId });
    return { status: 'completed' as const, result: { asset_id: asset.id, post_ids: postIds }, snapshotId: snap.id };
  });
}

// ------------------------------------------------------------------ documents (Docs / Notion page → drafts or campaign)
/** Copy Notion-hosted media of the chosen sections into validated storage NOW (URLs expire after ~1 h). */
async function importSectionMedia(ctx: Ctx, conn: ContentConnectionRow, row: ImportRow, doc: FetchedDocument, sectionIds: Set<string>): Promise<{ bySection: Map<string, string[]>; errors: string[] }> {
  const bySection = new Map<string, string[]>();
  const errors: string[] = [];
  let total = 0;
  for (const f of doc.files) {
    if (!sectionIds.has(f.sectionId) || total >= 10) continue;
    try {
      const fetched = await withSource(conn, async (s) => {
        const r = await s.transport.send({ method: 'GET', url: f.url, op: 'notion.file.download', untrusted: true, maxBytes: ingestLimit(f.kind === 'video' ? 'video' : 'image'), timeoutMs: 120_000 });
        if (r.status !== 200) throw new SourceAccessError('file download failed', r.status === 403 ? 'forbidden' : 'unavailable', r.status);
        return r;
      });
      const declared = (fetched.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      const mime = ingestKind(declared) ? declared : f.kind === 'video' ? 'video/mp4' : 'image/jpeg';
      const asset = await ingestServerBytes(ctx, { brandId: row.brand_id, filename: f.name ?? `${f.kind}-${f.blockId.slice(0, 8)}`, declaredMime: mime, bytes: fetched.body,
        origin: { source: 'notion', block_id: f.blockId, import_id: row.id } });
      if (asset.status === 'rejected') { errors.push(`A ${f.kind} was rejected: ${asset.rejection_reason ?? 'failed validation'}`); continue; }
      bySection.set(f.sectionId, [...(bySection.get(f.sectionId) ?? []), asset.id]);
      total++;
    } catch (err) {
      errors.push(`A ${f.kind} could not be copied (${err instanceof AppError ? err.message : 'expired or unavailable link'}).`);
    }
  }
  return { bySection, errors };
}

async function runDocumentImport(ctx: Ctx, row: ImportRow, item: SourceItemRow, conn: ContentConnectionRow) {
  const mode = row.options.suggestions_mode ?? 'exclude';
  const doc = await fetchDocument(conn, item, mode);
  if (doc.fingerprint !== row.options.fingerprint) {
    throw new AppError('conflict', 'The source changed after the preview. Preview it again before importing.', undefined, { reason: 'source_changed' });
  }
  const wanted = new Set(row.options.section_ids ?? []);
  const sections: NormalizedSection[] = doc.sections.filter((s) => wanted.has(s.id));
  if (sections.length !== wanted.size) throw new AppError('conflict', 'Some selected sections no longer exist. Preview again.', undefined, { reason: 'source_changed' });
  const media = conn.source === 'notion' ? await importSectionMedia(ctx, conn, row, doc, wanted) : { bySection: new Map<string, string[]>(), errors: [] };
  return withTx(async (tx) => {
    const snap = await createSnapshot(tx, {
      workspaceId: row.workspace_id, brandId: row.brand_id, itemId: item.id, kind: conn.source === 'google' ? 'document' : 'notion_page', fingerprint: doc.fingerprint,
      title: doc.title, content: { title: doc.title, sections: doc.sections, suggestions_mode: mode }, warnings: doc.warnings, incomplete: doc.incomplete,
      version: doc.version, modifiedAt: doc.modifiedAt, importedBy: ctx.actor.userId,
    });
    await tx.query(`UPDATE source_items SET title=$2, state='linked', state_detail=NULL WHERE id=$1`, [item.id, doc.title.slice(0, 500)]);
    const campaignId = row.action === 'doc_campaign' && row.options.campaign_name ? await campaignByName(tx, ctx, row.brand_id, row.options.campaign_name) : null;
    const groups = row.options.combine ? [sections] : sections.map((s) => [s]);
    const postIds: string[] = [];
    for (const g of groups) {
      const text = g.map((s) => sectionText(s, { includeTitle: row.options.combine })).join('\n\n');
      const title = row.options.combine || g.length !== 1 ? doc.title : `${doc.title} — ${g[0]!.title}`;
      const assetIds = g.flatMap((s) => media.bySection.get(s.id) ?? []);
      const postId = await insertDraft(tx, ctx, { brandId: row.brand_id, title, text, assetIds, connectionIds: row.options.connection_ids, campaignId,
        source: { kind: 'content_hub', source: conn.source, item_id: item.id, snapshot_id: snap.id, import_id: row.id } });
      await linkPost(tx, ctx, { brandId: row.brand_id, postId, itemId: item.id, snapshotId: snap.id, importId: row.id, sectionIds: g.map((s) => s.id), text });
      postIds.push(postId);
    }
    const truncated = groups.some((g) => clampDraftText(g.map((s) => sectionText(s)).join('\n\n')).truncated);
    await audit(tx, { workspaceId: row.workspace_id, brandId: row.brand_id, actorUserId: ctx.actor.userId, action: 'content_import.completed', resourceType: 'import', resourceId: row.id,
      diff: { action: row.action, posts: postIds.length, snapshot_id: snap.id, campaign_id: campaignId }, correlationId: ctx.correlationId });
    const status = media.errors.length ? 'partial' as const : 'completed' as const;
    return { status, result: { post_ids: postIds, campaign_id: campaignId, warnings: [...media.errors, ...(truncated ? ['Long text was shortened to fit a draft.'] : [])] } as ImportDto['result'], snapshotId: snap.id };
  });
}
