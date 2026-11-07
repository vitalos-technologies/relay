// Manual refresh: authorized re-read of a linked source → (if changed) a new immutable snapshot with a diff → a NEW
// draft revision. Approved/scheduled/published content is never mutated: such posts (and drafts edited in Relay since
// the import) get a separate new draft instead. Dispatch always uses app-owned assets, never source URLs.
import { randomUUID } from 'node:crypto';
import { AppError, type DraftContent } from '@social-lite/core';
import type { ImportDto, RefreshResultDto } from '@social-lite/core/contracts/content-hub';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { requireAction } from '../tenancy.js';
import { ingestKind, ingestLimit, ingestServerBytes } from '../media/ingest.js';
import { stableStringify } from '../idempotency.js';
import { connectionForBrand, withSource, type ContentConnectionRow } from './connections.js';
import { downloadFile, getFileResolvingShortcut } from './google.js';
import { importKey, enqueueImport, type ImportRow } from './imports.js';
import { fetchDocument, loadSourceItem, recordItemAccessFailure, type FetchedDocument, type SourceItemRow } from './items.js';
import { diffSnapshots, fingerprintSections, sectionText, sha256Hex, Warnings, type NormalizedSection } from './normalize.js';
import { normalizeNotionId, retrievePage } from './notion.js';
import { propertyFingerprint, propertyValue } from './notion-parse.js';
import { createSnapshot, draftTextHash, insertDraft, type SnapshotRow } from './store.js';
import { SourceAccessError } from './transport.js';

export async function requestRefresh(ctx: Ctx, itemId: string, requestKey: string | null): Promise<ImportDto> {
  const item = await loadSourceItem(ctx, itemId);
  requireAction(ctx, 'content.edit', { brandId: item.brand_id });
  if (item.item_kind === 'notion_data_source') throw new AppError('validation_failed', 'Refresh the imported rows, or preview the data source again.');
  await connectionForBrand(ctx, item.connection_id, item.brand_id, 'content.create');
  const running = await maybeOne<ImportRow>(getPool(),
    `SELECT * FROM imports WHERE source_item_id=$1 AND action='refresh' AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`, [item.id]);
  if (running) return (await import('./imports.js')).importJson(running, true);
  const key = importKey(['refresh', item.id, item.brand_id, requestKey ?? randomUUID()]);
  return enqueueImport(ctx, { item, action: 'refresh', key, options: { refresh_key: requestKey ?? undefined } });
}

interface LinkRow { id: string; post_id: string; section_ids: string[]; imported_hash: string; snapshot_id: string | null }
interface PostLock { id: string; title: string | null; draft: DraftContent; version: number; campaign_id: string | null; due_at: Date | null; archived_at: Date | null; scheduled: boolean; published: boolean }

async function lockPost(tx: Queryable, workspaceId: string, postId: string): Promise<PostLock | null> {
  return maybeOne<PostLock>(tx,
    `SELECT p.id, p.title, p.draft, p.version, p.campaign_id, p.due_at, p.archived_at,
            EXISTS (SELECT 1 FROM schedules s WHERE s.post_id=p.id AND s.workspace_id=p.workspace_id AND s.status IN ('active','pending_approval')) AS scheduled,
            EXISTS (SELECT 1 FROM deliveries d WHERE d.post_id=p.id AND d.workspace_id=p.workspace_id AND d.state='published') AS published
       FROM posts p WHERE p.id=$1 AND p.workspace_id=$2 FOR UPDATE OF p`, [postId, workspaceId]);
}

/**
 * Apply a new snapshot to every draft linked to the item. `build` returns the new text/assets for a link (null = no
 * longer applicable, e.g. its section was removed).
 */
