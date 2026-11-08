// Notion data sources: schema, property mapping (ids, validated by type), row preview with row-level errors, and
// idempotent row import into drafts. Notion statuses are labels only: "Ready"/"Approved" never grant Relay approval —
// every imported row becomes a plain draft that follows the normal review/schedule flow.
import { AppError } from '@social-lite/core';
import type {
  DataSourceSchemaDto, ImportDto, MappingField, NotionMappingDto, RowImportResult, RowPreviewDto, RowsPreviewDto, WritebackField,
} from '@social-lite/core/contracts/content-hub';
import { getPool, many, maybeOne, withTx } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { log } from '../log.js';
import { requireAction } from '../tenancy.js';
import { stableStringify } from '../idempotency.js';
import { connectionForBrand, withSource, type ContentConnectionRow } from './connections.js';
import { LIMITS } from './config.js';
import { loadSourceItem, recordItemAccessFailure, sourceAppError, type SourceItemRow } from './items.js';
import type { ImportRow } from './imports.js';
import { blocksToText, excerpt, fingerprintSections, sectionText, sha256Hex, Warnings } from './normalize.js';
import { normalizeNotionId, queryDataSource, retrieveDataSource, retrievePage, type NotionDataSource, type NotionPage, type NotionSession } from './notion.js';
import { fetchNotionTree } from './notion-fetch.js';
import { MAPPABLE_TYPES, pageTitle, parseNotionBlocks, propertyFingerprint, propertyValue, richTextPlain, WRITEBACK_TYPES } from './notion-parse.js';
import { campaignByName, createSnapshot, draftTextHash, insertDraft, linkPost } from './store.js';
import { SourceAccessError } from './transport.js';

/** Values Relay writes to a mapped status property (app-owned facts). */
export const RELAY_STATUS_VALUES = ['Draft in Relay', 'In review', 'Scheduled', 'Published', 'Failed'] as const;
export const APPROVAL_NOTICE = 'Notion statuses such as “Ready” or “Approved” only choose which rows to import. They never approve or schedule anything in Relay.';
const MAPPING_FIELDS: MappingField[] = ['title', 'body', 'campaign', 'target_date', 'status', 'external_ref'];
const WRITEBACK_FIELDS: WritebackField[] = ['status', 'scheduled_time', 'post_url'];

interface MappingRow { id: string; version: number; mapping: NotionMappingDto['mapping']; import_statuses: string[]; writeback: NotionMappingDto['writeback']; schema_fingerprint: string | null; updated_by: string | null }

export function schemaFingerprint(ds: NotionDataSource): string {
  return sha256Hex(stableStringify(Object.values(ds.properties).map((p) => ({ id: p.id, type: p.type })).sort((a, b) => a.id.localeCompare(b.id))));
}

function options(p: NotionDataSource['properties'][string]): string[] {
  const o = (p[p.type] as { options?: Array<{ name?: string }> } | undefined)?.options;
  return (o ?? []).map((x) => x.name ?? '').filter(Boolean).slice(0, 100);
}

async function loadDataSourceItem(ctx: Ctx, itemId: string, perm: 'content.read' | 'content.create' | 'connections.manage') {
  const item = await loadSourceItem(ctx, itemId);
  if (item.item_kind !== 'notion_data_source') throw new AppError('validation_failed', 'Not a Notion data source.');
  const conn = await connectionForBrand(ctx, item.connection_id, item.brand_id, perm);
  return { item, conn };
}

async function fetchSchema(conn: ContentConnectionRow, item: SourceItemRow): Promise<NotionDataSource> {
  try {
    const ds = await withSource(conn, (s) => retrieveDataSource(s.notion!, item.external_id));
    if (ds.in_trash) throw new SourceAccessError('trashed', 'not_found', 404, 'trashed');
    return ds;
  } catch (err) {
    await recordItemAccessFailure(item.id, err);
    throw err;
  }
}

