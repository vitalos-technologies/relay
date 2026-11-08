// Reports (V3 spec §8 "Reports"): saved views + reproducible exports.
//  - Saved views store URL-serialisable filter state only (ids/dates/timezone). Opening one re-authorizes the scope
//    against the CURRENT policy (a brand you lost access to ⇒ 404), then runs the view.
//  - Exports are async jobs (report_exports, worker queue 'analytics-report-export'): requested with analytics.read +
//    exports.create on every brand in scope (MFA/step-up per policy at request time), budgeted (exports.count) and
//    rate limited. The job re-loads the requester's CURRENT grants (never trusting the queue payload) and fails with
//    access_revoked when they no longer cover the scope. Files: CSV (formula-injection safe), HTML, PDF (server-side
//    Chromium when available; otherwise HTML with an explicit note). External destinations go through ReportExporter.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, notFound, type Provider } from '@social-lite/core';
import type {
  AnalyticsFilters, AnalyticsView, ContentRow, ReportDefinitionDto, ReportExportDto, ReportExportFormat, ReportManifest,
} from '@social-lite/core/contracts/analytics';
import type { ExportDestinationKind, ExportFormat } from '@social-lite/core/contracts/exports';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { enforceRateLimit } from '../ratelimit.js';
import { deleteObject, ensureBucket, getObjectBytes, putObject } from '../storage.js';
import { loadUserAuthz, brandsVisible } from '../authz.js';
import { assertUuid, authorizeCtx, requireAction } from '../tenancy.js';
import { releaseUsage, reserveUsage, settleUsage } from '../product/budgets.js';
import { parseFilters, serializeFilters } from './filters.js';
import { audience, channels, contentTable, defaultTimezone, overview, resolveScope, video, workflow } from './query.js';
import { buildManifest, renderCsv, renderHtml, type ViewData } from './render.js';
import { reportExporterFor } from './exporters.js';
import { assertFeatureConfigurable } from '../entitlements/actions.js';
import { renderPdf } from './pdf.js';

export const QUEUE_REPORT_EXPORT = 'analytics-report-export'; // distinct from Content Hub's 'report-export' (destination writes)
export const EXPORT_TTL_DAYS = 7;
export const EXPORT_MAX_ROWS = 5_000;
export const EXPORT_MAX_BYTES = 20 * 1024 * 1024;
export const EXPORT_RATE = { capacity: 10, refillPerSecond: 10 / 3600 };
const VIEWS = ['overview', 'content', 'channels', 'video', 'audience', 'workflow'] as const;

// ------------------------------------------------------------------ helpers
async function filtersFrom(ctx: Ctx, raw: { filters?: unknown; query_string?: string | null }): Promise<AnalyticsFilters> {
  const params = raw.query_string ? new URLSearchParams(raw.query_string.replace(/^\?/, '')) : null;
  const brandParam = params?.get('brand') ?? (raw.filters && typeof raw.filters === 'object' ? ((raw.filters as Record<string, unknown>).brand_ids as string[] | undefined)?.join(',') ?? null : null);
  const tz = await defaultTimezone(ctx, brandParam);
  if (params) return parseFilters(params, { timezone: tz });
  if (raw.filters && typeof raw.filters === 'object') return parseFilters(raw.filters as Record<string, unknown>, { timezone: tz });
  return parseFilters(new URLSearchParams(), { timezone: tz });
}

/** Brands an export/report touches: explicit filter brands, else every brand the caller can read analytics on. */
async function scopeBrands(ctx: Ctx, f: AnalyticsFilters): Promise<string[]> {
  return (await resolveScope(ctx, f)).brands.map((b) => b.id);
}

// ------------------------------------------------------------------ saved views
const reportInput = z.object({
  name: z.string().trim().min(1).max(120),
  view: z.enum(VIEWS),
  query_string: z.string().max(4000).optional().nullable(),
  filters: z.record(z.string(), z.unknown()).optional().nullable(),
  visibility: z.enum(['private', 'workspace']).default('private'),
}).strict();