async function applyToLinkedPosts(tx: Queryable, ctx: Ctx, item: SourceItemRow, snapId: string, importId: string, build: (l: LinkRow, post: PostLock) => { text: string; assetIds: string[] } | null): Promise<RefreshResultDto['drafts']> {
  const links = await many<LinkRow>(tx, `SELECT id, post_id, section_ids, imported_hash, snapshot_id FROM source_post_links WHERE source_item_id=$1 AND superseded_at IS NULL ORDER BY created_at`, [item.id]);
  const out: RefreshResultDto['drafts'] = [];
  for (const l of links) {
    const post = await lockPost(tx, ctx.access.workspaceId, l.post_id);
    if (!post) continue;
    if (post.archived_at) { out.push({ post_id: post.id, outcome: 'unchanged', reason: 'archived' }); continue; }
    const next = build(l, post);
    if (!next) { out.push({ post_id: post.id, outcome: 'unchanged', reason: 'section_removed' }); continue; }
    const sameText = draftTextHash(next.text) === l.imported_hash;
    const sameAssets = stableStringify([...post.draft.baseAssetIds].sort()) === stableStringify([...next.assetIds].sort()) || !next.assetIds.length;
    if (sameText && sameAssets) {
      await tx.query(`UPDATE source_post_links SET snapshot_id=$2 WHERE id=$1`, [l.id, snapId]);
      out.push({ post_id: post.id, outcome: 'unchanged' });
      continue;
    }
    const locked = post.scheduled || post.published;
    const edited = draftTextHash(post.draft.baseText) !== l.imported_hash;
    if (!locked && !edited) {
      // New draft revision of the editable, unedited draft (version history keeps the previous text).
      const draft: DraftContent = { ...post.draft, baseText: next.text, baseAssetIds: next.assetIds.length ? next.assetIds : post.draft.baseAssetIds };
      const r = await maybeOne<{ version: number }>(tx, `UPDATE posts SET draft=$2, version=version+1, updated_at=now(), updated_by=$3 WHERE id=$1 RETURNING version`,
        [post.id, JSON.stringify(draft), ctx.actor.userId]);
      await tx.query(`INSERT INTO post_versions(workspace_id, post_id, version, base_version, kind, title, draft, saved_by) VALUES ($1,$2,$3,$4,'saved',$5,$6,$7)`,
        [ctx.access.workspaceId, post.id, r!.version, post.version, post.title, JSON.stringify(draft), ctx.actor.userId]);
      await tx.query(`UPDATE source_post_links SET snapshot_id=$2, imported_hash=$3 WHERE id=$1`, [l.id, snapId, draftTextHash(next.text)]);
      await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: item.brand_id, actorUserId: ctx.actor.userId, action: 'post.source_refreshed', resourceType: 'post', resourceId: post.id,
        diff: { snapshot_id: snapId, version: r!.version }, correlationId: ctx.correlationId });
      out.push({ post_id: post.id, outcome: 'revised' });
    } else {
      const newId = await insertDraft(tx, ctx, {
        brandId: item.brand_id, title: `${post.title ?? 'Imported draft'} (updated)`, text: next.text, assetIds: next.assetIds.length ? next.assetIds : post.draft.baseAssetIds,
        campaignId: post.campaign_id, dueAt: post.due_at,
        source: { kind: 'content_hub', source: item.item_kind === 'drive_file' || item.item_kind === 'google_doc' ? 'google' : 'notion', item_id: item.id, snapshot_id: snapId, import_id: importId },
      });
      await tx.query(`UPDATE source_post_links SET superseded_at=now() WHERE id=$1`, [l.id]);
      await tx.query(
        `INSERT INTO source_post_links(workspace_id, brand_id, post_id, source_item_id, snapshot_id, import_id, section_ids, imported_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ctx.access.workspaceId, item.brand_id, newId, item.id, snapId, importId, l.section_ids, draftTextHash(next.text)]);
      out.push({ post_id: post.id, outcome: 'new_draft', new_post_id: newId, reason: locked ? 'approved_or_scheduled' : 'edited_in_relay' });
    }
  }
  return out;
}

async function latestSnapshot(itemId: string): Promise<(SnapshotRow & { source_version: string | null; source_checksum: string | null }) | null> {
  return maybeOne(getPool(), `SELECT id, seq, fingerprint, content, asset_id, source_version, source_checksum FROM source_snapshots WHERE source_item_id=$1 ORDER BY seq DESC LIMIT 1`, [itemId]);
}

export async function runRefresh(ctx: Ctx, row: ImportRow, item: SourceItemRow, conn: ContentConnectionRow): Promise<{ status: 'completed'; result: ImportDto['result']; snapshotId: string | null }> {
  requireAction(ctx, 'content.edit', { brandId: item.brand_id });
  const prev = await latestSnapshot(item.id);
  const done = (refresh: RefreshResultDto, snapshotId: string | null) => ({ status: 'completed' as const, result: { refresh, post_ids: refresh.drafts.flatMap((d) => [d.post_id, ...(d.new_post_id ? [d.new_post_id] : [])]) }, snapshotId });

  if (item.item_kind === 'drive_file') {
    let fetched: { bytes: Buffer; name: string; mime: string; version: string | null; modified: string | null; md5: string | null } | null = null;
    try {
      fetched = await withSource(conn, async (s) => {
        const { file } = await getFileResolvingShortcut(s.google!, item.external_id);
        if (file.trashed) throw new SourceAccessError('trashed', 'not_found', 404, 'trashed');
        if ((file.version && file.version === prev?.source_version) || (file.md5Checksum && file.md5Checksum === prev?.source_checksum)) return null;
        const kind = ingestKind(file.mimeType);
        if (!kind) throw new AppError('unsupported_media', 'The file is no longer an importable image or video.');
        if (file.capabilities?.canDownload === false) throw new AppError('invalid_state', 'The owner turned off downloading for this file.', undefined, { reason: 'download_denied' });
        const bytes = await downloadFile(s.google!, file.id, ingestLimit(kind));
        return { bytes, name: file.name, mime: file.mimeType, version: file.version ?? null, modified: file.modifiedTime ?? null, md5: file.md5Checksum ?? null };
      });
    } catch (err) {
      await recordItemAccessFailure(item.id, err);
      throw err;
    }
    await getPool().query(`UPDATE source_items SET state='linked', state_detail=NULL, change_detected_at=NULL, last_synced_at=now(), updated_at=now() WHERE id=$1`, [item.id]);
    if (!fetched || (prev && sha256Hex(fetched.bytes) === prev.fingerprint)) return done({ changed: false, snapshot_id: prev?.id ?? null, diff: null, drafts: [], state: 'linked' }, prev?.id ?? null);
    const f = fetched;
    const asset = await ingestServerBytes(ctx, { brandId: item.brand_id, filename: f.name, declaredMime: f.mime, bytes: f.bytes, origin: { source: 'google_drive', file_id: item.external_id, version: f.version, refresh: row.id } });
    if (asset.status === 'rejected') throw new AppError('unsupported_media', asset.rejection_reason ?? 'The new file version failed validation.', undefined, { reason: 'media_rejected' });
    return withTx(async (tx) => {
      const snap = await createSnapshot(tx, { workspaceId: item.workspace_id, brandId: item.brand_id, itemId: item.id, kind: 'media', fingerprint: sha256Hex(f.bytes), title: f.name,
        content: { file_id: item.external_id, name: f.name, mime: f.mime, bytes: f.bytes.length, asset_id: asset.id }, warnings: [], incomplete: false,
        version: f.version, modifiedAt: f.modified, sourceChecksum: f.md5, checksum: sha256Hex(f.bytes), assetId: asset.id, importedBy: ctx.actor.userId });
      const oldAsset = prev?.asset_id ?? null;
      const drafts = await applyToLinkedPosts(tx, ctx, item, snap.id, row.id, (l, post) => ({
        text: post.draft.baseText, assetIds: post.draft.baseAssetIds.map((a) => (a === oldAsset ? asset.id : a)),
      }));
      return done({ changed: true, snapshot_id: snap.id, diff: { from_snapshot_id: prev?.id ?? null, to_snapshot_id: snap.id, changed: true, sections_added: [], sections_removed: [], sections_changed: ['media'], lines: [], truncated: false }, drafts, state: 'linked' }, snap.id);
    });
  }

  // Documents, Notion pages and rows.
  let doc: FetchedDocument;
  let rowExtra: { mapped: Record<string, unknown>; properties: Record<string, unknown>; text: string; sections: NormalizedSection[] } | null = null;
  if (item.item_kind === 'notion_row') {
    const { mapRow } = await import('./rows.js');
    const mapping = await maybeOne<{ mapping: Record<string, string>; import_statuses: string[] }>(getPool(),
      `SELECT mapping, import_statuses FROM import_mappings WHERE source_item_id=$1`, [item.parent_item_id]);
    doc = await fetchDocument(conn, item, 'exclude');
    const page = doc.page!;
    const v = mapRow(page, { mapping: mapping?.mapping ?? {}, import_statuses: [] });
    const body = mapping?.mapping.body && mapping.mapping.body !== 'page_content' ? v.bodyProp ?? '' : doc.sections.map((s) => sectionText(s)).join('\n\n');
    const sections: NormalizedSection[] = mapping?.mapping.body && mapping.mapping.body !== 'page_content'
      ? [{ id: `${normalizeNotionId(page.id)}:body`, title: v.title, tab_id: null, tab_title: null, level: 0, blocks: [{ type: 'paragraph', text: body }], word_count: body.split(/\s+/).filter(Boolean).length }]
      : doc.sections;
    const properties = Object.fromEntries(Object.values(page.properties ?? {}).map((pv) => [pv.id, { type: pv.type, value: propertyValue(pv), fingerprint: propertyFingerprint(pv) }]));
    rowExtra = { mapped: { ...v, errors: undefined }, properties, text: body, sections };
    doc = { ...doc, title: v.title, sections, fingerprint: sha256Hex(stableStringify({ doc: fingerprintSections(v.title, sections), mapped: { ...v, errors: undefined } })) };
  } else {
    const mode = (prev?.content as { suggestions_mode?: 'exclude' | 'accept' | 'inline' } | undefined)?.suggestions_mode ?? 'exclude';
    doc = await fetchDocument(conn, item, mode);
  }
  await getPool().query(`UPDATE source_items SET state='linked', state_detail=NULL, change_detected_at=NULL, last_synced_at=now(), source_version=coalesce($2, source_version), updated_at=now() WHERE id=$1`, [item.id, doc.version]);
  if (prev && prev.fingerprint === doc.fingerprint) return done({ changed: false, snapshot_id: prev.id, diff: null, drafts: [], state: 'linked' }, prev.id);
  return withTx(async (tx) => {
    const snap = await createSnapshot(tx, {
      workspaceId: item.workspace_id, brandId: item.brand_id, itemId: item.id,
      kind: item.item_kind === 'google_doc' ? 'document' : item.item_kind === 'notion_row' ? 'notion_row' : 'notion_page', fingerprint: doc.fingerprint, title: doc.title,
      content: rowExtra ? { title: doc.title, sections: doc.sections, properties: rowExtra.properties, mapped: rowExtra.mapped } : { title: doc.title, sections: doc.sections, suggestions_mode: (prev?.content as { suggestions_mode?: string } | undefined)?.suggestions_mode ?? 'exclude' },
      warnings: doc.warnings, incomplete: doc.incomplete, version: doc.version, modifiedAt: doc.modifiedAt, importedBy: ctx.actor.userId,
    });
    const bySection = new Map(doc.sections.map((s) => [s.id, s]));
    const drafts = await applyToLinkedPosts(tx, ctx, item, snap.id, row.id, (l, post) => {
      if (rowExtra) return { text: rowExtra.text, assetIds: post.draft.baseAssetIds };
      const secs = l.section_ids.map((id) => bySection.get(id));
      if (!secs.length || secs.some((s) => !s)) return null;
      const combined = secs.length > 1;
      return { text: (secs as NormalizedSection[]).map((s) => sectionText(s, { includeTitle: combined })).join('\n\n'), assetIds: post.draft.baseAssetIds };
    });
    const diff = diffSnapshots(prev && Array.isArray(prev.content.sections) ? { id: prev.id, sections: prev.content.sections } : null, { id: snap.id, sections: doc.sections });
    await audit(tx, { workspaceId: item.workspace_id, brandId: item.brand_id, actorUserId: ctx.actor.userId, action: 'content_source.refreshed', resourceType: 'source_item', resourceId: item.id,
      diff: { snapshot_id: snap.id, revised: drafts.filter((d) => d.outcome === 'revised').length, new_drafts: drafts.filter((d) => d.outcome === 'new_draft').length }, correlationId: ctx.correlationId });
    return done({ changed: true, snapshot_id: snap.id, diff, drafts, state: 'linked' }, snap.id);
  });
}

/** Lightweight authorized metadata check used by change signals (no content import, no drafts). */
export async function checkItemMetadata(conn: ContentConnectionRow, item: SourceItemRow): Promise<'unchanged' | 'changed' | 'lost'> {
  try {
    const version = await withSource(conn, async (s) => {
      if (conn.source === 'google') return (await getFileResolvingShortcut(s.google!, item.external_id)).file.version ?? null;
      return (await retrievePage(s.notion!, item.external_id)).last_edited_time ?? null;
    });
    if (version && version !== item.source_version) {
      await getPool().query(`UPDATE source_items SET change_detected_at=now(), updated_at=now() WHERE id=$1`, [item.id]);
      return 'changed';
    }
    return 'unchanged';
  } catch (err) {
    await recordItemAccessFailure(item.id, err);
    if (err instanceof SourceAccessError && (err.kind === 'not_found' || err.kind === 'forbidden')) return 'lost';
    throw err;
  }
}

export { Warnings };