async function loadMapping(itemId: string): Promise<MappingRow | null> {
  return maybeOne<MappingRow>(getPool(), `SELECT id, version, mapping, import_statuses, writeback, schema_fingerprint, updated_by FROM import_mappings WHERE source_item_id=$1`, [itemId]);
}

const mappingDto = (m: MappingRow | null): NotionMappingDto | null => (m ? { id: m.id, version: m.version, mapping: m.mapping, import_statuses: m.import_statuses, writeback: m.writeback, schema_fingerprint: m.schema_fingerprint } : null);

export async function getDataSourceSchema(ctx: Ctx, itemId: string): Promise<DataSourceSchemaDto> {
  const { item, conn } = await loadDataSourceItem(ctx, itemId, 'content.read');
  const ds = await fetchSchema(conn, item).catch((e) => { throw sourceAppError(e); });
  const title = richTextPlain(ds.title).text.trim() || item.title || 'Untitled data source';
  return {
    source_item_id: item.id, data_source_id: item.external_id, title,
    properties: Object.values(ds.properties).map((p) => ({ id: p.id, name: p.name, type: p.type, options: options(p) })),
    mapping: mappingDto(await loadMapping(item.id)), schema_fingerprint: schemaFingerprint(ds), approval_notice: APPROVAL_NOTICE,
  };
}

/** Validate a mapping against the live schema. Property names/values are configuration, never trusted identifiers of roles. */
export function mappingProblems(ds: NotionDataSource, m: Pick<NotionMappingDto, 'mapping' | 'import_statuses' | 'writeback'>, writebackAllowed: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  const byId = new Map(Object.values(ds.properties).map((p) => [p.id, p]));
  for (const [field, propId] of Object.entries(m.mapping ?? {})) {
    if (!MAPPING_FIELDS.includes(field as MappingField)) { errors[`mapping.${field}`] = 'Unknown field'; continue; }
    if (field === 'body' && propId === 'page_content') continue;
    const p = typeof propId === 'string' ? byId.get(propId) : undefined;
    if (!p) { errors[`mapping.${field}`] = 'Property not found in this data source'; continue; }
    if (!MAPPABLE_TYPES[field]!.includes(p.type)) errors[`mapping.${field}`] = `A ${p.type} property cannot be used as ${field.replace('_', ' ')}`;
  }
  const statuses = m.import_statuses ?? [];
  if (statuses.length) {
    const sp = m.mapping?.status ? byId.get(m.mapping.status) : undefined;
    if (!sp) errors.import_statuses = 'Map a status property to choose statuses';
    else {
      const known = new Set(options(sp));
      const unknown = statuses.filter((s) => !known.has(s));
      if (unknown.length) errors.import_statuses = `Unknown status: ${unknown.slice(0, 3).join(', ')}`;
    }
    if (statuses.length > 50 || statuses.some((s) => typeof s !== 'string' || s.length > 100)) errors.import_statuses = 'Too many or too long statuses';
  }
  const used = new Set<string>();
  for (const [field, propId] of Object.entries(m.writeback ?? {})) {
    if (!WRITEBACK_FIELDS.includes(field as WritebackField)) { errors[`writeback.${field}`] = 'Unknown field'; continue; }
    if (!writebackAllowed) { errors[`writeback.${field}`] = 'Turn on writeback for this connection first'; continue; }
    const p = typeof propId === 'string' ? byId.get(propId) : undefined;
    if (!p) { errors[`writeback.${field}`] = 'Property not found in this data source'; continue; }
    if (!WRITEBACK_TYPES[field]!.includes(p.type)) errors[`writeback.${field}`] = `Relay cannot write ${field.replace('_', ' ')} to a ${p.type} property`;
    if (used.has(p.id)) errors[`writeback.${field}`] = 'Each writeback needs its own property';
    used.add(p.id);
    // Field-scoped: never write into properties that carry imported content.
    for (const f of ['title', 'body', 'external_ref', 'campaign', 'target_date'] as const) {
      if (m.mapping?.[f] === p.id) errors[`writeback.${field}`] = `This property is imported as ${f.replace('_', ' ')}; choose another`;
    }
    // Loop prevention: Relay-written statuses must never select rows for import.
    if (field === 'status' && m.mapping?.status === p.id && statuses.some((s) => (RELAY_STATUS_VALUES as readonly string[]).includes(s))) {
      errors.import_statuses = 'Statuses written by Relay cannot also be imported';
    }
  }
  return errors;
}