interface ReportRow {
  id: string; workspace_id: string; owner_user_id: string | null; name: string; view: AnalyticsView; filters: AnalyticsFilters; query_string: string;
  visibility: 'private' | 'workspace'; brand_ids: string[]; created_at: Date; updated_at: Date; archived_at: Date | null;
}

function reportDto(ctx: Ctx, r: ReportRow): ReportDefinitionDto {
  return { id: r.id, name: r.name, view: r.view, filters: r.filters, query_string: r.query_string, visibility: r.visibility, owner_user_id: r.owner_user_id,
    is_owner: r.owner_user_id === ctx.actor.userId, created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString() };
}

export async function createReport(ctx: Ctx, raw: unknown): Promise<ReportDefinitionDto> {
  requireAction(ctx, 'analytics.read');
  await assertFeatureConfigurable(getPool(), ctx.access.workspaceId, 'analytics_advanced'); // V4: saved reports are Professional
  const input = reportInput.parse(raw ?? {});
  const f = await filtersFrom(ctx, input);
  await resolveScope(ctx, f); // the creator must be able to see everything the view references
  const r = await withTx(async (tx) => {
    const row = await one<ReportRow>(tx,
      `INSERT INTO report_definitions(workspace_id, owner_user_id, name, view, filters, query_string, visibility, brand_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ctx.access.workspaceId, ctx.actor.userId, input.name, input.view, JSON.stringify(f), serializeFilters(f), input.visibility, f.brand_ids]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'analytics.report_saved', resourceType: 'report_definition',
      resourceId: row.id, diff: { view: input.view, visibility: input.visibility, query: row.query_string }, correlationId: ctx.correlationId });
    return row;
  });
  return reportDto(ctx, r);
}

async function loadReport(ctx: Ctx, id: string, db: Queryable = getPool()): Promise<ReportRow> {
  assertUuid(id, 'Report');
  const r = await maybeOne<ReportRow>(db, `SELECT * FROM report_definitions WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [id, ctx.access.workspaceId]);
  if (!r || (r.visibility === 'private' && r.owner_user_id !== ctx.actor.userId)) throw notFound('Report');
  return r;
}

/** Saved views the caller can open now (access to every referenced brand re-checked; others are hidden). */
export async function listReports(ctx: Ctx): Promise<ReportDefinitionDto[]> {
  requireAction(ctx, 'analytics.read');
  const rows = await many<ReportRow>(getPool(),
    `SELECT * FROM report_definitions WHERE workspace_id=$1 AND archived_at IS NULL AND (visibility='workspace' OR owner_user_id=$2) ORDER BY updated_at DESC LIMIT 200`,
    [ctx.access.workspaceId, ctx.actor.userId]);
  return rows.filter((r) => r.brand_ids.every((b) => authorizeCtx(ctx, 'analytics.read', { brandId: b }).allowed)).map((r) => reportDto(ctx, r));
}

/** Open a saved view: access is rechecked against the current policy, then the view runs with its stored filters. */
export async function openReport(ctx: Ctx, id: string): Promise<{ report: ReportDefinitionDto; data: ViewData['data'] }> {
  requireAction(ctx, 'analytics.read');
  const r = await loadReport(ctx, id);
  const f = parseFilters(r.filters as unknown as Record<string, unknown>, { timezone: r.filters.timezone });
  const data = (await runView(ctx, r.view, f)).data;
  return { report: reportDto(ctx, r), data };
}

export async function updateReport(ctx: Ctx, id: string, raw: unknown): Promise<ReportDefinitionDto> {
  requireAction(ctx, 'analytics.read');
  const input = reportInput.partial().strict().parse(raw ?? {});
  const r = await loadReport(ctx, id);
  if (r.owner_user_id !== ctx.actor.userId) throw new AppError('forbidden', 'Only the owner can change this report.');
  const f = input.filters || input.query_string ? await filtersFrom(ctx, input) : r.filters;
  if (input.filters || input.query_string) await resolveScope(ctx, f);
  const row = await one<ReportRow>(getPool(),
    `UPDATE report_definitions SET name=$3, view=$4, filters=$5, query_string=$6, visibility=$7, brand_ids=$8, updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [r.id, ctx.access.workspaceId, input.name ?? r.name, input.view ?? r.view, JSON.stringify(f), serializeFilters(f), input.visibility ?? r.visibility, f.brand_ids]);
  return reportDto(ctx, row);
}

export async function deleteReport(ctx: Ctx, id: string): Promise<{ ok: true }> {
  requireAction(ctx, 'analytics.read');
  const r = await loadReport(ctx, id);
  if (r.owner_user_id !== ctx.actor.userId) throw new AppError('forbidden', 'Only the owner can delete this report.');
  await getPool().query(`UPDATE report_definitions SET archived_at=now() WHERE id=$1 AND workspace_id=$2`, [r.id, ctx.access.workspaceId]);
  return { ok: true };
}

// ------------------------------------------------------------------ views (shared by API, reports and exports)
export async function runView(ctx: Ctx, view: AnalyticsView, f: AnalyticsFilters, opts: { measure?: string | null; sort?: string | null; dir?: string | null } = {}): Promise<ViewData> {
  switch (view) {
    case 'overview': return { view, data: await overview(ctx, f, { measure: opts.measure }) };
    case 'channels': return { view, data: await channels(ctx, f, { measure: opts.measure }) };
    case 'video': return { view, data: await video(ctx, f) };
    case 'audience': return { view, data: await audience(ctx, f) };
    case 'workflow': return { view, data: await workflow(ctx, f) };
    case 'content': {
      const first = await contentTable(ctx, f, { sort: opts.sort, dir: opts.dir, page: 1, page_size: 100 });
      const all: ContentRow[] = [...first.rows];
      for (let page = 2; all.length < Math.min(first.total, EXPORT_MAX_ROWS); page++) {
        const next = await contentTable(ctx, f, { sort: opts.sort, dir: opts.dir, page, page_size: 100 });
        if (!next.rows.length) break;
        all.push(...next.rows);
      }
      return { view, data: { ...first, all_rows: all.slice(0, EXPORT_MAX_ROWS) } };
    }
  }
}

// ------------------------------------------------------------------ exports
const exportInput = z.object({
  view: z.enum(VIEWS),
  format: z.enum(['csv', 'pdf', 'html']),
  destination: z.enum(['download', 'google_doc', 'drive_file', 'notion_page']).default('download'),
  destination_ref: z.object({ connection_id: z.string().uuid(), parent_id: z.string().max(200).nullable().optional() }).strict().optional().nullable(),
  report_id: z.string().uuid().optional().nullable(),
  query_string: z.string().max(4000).optional().nullable(),
  filters: z.record(z.string(), z.unknown()).optional().nullable(),
  measure: z.string().max(40).optional().nullable(),
  sort: z.string().max(40).optional().nullable(),
  dir: z.enum(['asc', 'desc']).optional().nullable(),
  title: z.string().trim().max(200).optional().nullable(),
}).strict();

interface ExportRow {
  id: string; workspace_id: string; requested_by: string | null; report_definition_id: string | null; view: AnalyticsView; format: ReportExportFormat;
  destination: 'download' | ExportDestinationKind; destination_ref: { connection_id: string; parent_id: string | null; options?: { measure?: string | null; sort?: string | null; dir?: string | null; title?: string | null } } | null;
  filters: AnalyticsFilters; query_string: string; brand_ids: string[]; status: ReportExportDto['status']; attempts: number; object_key: string | null;
  content_type: string | null; filename: string | null; bytes: string | null; checksum_sha256: string | null; row_count: number | null; manifest: (ReportManifest & { delivered_format?: ReportExportFormat; notes?: string[] }) | null;
  destination_result: { url: string | null; external_id: string | null; sharing_warning: string | null; job_id?: string } | null; error_code: string | null;
  error_message: string | null; reservation_id: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null; expires_at: Date | null;
}

function exportDto(r: ExportRow): ReportExportDto {
  return {
    id: r.id, view: r.view, format: r.format, destination: r.destination, status: r.status, query_string: r.query_string, report_definition_id: r.report_definition_id,
    filename: r.filename, bytes: r.bytes === null ? null : Number(r.bytes), row_count: r.row_count, manifest: r.manifest,
    delivered_format: r.manifest?.delivered_format ?? (r.status === 'succeeded' ? r.format : null), destination_result: r.destination_result
      ? { url: r.destination_result.url, external_id: r.destination_result.external_id, sharing_warning: r.destination_result.sharing_warning } : null,
    error: r.error_code ? { code: r.error_code, message: r.error_message ?? 'Export failed' } : null,
    created_at: r.created_at.toISOString(), finished_at: r.finished_at?.toISOString() ?? null, expires_at: r.expires_at?.toISOString() ?? null,
    download_path: r.object_key && r.status !== 'expired' ? `/api/analytics/exports/${r.id}/download` : null,
  };
}

function requireExportOn(ctx: Ctx, brandIds: string[]): void {
  requireAction(ctx, 'exports.create');
  for (const b of brandIds) {
    const r = authorizeCtx(ctx, 'exports.create', { brandId: b });
    if (!r.allowed) requireAction(ctx, 'exports.create', { brandId: b, message: 'You cannot export analytics for every selected brand. Narrow the brand filter.' });
  }
}

/** Request an export (no provider calls, no rendering in the request). */
export async function requestReportExport(ctx: Ctx, raw: unknown): Promise<ReportExportDto> {
  requireAction(ctx, 'analytics.read');
  const input = exportInput.parse(raw ?? {});
  let view: AnalyticsView = input.view;
  let source: { filters?: unknown; query_string?: string | null } = input;
  if (input.report_id) {
    const r = await loadReport(ctx, input.report_id);
    view = r.view; source = { filters: r.filters };
  }
  const f = await filtersFrom(ctx, source);
  const brandIds = await scopeBrands(ctx, f);
  requireExportOn(ctx, brandIds);
  if (input.destination !== 'download' && !input.destination_ref) throw new AppError('validation_failed', 'Choose a destination', { destination_ref: 'Required for this destination' });
  if (input.destination === 'google_doc' && input.format === 'pdf') throw new AppError('validation_failed', 'A PDF cannot become a Google Doc; export it as a Drive file.');
  await enforceRateLimit('analyticsExport', ctx.actor.userId, EXPORT_RATE);
  const id = randomUUID();
  const reservation = await reserveUsage({ workspaceId: ctx.access.workspaceId, meter: 'exports.count', amount: 1, userId: ctx.actor.userId, ref: `export:analytics:${id}`, ttlSeconds: 3600 });
  try {
    const row = await withTx(async (tx) => {
      const r = await one<ExportRow>(tx,
        `INSERT INTO report_exports(id, workspace_id, requested_by, report_definition_id, view, format, destination, destination_ref, filters, query_string, brand_ids, reservation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [id, ctx.access.workspaceId, ctx.actor.userId, input.report_id ?? null, view, input.format, input.destination,
          JSON.stringify({ connection_id: input.destination_ref?.connection_id ?? null, parent_id: input.destination_ref?.parent_id ?? null,
            options: { measure: input.measure ?? null, sort: input.sort ?? null, dir: input.dir ?? null, title: input.title ?? null } }),
          JSON.stringify(f), serializeFilters(f), brandIds, reservation.id]);
      await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'analytics.export_requested', resourceType: 'report_export',
        resourceId: id, diff: { view, format: input.format, destination: input.destination, query: r.query_string }, correlationId: ctx.correlationId });
      return r;
    });
    return exportDto(row);
  } catch (err) {
    await releaseUsage(reservation.id).catch(() => undefined);
    throw err;
  }
}

