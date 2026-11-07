// Linked source items: explicit selection (Picker / Notion selection) verified server-side with the saved
// authorization, per-brand item records, linked-source previews (hidden whenever access is lost), import previews,
// and the snapshot retention/delete/hold workflow.
import { AppError, notFound } from '@social-lite/core';
import type {
  DocumentPreviewDto, DriveFilePreviewDto, NotionSearchResultDto, SourceItemDto, SourceItemKind, SourceSnapshotSummary, SuggestionsMode,
} from '@social-lite/core/contracts/content-hub';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { ingestKind, ingestLimit } from '../media/ingest.js';
import { assertBrand, assertUuid, brandAllowed, brandFilter, requireAction } from '../tenancy.js';
import { connectionForBrand, withSource, type ContentConnectionRow, type SourceSessions } from './connections.js';
import { LIMITS } from './config.js';
import { parseGoogleDocument, SUGGESTIONS_VIEW, type GoogleDocument } from './docs-parse.js';
import { getDocument, getFileResolvingShortcut, isDriveId, MIME, type GoogleFile } from './google.js';
import { excerpt, fingerprintSections, sectionText, Warnings, type NormalizedSection } from './normalize.js';
import { isNotionId, normalizeNotionId, notionSearch, retrieveDataSource, retrievePage, type NotionDataSource, type NotionPage } from './notion.js';
import { fetchNotionTree } from './notion-fetch.js';
import { blockFile, pageTitle, parseNotionBlocks, richTextPlain, type TreeNode } from './notion-parse.js';
import { SourceAccessError } from './transport.js';

export interface SourceItemRow {
  id: string; workspace_id: string; brand_id: string; connection_id: string; parent_item_id: string | null; item_kind: SourceItemKind;
  external_id: string; resolved_from_shortcut_id: string | null; drive_id: string | null; title: string | null; mime_type: string | null;
  size_bytes: string | null; source_version: string | null; source_modified_at: Date | null; source_checksum: string | null;
  state: SourceItemDto['state']; state_detail: string | null; preview: { excerpt: string | null; section_count: number | null } | null;
  external_url: string | null; change_detected_at: Date | null; last_synced_at: Date | null; last_snapshot_id: string | null;
  retention_hold: boolean; created_by: string | null; created_at: Date; updated_at: Date;
}

interface ItemListRow extends SourceItemRow {
  source: 'google' | 'notion'; account_label: string; import_count: number;
  s_id: string | null; s_seq: number | null; s_fingerprint: string | null; s_imported_at: Date | null; s_email: string | null; s_source_version: string | null;
  s_incomplete: boolean | null; s_warning_count: number | null; s_asset_id: string | null; s_has_diff: boolean | null;
}

const ITEM_SELECT = `
  SELECT i.*, c.source, c.account_label,
         (SELECT count(*)::int FROM imports im WHERE im.source_item_id = i.id AND im.status IN ('completed','partial')) AS import_count,
         s.id AS s_id, s.seq AS s_seq, s.fingerprint AS s_fingerprint, s.imported_at AS s_imported_at, u.email AS s_email,
         s.source_version AS s_source_version, s.incomplete AS s_incomplete, jsonb_array_length(s.warnings) AS s_warning_count,
         s.asset_id AS s_asset_id, (s.diff IS NOT NULL) AS s_has_diff
    FROM source_items i
    JOIN content_connections c ON c.id = i.connection_id AND c.workspace_id = i.workspace_id
    LEFT JOIN source_snapshots s ON s.id = i.last_snapshot_id AND s.workspace_id = i.workspace_id
    LEFT JOIN users u ON u.id = s.imported_by`;

export function snapshotSummary(r: { s_id: string | null; s_seq: number | null; s_fingerprint: string | null; s_imported_at: Date | null; s_email: string | null; s_source_version: string | null; s_incomplete: boolean | null; s_warning_count: number | null; s_asset_id: string | null; s_has_diff: boolean | null }): SourceSnapshotSummary | null {
  if (!r.s_id) return null;
  return { id: r.s_id, seq: r.s_seq!, fingerprint: r.s_fingerprint!, imported_at: r.s_imported_at!.toISOString(), imported_by: r.s_email, source_version: r.s_source_version,
    incomplete: !!r.s_incomplete, warning_count: Number(r.s_warning_count ?? 0), asset_id: r.s_asset_id, has_diff: !!r.s_has_diff };
}