export async function saveMapping(ctx: Ctx, itemId: string, input: { mapping: NotionMappingDto['mapping']; import_statuses?: string[]; writeback?: NotionMappingDto['writeback']; expected_version?: number | null }): Promise<NotionMappingDto> {
  const { item, conn } = await loadDataSourceItem(ctx, itemId, 'content.create');
  const wantsWriteback = !!input.writeback && Object.keys(input.writeback).length > 0;
  if (wantsWriteback) requireAction(ctx, 'connections.manage', { brandId: item.brand_id, message: 'Only people who manage connections can turn on writeback.' });
  if (!input.mapping || typeof input.mapping !== 'object') throw new AppError('validation_failed', 'Mapping is required', { mapping: 'Required' });
  const ds = await fetchSchema(conn, item).catch((e) => { throw sourceAppError(e); });
  const problems = mappingProblems(ds, { mapping: input.mapping, import_statuses: input.import_statuses ?? [], writeback: input.writeback ?? {} }, conn.writeback_enabled);
  if (Object.keys(problems).length) throw new AppError('validation_failed', 'The mapping is not valid for this data source.', problems);
  const fp = schemaFingerprint(ds);
  const saved = await withTx(async (tx) => {
    const cur = await maybeOne<{ id: string; version: number }>(tx, `SELECT id, version FROM import_mappings WHERE source_item_id=$1 FOR UPDATE`, [item.id]);
    if (cur && input.expected_version != null && cur.version !== input.expected_version) throw new AppError('version_conflict', 'Someone changed this mapping since you opened it.');
    const row = cur
      ? await maybeOne<MappingRow>(tx, `UPDATE import_mappings SET mapping=$2, import_statuses=$3, writeback=$4, schema_fingerprint=$5, version=version+1, updated_by=$6, updated_at=now()
          WHERE id=$1 RETURNING id, version, mapping, import_statuses, writeback, schema_fingerprint, updated_by`,
        [cur.id, JSON.stringify(input.mapping), input.import_statuses ?? [], JSON.stringify(input.writeback ?? {}), fp, ctx.actor.userId])
      : await maybeOne<MappingRow>(tx, `INSERT INTO import_mappings(workspace_id, brand_id, source_item_id, mapping, import_statuses, writeback, schema_fingerprint, created_by, updated_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id, version, mapping, import_statuses, writeback, schema_fingerprint, updated_by`,
        [ctx.access.workspaceId, item.brand_id, item.id, JSON.stringify(input.mapping), input.import_statuses ?? [], JSON.stringify(input.writeback ?? {}), fp, ctx.actor.userId]);
    // Changing the writeback scope cancels pending writes that targeted other properties.
    await tx.query(`UPDATE writeback_jobs SET status='cancelled', error_message='Mapping changed', updated_at=now(), completed_at=now()
      WHERE mapping_id=$1 AND status IN ('pending','conflict')`, [row!.id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: item.brand_id, actorUserId: ctx.actor.userId, action: 'content_mapping.saved', resourceType: 'import_mapping',
      resourceId: row!.id, diff: { version: row!.version, fields: Object.keys(input.mapping), writeback: Object.keys(input.writeback ?? {}), statuses: (input.import_statuses ?? []).length }, correlationId: ctx.correlationId });
    return row!;
  });
  return mappingDto(saved)!;
}

// ------------------------------------------------------------------ mapping rows
const propById = (page: NotionPage, id: string | undefined) => (id ? Object.values(page.properties ?? {}).find((v) => v.id === id) : undefined);