async function loadExport(ctx: Ctx, id: string): Promise<ExportRow> {
  assertUuid(id, 'Export');
  const r = await maybeOne<ExportRow>(getPool(), `SELECT * FROM report_exports WHERE id=$1 AND workspace_id=$2`, [id, ctx.access.workspaceId]);
  if (!r || r.requested_by !== ctx.actor.userId) throw notFound('Export');
  return r;
}

export async function getReportExport(ctx: Ctx, id: string): Promise<ReportExportDto> {
  requireAction(ctx, 'analytics.read');
  return exportDto(await loadExport(ctx, id));
}

export async function listReportExports(ctx: Ctx): Promise<ReportExportDto[]> {
  requireAction(ctx, 'analytics.read');
  const rows = await many<ExportRow>(getPool(), `SELECT * FROM report_exports WHERE workspace_id=$1 AND requested_by=$2 ORDER BY created_at DESC LIMIT 50`,
    [ctx.access.workspaceId, ctx.actor.userId]);
  return rows.map(exportDto);
}

/** Download: requester only, CURRENT access re-checked (analytics.read + exports.create on the export's scope). */
export async function downloadReportExport(ctx: Ctx, id: string): Promise<{ filename: string; contentType: string; body: Buffer }> {
  requireAction(ctx, 'analytics.read');
  const r = await loadExport(ctx, id);
  if (!r.object_key || r.status === 'expired' || (r.expires_at && r.expires_at < new Date())) throw notFound('Export file');
  for (const b of r.brand_ids) if (!authorizeCtx(ctx, 'analytics.read', { brandId: b }).allowed) throw notFound('Export');
  requireExportOn(ctx, r.brand_ids);
  const body = await getObjectBytes(r.object_key, EXPORT_MAX_BYTES);
  return { filename: r.filename ?? `relay-${r.view}.${r.format}`, contentType: r.content_type ?? 'application/octet-stream', body };
}