export function toItemDto(r: ItemListRow): SourceItemDto {
  const linked = r.state === 'linked';
  return {
    id: r.id, brand_id: r.brand_id, connection_id: r.connection_id, source: r.source, account_label: r.account_label, item_kind: r.item_kind,
    title: r.title, mime_type: r.mime_type, size_bytes: r.size_bytes !== null ? Number(r.size_bytes) : null, shared_drive: !!r.drive_id,
    state: r.state, state_detail: r.state_detail,
    // Linked-source previews/links require CURRENT authorization: hidden whenever the item is not readable now.
    preview: linked ? r.preview : null, external_url: linked ? r.external_url : null,
    source_version: r.source_version, source_modified_at: r.source_modified_at?.toISOString() ?? null,
    change_detected_at: r.change_detected_at?.toISOString() ?? null, last_synced_at: r.last_synced_at?.toISOString() ?? null,
    retention_hold: r.retention_hold, last_snapshot: snapshotSummary(r), import_count: Number(r.import_count ?? 0),
  };
}

/** Load an item the caller can see (workspace + brand). Cross-tenant/invisible ⇒ not_found. */
export async function loadSourceItem(ctx: Ctx, itemId: string, db: Queryable = getPool(), lock = false): Promise<SourceItemRow> {
  assertUuid(itemId, 'Source');
  const r = await maybeOne<SourceItemRow>(db, `SELECT * FROM source_items WHERE id=$1 AND workspace_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [itemId, ctx.access.workspaceId]);
  if (!r || !brandAllowed(ctx, r.brand_id)) throw notFound('Source');
  return r;
}

export async function listSourceItems(ctx: Ctx, brandId: string, q: { kind?: string | null; connection_id?: string | null } = {}): Promise<SourceItemDto[]> {
  requireAction(ctx, 'content.read', { brandId });
  await assertBrand(ctx, brandId);
  const rows = await many<ItemListRow>(getPool(),
    `${ITEM_SELECT} WHERE i.workspace_id=$1 AND i.brand_id=$2 AND ($3::text IS NULL OR i.item_kind=$3) AND ($4::uuid IS NULL OR i.connection_id=$4)
       AND i.item_kind <> 'notion_row'
     ORDER BY i.updated_at DESC LIMIT 200`,
    [ctx.access.workspaceId, brandId, q.kind ?? null, q.connection_id ?? null]);
  return rows.map(toItemDto);
}

export async function getSourceItem(ctx: Ctx, itemId: string): Promise<SourceItemDto & { snapshots: SourceSnapshotSummary[]; rows: SourceItemDto[] }> {
  requireAction(ctx, 'content.read');
  const item = await loadSourceItem(ctx, itemId);
  const row = (await maybeOne<ItemListRow>(getPool(), `${ITEM_SELECT} WHERE i.id=$1`, [item.id]))!;
  const snaps = await many<ItemListRow>(getPool(),
    `SELECT s.id AS s_id, s.seq AS s_seq, s.fingerprint AS s_fingerprint, s.imported_at AS s_imported_at, u.email AS s_email, s.source_version AS s_source_version,
            s.incomplete AS s_incomplete, jsonb_array_length(s.warnings) AS s_warning_count, s.asset_id AS s_asset_id, (s.diff IS NOT NULL) AS s_has_diff
       FROM source_snapshots s LEFT JOIN users u ON u.id = s.imported_by WHERE s.source_item_id=$1 AND s.workspace_id=$2 ORDER BY s.seq DESC LIMIT 50`,
    [item.id, ctx.access.workspaceId]);
  const rows = item.item_kind === 'notion_data_source'
    ? (await many<ItemListRow>(getPool(), `${ITEM_SELECT} WHERE i.parent_item_id=$1 AND i.workspace_id=$2 ORDER BY i.updated_at DESC LIMIT 200`, [item.id, ctx.access.workspaceId])).map(toItemDto)
    : [];
  return { ...toItemDto(row), snapshots: snaps.map((s) => snapshotSummary(s)!), rows };
}

/** Map a source failure to a user-facing error (never echoes provider text). */
export function sourceAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof SourceAccessError) {
    switch (err.kind) {
      case 'not_found': return new AppError('not_found', 'This item is not available to the connection. Select it again in the picker or share it with the connection.');
      case 'forbidden': return new AppError('invalid_state', 'The source denied access to this item (permission or capability missing).', undefined, { reason: 'source_forbidden', source_reason: err.reason });
      case 'too_large': return new AppError('payload_too_large', 'The item is too large to import.');
      case 'rate_limited': return new AppError('rate_limited', 'The source is rate limiting requests. Try again shortly.');
      case 'invalid': return new AppError('validation_failed', 'The source rejected the request.', undefined, { source_reason: err.reason });
      case 'auth': return new AppError('invalid_state', 'The source authorization is no longer valid. Reconnect it.', undefined, { reason: 'reconnect_required' });
      default: return new AppError('provider_error', 'The source is unavailable right now. Try again shortly.');
    }
  }
  return new AppError('provider_error', 'The source is unavailable right now. Try again shortly.');
}

/** Authorized retrieval failed for an item: record access loss/removal and hide its linked preview. */
export async function recordItemAccessFailure(itemId: string, err: unknown): Promise<void> {
  if (!(err instanceof SourceAccessError)) return;
  if (err.kind !== 'not_found' && err.kind !== 'forbidden') return;
  const removed = err.reason === 'trashed';
  await getPool().query(
    `UPDATE source_items SET state=$3, state_detail=$2, preview=NULL, external_url=NULL, updated_at=now() WHERE id=$1 AND state='linked'`,
    [itemId, removed ? 'The item is in the trash at the source.' : err.kind === 'not_found' ? 'The item was removed or is no longer shared with the connection.' : 'The source denied access to this item.',
      removed ? 'removed' : 'access_lost']);
}

// ------------------------------------------------------------------ selection (grants)
export interface SelectionInput {
  connection_id: string; brand_id: string; purpose?: 'import' | 'export_destination';
  items: Array<{ id: string; kind?: 'drive' | 'notion_page' | 'notion_data_source' }>;
}

export interface SelectionResult { items: SourceItemDto[]; destinations: Array<{ id: string; title: string | null; writable: boolean; kind: string }>; rejected: Array<{ id: string; reason: string }> }

function driveKind(f: GoogleFile): SourceItemKind | 'drive_folder' {
  if (f.mimeType === MIME.folder) return 'drive_folder';
  return f.mimeType === MIME.doc ? 'google_doc' : 'drive_file';
}

async function upsertItem(db: Queryable, p: {
  ctx: Ctx; conn: ContentConnectionRow; brandId: string; kind: SourceItemKind; externalId: string; parentItemId?: string | null; resolvedFrom?: string | null;
  driveId?: string | null; title: string | null; mime?: string | null; size?: number | null; version?: string | null; modifiedAt?: string | null; checksum?: string | null; url?: string | null;
}): Promise<string> {
  const r = await maybeOne<{ id: string }>(db,
    `INSERT INTO source_items(workspace_id, brand_id, connection_id, parent_item_id, item_kind, external_id, resolved_from_shortcut_id, drive_id, title, mime_type, size_bytes,
            source_version, source_modified_at, source_checksum, external_url, state, state_detail, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'linked',NULL,$16)
     ON CONFLICT (connection_id, brand_id, item_kind, external_id) DO UPDATE SET
       title=EXCLUDED.title, mime_type=coalesce(EXCLUDED.mime_type, source_items.mime_type), size_bytes=coalesce(EXCLUDED.size_bytes, source_items.size_bytes),
       resolved_from_shortcut_id=coalesce(EXCLUDED.resolved_from_shortcut_id, source_items.resolved_from_shortcut_id), drive_id=EXCLUDED.drive_id,
       external_url=EXCLUDED.external_url, state='linked', state_detail=NULL, parent_item_id=coalesce(EXCLUDED.parent_item_id, source_items.parent_item_id),
       updated_at=now()
     RETURNING id`,
    [p.ctx.access.workspaceId, p.brandId, p.conn.id, p.parentItemId ?? null, p.kind, p.externalId, p.resolvedFrom ?? null, p.driveId ?? null, p.title?.slice(0, 500) ?? null,
      p.mime ?? null, p.size ?? null, p.version ?? null, p.modifiedAt ?? null, p.checksum ?? null, p.url && /^https:\/\//.test(p.url) ? p.url : null, p.ctx.actor.userId]);
  return r!.id;
}

/**
 * Register explicitly selected items (Picker ids / Notion selection). Every id is verified with the SAVED authorization
 * (drive.file: Google itself refuses files the user did not pick; Notion: only pages shared with the connection).
 * Arbitrary ids, ids of another account and ids from another tenant's connection are rejected.
 */
export async function registerSelection(ctx: Ctx, input: SelectionInput): Promise<SelectionResult> {
  const purpose = input.purpose ?? 'import';
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 20) throw new AppError('validation_failed', 'Select 1-20 items.', { items: 'Select 1-20 items' });
  const conn = await connectionForBrand(ctx, input.connection_id, input.brand_id, purpose === 'import' ? 'content.create' : 'exports.create');
  const out: SelectionResult = { items: [], destinations: [], rejected: [] };
  const accepted: Array<{ grantKind: string; externalId: string; title: string | null; writable: boolean; item?: Parameters<typeof upsertItem>[1] }> = [];
  await withSource(conn, async (s: SourceSessions) => {
    for (const sel of input.items) {
      const id = String(sel.id ?? '').trim();
      try {
        if (conn.source === 'google') {
          if (!isDriveId(id)) { out.rejected.push({ id: id.slice(0, 80), reason: 'invalid_id' }); continue; }
          const { file, resolvedFrom } = await getFileResolvingShortcut(s.google!, id);
          if (file.trashed) { out.rejected.push({ id, reason: 'trashed' }); continue; }
          const kind = driveKind(file);
          if (purpose === 'export_destination') {
            if (kind !== 'drive_folder') { out.rejected.push({ id, reason: 'not_a_folder' }); continue; }
            accepted.push({ grantKind: 'drive_folder', externalId: file.id, title: file.name, writable: file.capabilities?.canAddChildren !== false });
            continue;
          }
          if (kind === 'drive_folder') { out.rejected.push({ id, reason: 'folder_not_importable' }); continue; }
          accepted.push({ grantKind: kind, externalId: file.id, title: file.name, writable: false, item: {
            ctx, conn, brandId: input.brand_id, kind, externalId: file.id, resolvedFrom, driveId: file.driveId ?? null, title: file.name, mime: file.mimeType,
            size: file.size ? Number(file.size) : null, version: file.version ?? null, modifiedAt: file.modifiedTime ?? null, checksum: file.md5Checksum ?? null, url: file.webViewLink ?? null,
          } });
        } else {
          if (!isNotionId(id)) { out.rejected.push({ id: id.slice(0, 80), reason: 'invalid_id' }); continue; }
          const nid = normalizeNotionId(id);
          if (sel.kind === 'notion_data_source') {
            if (purpose === 'export_destination') { out.rejected.push({ id, reason: 'pages_only' }); continue; }
            const ds = await retrieveDataSource(s.notion!, nid);
            if (ds.in_trash) { out.rejected.push({ id, reason: 'trashed' }); continue; }
            const title = richTextPlain(ds.title).text.trim() || 'Untitled data source';
            accepted.push({ grantKind: 'notion_data_source', externalId: nid, title, writable: false, item: {
              ctx, conn, brandId: input.brand_id, kind: 'notion_data_source', externalId: nid, title, version: ds.last_edited_time ?? null, modifiedAt: ds.last_edited_time ?? null, url: ds.url ?? null,
            } });
          } else {
            const page = await retrievePage(s.notion!, nid);
            if (page.in_trash || page.archived) { out.rejected.push({ id, reason: 'trashed' }); continue; }
            const title = pageTitle(page);
            if (purpose === 'export_destination') {
              accepted.push({ grantKind: 'notion_page', externalId: nid, title, writable: true });
              continue;
            }
            accepted.push({ grantKind: 'notion_page', externalId: nid, title, writable: false, item: {
              ctx, conn, brandId: input.brand_id, kind: 'notion_page', externalId: nid, title, version: page.last_edited_time ?? null, modifiedAt: page.last_edited_time ?? null, url: page.url ?? null,
            } });
          }
        }
      } catch (err) {
        if (err instanceof SourceAccessError && (err.kind === 'not_found' || err.kind === 'forbidden' || err.kind === 'invalid')) {
          out.rejected.push({ id: id.slice(0, 80), reason: err.kind === 'invalid' ? (err.reason ?? 'invalid') : 'not_shared_with_connection' });
          continue;
        }
        throw sourceAppError(err);
      }
    }
  });
  const ids = await withTx(async (tx) => {
    const itemIds: string[] = [];
    for (const a of accepted) {
      await tx.query(
        `INSERT INTO source_grants(workspace_id, connection_id, external_id, item_kind, purpose, granted_via, title, writable, granted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (connection_id, item_kind, external_id, purpose) DO UPDATE SET verified_at=now(), revoked_at=NULL, title=EXCLUDED.title, writable=EXCLUDED.writable`,
        [ctx.access.workspaceId, conn.id, a.externalId, a.grantKind, purpose, conn.source === 'google' ? 'picker' : 'notion_selection', a.title?.slice(0, 500) ?? null, a.writable, ctx.actor.userId]);
      if (a.item) itemIds.push(await upsertItem(tx, a.item));
      else out.destinations.push({ id: a.externalId, title: a.title, writable: a.writable, kind: a.grantKind });
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: input.brand_id, actorUserId: ctx.actor.userId, action: 'content_source.selected',
      resourceType: 'content_connection', resourceId: conn.id, diff: { purpose, accepted: accepted.length, rejected: out.rejected.length }, correlationId: ctx.correlationId });
    return itemIds;
  });
  if (ids.length) out.items = (await many<ItemListRow>(getPool(), `${ITEM_SELECT} WHERE i.id = ANY($1::uuid[])`, [ids])).map(toItemDto);
  return out;
}

/** Notion objects shared with the connection (search), to choose from. */
export async function searchNotion(ctx: Ctx, input: { connection_id: string; brand_id: string; query?: string; type: 'page' | 'data_source'; cursor?: string | null }): Promise<{ items: NotionSearchResultDto[]; next_cursor: string | null }> {
  const conn = await connectionForBrand(ctx, input.connection_id, input.brand_id, 'content.create');
  if (conn.source !== 'notion') throw new AppError('validation_failed', 'Not a Notion connection.');
  const res = await withSource(conn, (s) => notionSearch(s.notion!, { query: input.query, type: input.type, cursor: input.cursor })).catch((e) => { throw sourceAppError(e); });
  const linked = new Set((await many<{ external_id: string }>(getPool(),
    `SELECT external_id FROM source_items WHERE connection_id=$1 AND brand_id=$2`, [conn.id, input.brand_id])).map((r) => r.external_id));
  const items = res.results.filter((r) => !(r as { in_trash?: boolean }).in_trash).map((r): NotionSearchResultDto => {
    const isPage = (r as NotionPage).object === 'page';
    const id = normalizeNotionId(r.id);
    return {
      id, kind: isPage ? 'page' : 'data_source',
      title: isPage ? pageTitle(r as NotionPage) : richTextPlain((r as NotionDataSource).title).text.trim() || 'Untitled',
      url: (r as { url?: string }).url ?? null, last_edited_time: (r as { last_edited_time?: string }).last_edited_time ?? null, already_linked: linked.has(id),
    };
  });
  return { items, next_cursor: res.has_more ? res.next_cursor : null };
}

// ------------------------------------------------------------------ previews
export function visibilityNotice(brandName: string, source: 'google' | 'notion'): string {
  const src = source === 'google' ? 'Google Drive' : 'Notion';
  return `Importing stores a private copy in Relay for “${brandName}”. Anyone with access to ${brandName} in Relay can use it. ${src} sharing is not copied or changed, and later edits arrive only when you refresh.`;
}

export async function previewDriveFile(ctx: Ctx, itemId: string): Promise<DriveFilePreviewDto> {
  const item = await loadSourceItem(ctx, itemId);
  const conn = await connectionForBrand(ctx, item.connection_id, item.brand_id, 'content.create');
  if (conn.source !== 'google') throw new AppError('validation_failed', 'Not a Drive item.');
  const brand = await assertBrand(ctx, item.brand_id);
  let file: GoogleFile;
  let resolvedFrom: string | null;
  try {
    ({ file, resolvedFrom } = await withSource(conn, (s) => getFileResolvingShortcut(s.google!, item.external_id)));
  } catch (err) {
    await recordItemAccessFailure(item.id, err);
    throw sourceAppError(err);
  }
  await getPool().query(
    `UPDATE source_items SET title=$2, mime_type=$3, size_bytes=$4, source_version=$5, source_modified_at=$6, source_checksum=$7, drive_id=$8,
            external_url=$9, state=CASE WHEN $10 THEN 'removed' ELSE 'linked' END, state_detail=CASE WHEN $10 THEN 'The file is in the trash.' ELSE NULL END,
            preview=CASE WHEN $10 THEN NULL ELSE preview END, updated_at=now() WHERE id=$1`,
    [item.id, file.name, file.mimeType, file.size ? Number(file.size) : null, file.version ?? null, file.modifiedTime ?? null, file.md5Checksum ?? null, file.driveId ?? null,
      file.webViewLink && !file.trashed ? file.webViewLink : null, !!file.trashed]);
  const kind = ingestKind(file.mimeType);
  const size = file.size ? Number(file.size) : null;
  let blocked: string | null = null;
  if (file.trashed) blocked = 'The file is in the trash.';
  else if (file.mimeType === MIME.doc) blocked = 'Google Docs import as text: use “Import document”.';
  else if (!kind) blocked = 'Only JPEG/PNG images and MP4/MOV videos can be imported as media.';
  else if (file.capabilities?.canDownload === false) blocked = 'The owner turned off downloading for this file.';
  else if (size !== null && size > ingestLimit(kind)) blocked = kind === 'image' ? 'Images must be 20 MB or smaller.' : 'Videos must be 300 MB or smaller.';
  const shared = file.driveId ? ' It is in a Shared Drive: Shared Drive membership is not copied either.' : '';
  return {
    connection_id: conn.id, account_label: conn.account_label, brand: { id: brand.id, name: brand.name },
    file: { id: file.id, name: file.name, mime_type: file.mimeType, size_bytes: size, modified_time: file.modifiedTime ?? null, version: file.version ?? null,
      md5_checksum: file.md5Checksum ?? null, shared_drive: !!file.driveId, resolved_from_shortcut: resolvedFrom, web_view_link: file.trashed ? null : file.webViewLink ?? null },
    media_kind: file.mimeType === MIME.doc ? 'document' : kind,
    can_import: !blocked, blocked_reason: blocked,
    sharing_effect: visibilityNotice(brand.name, 'google') + shared,
  };
}

export interface FetchedDocument {
  title: string; sections: NormalizedSection[]; warnings: ReturnType<Warnings['list']>; incomplete: boolean; fingerprint: string;
  version: string | null; modifiedAt: string | null; url: string | null;
  /** Notion-hosted media found in each section (URLs valid ~1 h; used only inside the import job). */
  files: Array<{ sectionId: string; blockId: string; kind: 'image' | 'video' | 'file'; url: string; name: string | null }>;
  /** Raw Notion page (rows) for property mapping. */
  page?: NotionPage;
}

/** Fetch + normalize a Google Doc or Notion page/row (authorized retrieval; marks access loss). */
export async function fetchDocument(conn: ContentConnectionRow, item: Pick<SourceItemRow, 'id' | 'item_kind' | 'external_id'>, mode: SuggestionsMode): Promise<FetchedDocument> {
  try {
    return await withSource(conn, async (s) => {
      const w = new Warnings();
      if (item.item_kind === 'google_doc') {
        const { file } = await getFileResolvingShortcut(s.google!, item.external_id);
        if (file.trashed) throw new SourceAccessError('trashed', 'not_found', 404, 'trashed');
        if (file.mimeType !== MIME.doc) throw new SourceAccessError('not a Google Doc', 'invalid', 400, 'not_a_document');
        const raw = await getDocument(s.google!, file.id, SUGGESTIONS_VIEW[mode], LIMITS.docJsonBytes) as GoogleDocument;
        const parsed = parseGoogleDocument(raw, mode);
        return { title: parsed.title, sections: parsed.sections, warnings: parsed.warnings, incomplete: false, fingerprint: fingerprintSections(parsed.title, parsed.sections),
          version: file.version ?? null, modifiedAt: file.modifiedTime ?? null, url: file.webViewLink ?? null, files: [] };
      }
      if (item.item_kind === 'notion_page' || item.item_kind === 'notion_row') {
        const page = await retrievePage(s.notion!, item.external_id);
        if (page.in_trash || page.archived) throw new SourceAccessError('trashed', 'not_found', 404, 'trashed');
        const title = pageTitle(page);
        const tree = await fetchNotionTree(s.notion!, page.id, w);
        const files: FetchedDocument['files'] = [];
        const sections = parseNotionBlocks(normalizeNotionId(page.id), title, tree.nodes, w);
        collectFiles(normalizeNotionId(page.id), tree.nodes, files);
        return { title, sections, warnings: w.list(), incomplete: tree.incomplete, fingerprint: fingerprintSections(title, sections),
          version: page.last_edited_time ?? null, modifiedAt: page.last_edited_time ?? null, url: page.url ?? null, files, page };
      }
      throw new AppError('validation_failed', 'This item is not a document.');
    });
  } catch (err) {
    await recordItemAccessFailure(item.id, err);
    throw err;
  }
}

/** Section membership of Notion-hosted files (same split rule as parseNotionBlocks). */
function collectFiles(pageId: string, nodes: TreeNode[], out: FetchedDocument['files']): void {
  let section = `${pageId}:intro`;
  const walk = (ns: TreeNode[] | undefined) => {
    for (const n of ns ?? []) {
      const f = blockFile(n);
      if (f?.hosted && f.url && (f.kind === 'image' || f.kind === 'video')) out.push({ sectionId: section, blockId: n.id, kind: f.kind, url: f.url, name: f.name });
      if (n.type !== 'child_page') walk(n.children);
    }
  };
  for (const n of nodes) {
    if ((n.type === 'heading_1' || n.type === 'heading_2') && richTextPlain((n[n.type] as { rich_text?: never[] }).rich_text).text.trim()) section = n.id;
    walk([n]);
  }
}

export async function previewDocument(ctx: Ctx, itemId: string, mode: SuggestionsMode = 'exclude'): Promise<DocumentPreviewDto> {
  if (!['exclude', 'accept', 'inline'].includes(mode)) throw new AppError('validation_failed', 'Unknown suggestions mode', { suggestions_mode: 'Use exclude, accept or inline' });
  const item = await loadSourceItem(ctx, itemId);
  const conn = await connectionForBrand(ctx, item.connection_id, item.brand_id, 'content.create');
  const brand = await assertBrand(ctx, item.brand_id);
  let doc: FetchedDocument;
  try {
    doc = await fetchDocument(conn, item, mode);
  } catch (err) {
    throw sourceAppError(err);
  }
  const ex = excerpt(doc.sections.map((s) => sectionText(s)).join('\n'), 280);
  await getPool().query(
    `UPDATE source_items SET title=$2, source_version=$3, source_modified_at=$4, external_url=$5, preview=$6, state='linked', state_detail=NULL, updated_at=now() WHERE id=$1`,
    [item.id, doc.title.slice(0, 500), doc.version, doc.modifiedAt, doc.url && /^https:\/\//.test(doc.url) ? doc.url : null, JSON.stringify({ excerpt: ex, section_count: doc.sections.length })]);
  return {
    connection_id: conn.id, brand_id: item.brand_id, external_id: item.external_id, title: doc.title, fingerprint: doc.fingerprint,
    source_version: doc.version, source_modified_at: doc.modifiedAt, sections: doc.sections, warnings: doc.warnings,
    suggestions_mode: item.item_kind === 'google_doc' ? mode : 'exclude', comments_included: false, incomplete: doc.incomplete,
    visibility_notice: visibilityNotice(brand.name, conn.source),
  };
}

// ------------------------------------------------------------------ retention / delete / hold
export async function setRetentionHold(ctx: Ctx, itemId: string, hold: boolean): Promise<SourceItemDto> {
  requireAction(ctx, 'content.archive');
  const item = await loadSourceItem(ctx, itemId);
  requireAction(ctx, 'content.archive', { brandId: item.brand_id });
  await withTx(async (tx) => {
    await tx.query(`UPDATE source_items SET retention_hold=$2, updated_at=now() WHERE id=$1`, [item.id, hold]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: item.brand_id, actorUserId: ctx.actor.userId, action: hold ? 'content_source.hold_set' : 'content_source.hold_released',
      resourceType: 'source_item', resourceId: item.id, correlationId: ctx.correlationId });
  });
  return (await many<ItemListRow>(getPool(), `${ITEM_SELECT} WHERE i.id=$1`, [item.id])).map(toItemDto)[0]!;
}

/**
 * Delete the item's stored snapshots (and the link). Drafts and library assets created from it are app content and stay.
 * Refused while a retention hold is set.
 */
export async function deleteSourceItem(ctx: Ctx, itemId: string): Promise<{ deleted: true; snapshots: number }> {
  requireAction(ctx, 'content.archive');
  return withTx(async (tx) => {
    const item = await loadSourceItem(ctx, itemId, tx, true);
    requireAction(ctx, 'content.archive', { brandId: item.brand_id });
    if (item.retention_hold) throw new AppError('invalid_state', 'This source is on hold. Release the hold before deleting it.');
    const n = await maybeOne<{ n: number }>(tx, `SELECT count(*)::int n FROM source_snapshots WHERE source_item_id=$1 OR source_item_id IN (SELECT id FROM source_items WHERE parent_item_id=$1)`, [item.id]);
    await tx.query(`DELETE FROM source_items WHERE id=$1 AND workspace_id=$2`, [item.id, ctx.access.workspaceId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: item.brand_id, actorUserId: ctx.actor.userId, action: 'content_source.deleted',
      resourceType: 'source_item', resourceId: item.id, diff: { kind: item.item_kind, snapshots: n?.n ?? 0, state: item.state }, correlationId: ctx.correlationId });
    return { deleted: true as const, snapshots: n?.n ?? 0 };
  });
}

/** Worker sweep: snapshots of items that lost access / were disconnected expire after the workspace retention period (holds win). */
export async function sweepSnapshotRetention(db: Queryable = getPool(), limit = 200): Promise<number> {
  const r = await db.query(
    `DELETE FROM source_snapshots WHERE id IN (
       SELECT s.id FROM source_snapshots s JOIN source_items i ON i.id = s.source_item_id
         LEFT JOIN content_hub_settings st ON st.workspace_id = i.workspace_id
        WHERE i.state IN ('access_lost','disconnected','removed') AND NOT i.retention_hold
          AND i.updated_at < now() - make_interval(days => coalesce(st.snapshot_retention_days, 365))
        LIMIT $1)`, [limit]);
  return r.rowCount ?? 0;
}

export async function getRetentionDays(db: Queryable, workspaceId: string): Promise<number> {
  return (await maybeOne<{ d: number }>(db, `SELECT snapshot_retention_days d FROM content_hub_settings WHERE workspace_id=$1`, [workspaceId]))?.d ?? 365;
}

export async function setRetentionDays(ctx: Ctx, days: number): Promise<{ snapshot_retention_days: number }> {
  requireAction(ctx, 'workspace.manage');
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new AppError('validation_failed', 'Use 1-3650 days', { snapshot_retention_days: 'Use 1-3650 days' });
  await withTx(async (tx) => {
    await tx.query(`INSERT INTO content_hub_settings(workspace_id, snapshot_retention_days, updated_by) VALUES ($1,$2,$3)
      ON CONFLICT (workspace_id) DO UPDATE SET snapshot_retention_days=$2, updated_by=$3, updated_at=now()`, [ctx.access.workspaceId, days, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'content_hub.retention_updated', resourceType: 'workspace',
      resourceId: ctx.access.workspaceId, diff: { snapshot_retention_days: days }, correlationId: ctx.correlationId });
  });
  return { snapshot_retention_days: days };
}

export { brandFilter };