export interface MappedRow { title: string; bodyProp: string | null; campaign: string | null; target_date: string | null; status: string | null; external_ref: string | null; errors: string[] }

export function mapRow(page: NotionPage, m: Pick<NotionMappingDto, 'mapping' | 'import_statuses'>): MappedRow {
  const errors: string[] = [];
  const title = (m.mapping.title ? propertyValue(propById(page, m.mapping.title)) : null) ?? pageTitle(page);
  const bodyProp = m.mapping.body && m.mapping.body !== 'page_content' ? propertyValue(propById(page, m.mapping.body)) : null;
  const campaign = m.mapping.campaign ? propertyValue(propById(page, m.mapping.campaign)) : null;
  let target: string | null = m.mapping.target_date ? propertyValue(propById(page, m.mapping.target_date)) : null;
  if (target) {
    const start = target.split('/')[0]!;
    if (Number.isNaN(Date.parse(start))) { errors.push('Target date is not a valid date'); target = null; } else target = start;
  }
  const status = m.mapping.status ? propertyValue(propById(page, m.mapping.status)) : null;
  const ext = m.mapping.external_ref ? propertyValue(propById(page, m.mapping.external_ref)) : null;
  if (!title.trim()) errors.push('Title is empty');
  if (m.mapping.body && m.mapping.body !== 'page_content' && !bodyProp) errors.push('Body is empty');
  if (m.import_statuses.length && !(status && m.import_statuses.includes(status))) errors.push(`Status “${status ?? 'none'}” is not selected for import`);
  return { title: title.slice(0, 200), bodyProp, campaign: campaign?.slice(0, 120) ?? null, target_date: target, status, external_ref: ext?.slice(0, 200) ?? null, errors };
}

export async function previewRows(ctx: Ctx, itemId: string, q: { cursor?: string | null } = {}): Promise<RowsPreviewDto> {
  const { item, conn } = await loadDataSourceItem(ctx, itemId, 'content.create');
  const m = await loadMapping(item.id);
  if (!m) throw new AppError('invalid_state', 'Map the data source properties first.');
  const w = new Warnings();
  let pageRes;
  try {
    pageRes = await withSource(conn, (s) => queryDataSource(s.notion!, item.external_id, { cursor: q.cursor, pageSize: LIMITS.notionRowPreview }));
  } catch (err) {
    await recordItemAccessFailure(item.id, err);
    throw sourceAppError(err);
  }
  if (pageRes.request_status?.type === 'incomplete') w.add('incomplete_fetch', 'Notion returned an incomplete result for this data source.');
  const imported = new Map((await many<{ external_id: string; n: number }>(getPool(),
    `SELECT i.external_id, count(l.id)::int n FROM source_items i JOIN source_post_links l ON l.source_item_id=i.id AND l.superseded_at IS NULL
      WHERE i.parent_item_id=$1 GROUP BY i.external_id`, [item.id])).map((r) => [r.external_id, r.n]));
  const rows: RowPreviewDto[] = pageRes.results.filter((p) => !p.in_trash).map((p) => {
    const v = mapRow(p, m);
    return {
      row_id: normalizeNotionId(p.id), title: v.title, body_preview: excerpt(v.bodyProp ?? (m.mapping.body === 'page_content' ? '(page content)' : ''), 160),
      campaign: v.campaign, target_date: v.target_date, status: v.status, external_ref: v.external_ref, last_edited_time: p.last_edited_time ?? null,
      importable: v.errors.length === 0, errors: v.errors, already_imported: imported.has(normalizeNotionId(p.id)),
    };
  });
  return { rows, next_cursor: pageRes.has_more ? pageRes.next_cursor : null, incomplete: pageRes.request_status?.type === 'incomplete', warnings: w.list() };
}