/** The requester's CURRENT authority (grants/membership reloaded; never trusted from the queue payload). */
async function jobCtx(r: ExportRow): Promise<Ctx | null> {
  if (!r.requested_by) return null;
  const db = getPool();
  const m = await maybeOne<{ role: Ctx['access']['role']; is_demo: boolean; state: string; status: string; email: string; name: string | null }>(db,
    `SELECT m.role, w.is_demo, w.state, m.status, u.email, u.name FROM memberships m JOIN workspaces w ON w.id = m.workspace_id JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.removed_at IS NULL`, [r.workspace_id, r.requested_by]);
  if (!m || m.state !== 'active' || m.status !== 'active') return null;
  const authz = await loadUserAuthz(r.requested_by, r.workspace_id, null, db); // assurance was enforced at request time
  if (authz.subject.status !== 'active') return null;
  return { actor: { userId: r.requested_by, email: m.email, name: m.name, sessionId: `job:${r.id}` },
    access: { workspaceId: r.workspace_id, role: m.role, brandIds: brandsVisible(authz), isDemo: m.is_demo, authz }, correlationId: `report-export:${r.id}` };
}

const EXT: Record<ReportExportFormat, string> = { csv: 'csv', pdf: 'pdf', html: 'html' };
const MIME: Record<ReportExportFormat, string> = { csv: 'text/csv; charset=utf-8', pdf: 'application/pdf', html: 'text/html; charset=utf-8' };

/** Worker job: render and store one export. Idempotent: only a queued (or stale running) export is claimed. */
export async function runReportExport(exportId: string, opts: { workerId?: string } = {}): Promise<ReportExportDto | null> {
  const db = getPool();
  const r = await maybeOne<ExportRow>(db,
    `UPDATE report_exports SET status='running', started_at=now(), attempts=attempts+1
      WHERE id=$1 AND (status='queued' OR (status='running' AND started_at < now() - interval '15 minutes')) AND attempts < 5 RETURNING *`, [exportId]);
  if (!r) return null;
  const fail = async (code: string, message: string, extra: Partial<ExportRow> = {}) => {
    const row = await one<ExportRow>(db,
      `UPDATE report_exports SET status='failed', error_code=$2, error_message=$3, finished_at=now(), object_key=coalesce($4, object_key), content_type=coalesce($5, content_type),
              filename=coalesce($6, filename), bytes=coalesce($7, bytes), manifest=coalesce($8, manifest), expires_at=CASE WHEN $4::text IS NOT NULL THEN now() + make_interval(days => $9) ELSE expires_at END
        WHERE id=$1 RETURNING *`,
      [r.id, code, message.slice(0, 500), extra.object_key ?? null, extra.content_type ?? null, extra.filename ?? null, extra.bytes ?? null,
        extra.manifest ? JSON.stringify(extra.manifest) : null, EXPORT_TTL_DAYS]);
    if (r.reservation_id) await releaseUsage(r.reservation_id).catch(() => undefined);
    await audit(db, { workspaceId: r.workspace_id, actorService: 'worker', action: 'analytics.export_failed', resourceType: 'report_export', resourceId: r.id, diff: { code } });
    return exportDto(row);
  };
  // Re-check authority NOW (revoked access stops the export).
  const ctx = await jobCtx(r);
  if (!ctx) return fail('access_revoked', 'The requester no longer has access to this workspace.');
  let data: ViewData;
  try {
    requireAction(ctx, 'analytics.read');
    const brands = (await resolveScope(ctx, r.filters)).brands.map((b) => b.id);
    for (const b of r.brand_ids) if (!brands.includes(b)) throw notFound('Brand');
    requireExportOn(ctx, brands);
    const o = r.destination_ref?.options ?? {};
    data = await runView(ctx, r.view, r.filters, { measure: o.measure, sort: o.sort, dir: o.dir });
  } catch (err) {
    if (err instanceof AppError && ['not_found', 'forbidden', 'mfa_required', 'step_up_required'].includes(err.code)) {
      return fail('access_revoked', 'Access to part of this report was removed after it was requested; nothing was exported.');
    }
    log.error('analytics_export_failed', { exportId: r.id, err: err as Error });
    await db.query(`UPDATE report_exports SET status='queued' WHERE id=$1 AND attempts < 5`, [r.id]);
    throw err;
  }
  const title = r.destination_ref?.options?.title ?? null;
  const manifest: ReportManifest & { delivered_format?: ReportExportFormat; notes?: string[] } = buildManifest(data, { title, requestedBy: ctx.actor.email });
  let format: ReportExportFormat = r.format;
  let body: Buffer;
  const notes: string[] = [];
  if (r.format === 'csv') body = Buffer.from(renderCsv(data, manifest), 'utf8');
  else {
    const html = renderHtml(data, manifest);
    if (r.format === 'pdf') {
      const pdf = await renderPdf(html);
      if (pdf) body = pdf;
      else { format = 'html'; body = Buffer.from(html, 'utf8'); notes.push('PDF rendering is not available on this server; the report was delivered as HTML (print it to PDF from a browser).'); }
    } else body = Buffer.from(html, 'utf8');
  }
  manifest.delivered_format = format;
  if (notes.length) manifest.notes = notes;
  if (body.length > EXPORT_MAX_BYTES) return fail('too_large', 'The report is larger than 20 MB. Narrow the filters.');
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `relay-${r.view}-${r.filters.from}_${r.filters.to}-${stamp}.${EXT[format]}`;
  const key = `exports/${r.workspace_id}/${r.id}/${filename}`;
  if (config().APP_ENV !== 'production') await ensureBucket();
  await putObject(key, new Uint8Array(body), MIME[format], { 'export-id': r.id });
  const checksum = createHash('sha256').update(body).digest('hex');
  const rowCount = data.view === 'content' ? data.data.all_rows.length : null;
  let destinationResult: ExportRow['destination_result'] = null;
  if (r.destination !== 'download') {
    const exporter = reportExporterFor(r.destination);
    const singleBrand = r.brand_ids.length === 1 ? r.brand_ids[0]! : null;
    const job = await exporter.export(ctx, {
      destination: { kind: r.destination, connectionId: r.destination_ref?.connection_id ?? '', parentId: r.destination_ref?.parent_id ?? null },
      title: manifest.title, format: format as ExportFormat, ...(format === 'html' ? { html: body.toString('utf8') } : { contentBytes: new Uint8Array(body), mimeType: MIME[format].split(';')[0] }),
      content: { kind: 'analytics_report', brandId: singleBrand, permission: 'analytics.read', ref: r.id }, idempotencyKey: `report-export:${r.id}`,
    }).catch((err: unknown) => ({ status: 'failed' as const, error: { code: err instanceof AppError ? err.code : 'destination_failed', message: err instanceof Error ? err.message : 'Export destination failed' }, id: '', result_url: null, result_external_id: null, sharing_warning: null }));
    if (job.status === 'failed') {
      return fail(job.error?.code ?? 'destination_failed', job.error?.message ?? 'The destination could not be written.',
        { object_key: key, content_type: MIME[format], filename, bytes: String(body.length), manifest });
    }
    destinationResult = { url: job.result_url, external_id: job.result_external_id, sharing_warning: job.sharing_warning, job_id: job.id };
  }
  const row = await one<ExportRow>(db,
    `UPDATE report_exports SET status='succeeded', object_key=$2, content_type=$3, filename=$4, bytes=$5, checksum_sha256=$6, row_count=$7, manifest=$8,
            destination_result=$9, finished_at=now(), expires_at=now() + make_interval(days => $10), error_code=NULL, error_message=NULL WHERE id=$1 RETURNING *`,
    [r.id, key, MIME[format], filename, body.length, checksum, rowCount, JSON.stringify(manifest), destinationResult ? JSON.stringify(destinationResult) : null, EXPORT_TTL_DAYS]);
  if (r.reservation_id) await settleUsage(r.reservation_id, 1).catch(() => undefined);
  await audit(db, { workspaceId: r.workspace_id, actorService: opts.workerId ?? 'worker', action: 'analytics.export_completed', resourceType: 'report_export', resourceId: r.id,
    diff: { view: r.view, format, bytes: body.length, rows: rowCount, destination: r.destination } });
  return exportDto(row);
}

/** Exports waiting for the worker (DB is the durable queue; pg-boss job id = export id). */
export async function queuedExports(limit = 20): Promise<Array<{ id: string; workspace_id: string }>> {
  return many(getPool(), `SELECT id, workspace_id FROM report_exports WHERE status='queued' ORDER BY created_at LIMIT $1`, [limit]);
}

/** Retention: delete expired export files. */
export async function sweepExpiredExports(limit = 100): Promise<number> {
  const rows = await many<{ id: string; object_key: string }>(getPool(),
    `SELECT id, object_key FROM report_exports WHERE status IN ('succeeded','failed') AND object_key IS NOT NULL AND expires_at < now() ORDER BY expires_at LIMIT $1`, [limit]);
  for (const r of rows) {
    await deleteObject(r.object_key).catch((err) => log.warn('export_delete_failed', { exportId: r.id, err: err as Error }));
    await getPool().query(`UPDATE report_exports SET status='expired', object_key=NULL WHERE id=$1`, [r.id]);
  }
  return rows.length;
}

export type { Provider };