// ------------------------------------------------------------------ row import (worker)
async function rowBody(s: NotionSession, page: NotionPage, m: MappingRow, v: MappedRow, w: Warnings) {
  if (m.mapping.body === 'page_content') {
    const tree = await fetchNotionTree(s, page.id, w);
    const sections = parseNotionBlocks(normalizeNotionId(page.id), v.title, tree.nodes, w);
    return { text: sections.map((x) => sectionText(x)).join('\n\n'), sections, incomplete: tree.incomplete };
  }
  const text = v.bodyProp ?? '';
  return { text, sections: [{ id: `${normalizeNotionId(page.id)}:body`, title: v.title, tab_id: null, tab_title: null, level: 0, blocks: [{ type: 'paragraph' as const, text }], word_count: text.split(/\s+/).filter(Boolean).length }], incomplete: false };
}

export async function runRowsImport(ctx: Ctx, row: ImportRow, item: SourceItemRow, conn: ContentConnectionRow): Promise<{ status: 'completed' | 'partial'; result: ImportDto['result']; snapshotId: string | null }> {
  const m = await loadMapping(item.id);
  if (!m || m.version !== row.options.mapping_version) throw new AppError('conflict', 'The mapping changed after this import was requested. Review it and import again.', undefined, { reason: 'mapping_changed' });
  const results: RowImportResult[] = [];
  const fetched: Array<{ rowId: string; page: NotionPage; v: MappedRow; body: Awaited<ReturnType<typeof rowBody>>; warnings: ReturnType<Warnings['list']> }> = [];
  await withSource(conn, async (s) => {
    const ds = await retrieveDataSource(s.notion!, item.external_id);
    const problems = mappingProblems(ds, m, true);
    if (Object.keys(problems).length) throw new AppError('validation_failed', 'The data source changed and the mapping no longer fits. Update the mapping.', problems, { reason: 'mapping_invalid' });
    for (const rowId of row.options.row_ids ?? []) {
      try {
        const page = await retrievePage(s.notion!, rowId);
        // Only rows OF THIS data source: a row id can never pull in an arbitrary page.
        if (normalizeNotionId(page.parent?.data_source_id ?? '00000000000000000000000000000000') !== item.external_id) { results.push({ row_id: rowId, status: 'error', message: 'Not a row of this data source' }); continue; }
        if (page.in_trash || page.archived) { results.push({ row_id: rowId, status: 'error', message: 'The row is in the trash' }); continue; }
        const v = mapRow(page, m);
        const statusError = v.errors.find((e) => e.startsWith('Status'));
        if (statusError) { results.push({ row_id: rowId, status: 'skipped', message: statusError }); continue; }
        if (v.errors.length) { results.push({ row_id: rowId, status: 'error', message: v.errors.join('; ') }); continue; }
        const w = new Warnings();
        const body = await rowBody(s.notion!, page, m, v, w);
        fetched.push({ rowId, page, v, body, warnings: w.list() });
      } catch (err) {
        if (err instanceof SourceAccessError && (err.kind === 'not_found' || err.kind === 'forbidden')) { results.push({ row_id: rowId, status: 'error', message: 'Not shared with the connection or removed' }); continue; }
        throw err;
      }
    }
  });
  // One transaction per row: a bad row never rolls back the others.
  for (const f of fetched) {
    try {
      const r = await withTx(async (tx) => {
        const rowItem = await maybeOne<{ id: string }>(tx,
          `INSERT INTO source_items(workspace_id, brand_id, connection_id, parent_item_id, item_kind, external_id, title, source_version, source_modified_at, external_url, state, created_by)
           VALUES ($1,$2,$3,$4,'notion_row',$5,$6,$7,$10,$8,'linked',$9)
           ON CONFLICT (connection_id, brand_id, item_kind, external_id) DO UPDATE SET title=EXCLUDED.title, external_url=EXCLUDED.external_url, state='linked', state_detail=NULL, updated_at=now()
           RETURNING id`,
          [row.workspace_id, row.brand_id, conn.id, item.id, f.rowId, f.v.title, f.page.last_edited_time ?? null, f.page.url && /^https:\/\//.test(f.page.url) ? f.page.url : null, ctx.actor.userId,
            f.page.last_edited_time ?? null]);
        const properties = Object.fromEntries(Object.values(f.page.properties ?? {}).map((pv) => [pv.id, { type: pv.type, value: propertyValue(pv), fingerprint: propertyFingerprint(pv) }]));
        const content = { title: f.v.title, sections: f.body.sections, properties, mapped: { ...f.v, errors: undefined } };
        const fp = sha256Hex(stableStringify({ doc: fingerprintSections(f.v.title, f.body.sections), mapped: { ...f.v, errors: undefined } }));
        const existing = await maybeOne<{ post_id: string; fingerprint: string | null }>(tx,
          `SELECT l.post_id, s.fingerprint FROM source_post_links l LEFT JOIN source_snapshots s ON s.id=l.snapshot_id
            WHERE l.source_item_id=$1 AND l.superseded_at IS NULL ORDER BY l.created_at DESC LIMIT 1`, [rowItem!.id]);
        if (existing && existing.fingerprint === fp) return { row_id: f.rowId, status: 'duplicate' as const, post_id: existing.post_id, message: 'Already imported' };
        if (existing) return { row_id: f.rowId, status: 'skipped' as const, post_id: existing.post_id, message: 'Changed since import — use Refresh on the row' };
        const snap = await createSnapshot(tx, { workspaceId: row.workspace_id, brandId: row.brand_id, itemId: rowItem!.id, kind: 'notion_row', fingerprint: fp, title: f.v.title,
          content, warnings: f.warnings, incomplete: f.body.incomplete, version: f.page.last_edited_time ?? null, modifiedAt: f.page.last_edited_time ?? null, importedBy: ctx.actor.userId });
        const campaignId = f.v.campaign ? await campaignByName(tx, ctx, row.brand_id, f.v.campaign) : null;
        const postId = await insertDraft(tx, ctx, {
          brandId: row.brand_id, title: f.v.title, text: f.body.text || blocksToText([]), connectionIds: row.options.connection_ids, campaignId,
          dueAt: f.v.target_date ? new Date(f.v.target_date) : null,
          source: { kind: 'content_hub', source: 'notion', item_id: rowItem!.id, snapshot_id: snap.id, import_id: row.id, external_ref: f.v.external_ref, external_status: f.v.status },
        });
        await linkPost(tx, ctx, { brandId: row.brand_id, postId, itemId: rowItem!.id, snapshotId: snap.id, importId: row.id, sectionIds: f.body.sections.map((x) => x.id), text: f.body.text });
        return { row_id: f.rowId, status: 'imported' as const, post_id: postId };
      });
      results.push(r);
    } catch (err) {
      if (!(err instanceof AppError)) log.warn('content_row_import_failed', { importId: row.id, rowId: f.rowId, err: { name: (err as Error).name, message: (err as Error).message } });
      results.push({ row_id: f.rowId, status: 'error', message: err instanceof AppError ? err.message : 'Could not import this row' });
    }
  }
  await getPool().query(`UPDATE source_items SET last_synced_at=now(), updated_at=now() WHERE id=$1`, [item.id]);
  await audit(getPool(), { workspaceId: row.workspace_id, brandId: row.brand_id, actorUserId: ctx.actor.userId, action: 'content_import.completed', resourceType: 'import', resourceId: row.id,
    diff: { action: 'notion_rows', imported: results.filter((r) => r.status === 'imported').length, errors: results.filter((r) => r.status === 'error').length }, correlationId: ctx.correlationId });
  const order = new Map((row.options.row_ids ?? []).map((id, i) => [id, i]));
  results.sort((a, b) => (order.get(a.row_id) ?? 0) - (order.get(b.row_id) ?? 0));
  const bad = results.some((r) => r.status === 'error');
  return { status: bad ? 'partial' : 'completed', result: { rows: results, post_ids: results.filter((r) => r.status === 'imported').map((r) => r.post_id!) }, snapshotId: null };
}

export { draftTextHash };
