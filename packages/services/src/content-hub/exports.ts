// Exports to Google Docs / Drive / Notion (ReportExporter, packages/core/src/contracts/exports.ts).
// Explicit, permissioned action. Two INDEPENDENT checks, at request time and again when the job runs:
//   destination — the connection is usable by this person for the brand (exports.create) and the parent is an
//                 explicitly selected, verified export destination (or Drive root);
//   content     — the person may read the exported content (analytics.read / content.read on the brand).
// Always creates a NEW document/file/page; never overwrites, never calls sharing/permissions endpoints.
import { createHash, randomUUID } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import type { ExportDestinationKind, ExportInput, ExportJob, ReportExporter } from '@social-lite/core/contracts/exports';
import { getPool, many, maybeOne, withTx } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { log } from '../log.js';
import { writeOutbox } from '../outbox.js';
import { deleteObject, ensureBucket, getObjectBytes, putObject } from '../storage.js';
import { config } from '../config.js';
import { assertBrand, assertUuid, authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';
import { loadContentConnection, withSource, type ContentConnectionRow } from './connections.js';
import { LIMITS } from './config.js';
import { createFile, MIME } from './google.js';
import { htmlToText, textToHtml } from './normalize.js';
import { appendChildren, createChildPage } from './notion.js';
import { jobCtx, RetryLaterError } from './imports.js';
import { SourceAccessError } from './transport.js';

interface ExportRow {
  id: string; workspace_id: string; brand_id: string | null; connection_id: string; destination_kind: ExportDestinationKind; destination_parent_id: string | null;
  title: string; format: ExportInput['format']; content_ref: ExportInput['content'] & { mime?: string; payload: 'html' | 'text' | 'bytes' }; content_key: string | null;
  content_sha256: string | null; content_bytes: number | null; idempotency_key: string; status: ExportJob['status']; sharing_warning: string | null;
  result: { url?: string; external_id?: string }; error_code: string | null; error_message: string | null; attempts: number; requested_by: string | null;
  created_at: Date; started_at: Date | null; completed_at: Date | null;
}

export function exportJson(r: ExportRow): ExportJob {
  return {
    id: r.id, status: r.status, destination_kind: r.destination_kind, destination_parent_id: r.destination_parent_id, title: r.title, format: r.format,
    brand_id: r.brand_id, created_at: r.created_at.toISOString(), completed_at: r.completed_at?.toISOString() ?? null,
    result_url: r.status === 'completed' ? r.result.url ?? null : null, result_external_id: r.status === 'completed' ? r.result.external_id ?? null : null,
    sharing_warning: r.sharing_warning, error: r.error_code ? { code: r.error_code, message: r.error_message ?? 'Export failed' } : null,
  };
}

const KIND_SOURCE: Record<ExportDestinationKind, 'google' | 'notion'> = { google_doc: 'google', drive_file: 'google', notion_page: 'notion' };

/** Destination check (independent of the content check). Returns the connection and the destination grant title. */
async function checkDestination(ctx: Ctx, input: Pick<ExportInput, 'destination' | 'content'>): Promise<{ conn: ContentConnectionRow; parentTitle: string | null }> {
  const d = input.destination;
  const brandId = input.content.brandId;
  // exports.create on the brand (or workspace-wide for workspace exports).
  requireAction(ctx, 'exports.create', { brandId: brandId ?? null, message: 'You do not have permission to export.' });
  if (brandId) await assertBrand(ctx, brandId);
  const conn = await loadContentConnection(ctx, d.connectionId);
  if (conn.brand_id && conn.brand_id !== brandId) throw notFound('Connection');
  if (conn.disconnected_at || conn.status !== 'active') throw new AppError('invalid_state', 'The destination connection is not active. Reconnect it.');
  if (KIND_SOURCE[d.kind] !== conn.source) throw new AppError('validation_failed', 'This destination does not match the connection.', { destination: 'Wrong connection type' });
  if (d.kind === 'notion_page' && !d.parentId) throw new AppError('validation_failed', 'Choose a Notion page to create the export under.', { destination: 'Parent page required' });
  if (!d.parentId) return { conn, parentTitle: null };
  const grant = await maybeOne<{ title: string | null; writable: boolean }>(getPool(),
    `SELECT title, writable FROM source_grants WHERE connection_id=$1 AND external_id=$2 AND purpose='export_destination' AND revoked_at IS NULL`, [conn.id, d.parentId]);
  if (!grant) throw new AppError('validation_failed', 'Select the destination folder or page first.', { destination: 'Not a selected destination' });
  if (!grant.writable) throw new AppError('invalid_state', 'Relay cannot create files in that destination.');
  return { conn, parentTitle: grant.title };
}

/** Content check (independent of the destination): may this person read what is being exported? */
function checkContent(ctx: Ctx, input: Pick<ExportInput, 'content'>): void {
  const c = input.content;
  if (c.permission !== 'analytics.read' && c.permission !== 'content.read') throw new AppError('validation_failed', 'Unknown content permission');
  const r = authorizeCtx(ctx, c.permission, { brandId: c.brandId ?? null });
  if (!r.allowed) throw new AppError('forbidden', 'You do not have permission to export this content.');
}

export function sharingWarning(kind: ExportDestinationKind, parentTitle: string | null, accountLabel: string): string {
  if (kind === 'notion_page') return `The new page is created under “${parentTitle ?? 'the selected page'}” and inherits its sharing. Relay does not change sharing.`;
  if (!parentTitle) return `The new ${kind === 'google_doc' ? 'Doc' : 'file'} is created in My Drive of ${accountLabel} and is private to that account until someone shares it. Relay does not change sharing.`;
  return `The new ${kind === 'google_doc' ? 'Doc' : 'file'} is created in “${parentTitle}” and inherits that folder’s sharing (including Shared Drive members). Relay does not change sharing.`;
}

function payloadOf(input: ExportInput): { bytes: Buffer; kind: 'html' | 'text' | 'bytes'; mime: string } {
  const set = [input.html !== undefined, input.text !== undefined, input.contentBytes !== undefined].filter(Boolean).length;
  if (set !== 1) throw new AppError('validation_failed', 'Provide exactly one of html, text or contentBytes.');
  if (input.html !== undefined) return { bytes: Buffer.from(input.html, 'utf8'), kind: 'html', mime: 'text/html' };
  if (input.text !== undefined) return { bytes: Buffer.from(input.text, 'utf8'), kind: 'text', mime: input.format === 'markdown' ? 'text/markdown' : input.format === 'csv' ? 'text/csv' : 'text/plain' };
  const mime = input.mimeType ?? ({ pdf: 'application/pdf', csv: 'text/csv', html: 'text/html', markdown: 'text/markdown', text: 'text/plain' } as const)[input.format];
  return { bytes: Buffer.from(input.contentBytes!), kind: 'bytes', mime };
}

export const exportKey = (ctx: Ctx, input: ExportInput, sha: string) =>
  createHash('sha256').update(JSON.stringify([ctx.actor.userId, input.destination, input.title, input.format, sha, input.content, input.idempotencyKey ?? randomUUID()])).digest('hex');

/** Request an export (ReportExporter.export). Validates both checks, stores the payload privately, enqueues the job. */
export async function requestExport(ctx: Ctx, input: ExportInput): Promise<ExportJob> {
  if (!input?.destination || !input.content) throw new AppError('validation_failed', 'Destination and content are required.');
  const title = String(input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!title) throw new AppError('validation_failed', 'Title is required', { title: 'Required' });
  if (!['html', 'markdown', 'csv', 'pdf', 'text'].includes(input.format)) throw new AppError('validation_failed', 'Unknown format', { format: 'Unknown format' });
  if (input.destination.kind === 'google_doc' && input.format === 'pdf') throw new AppError('validation_failed', 'A PDF cannot become a Google Doc; export it as a Drive file.');
  const { conn, parentTitle } = await checkDestination(ctx, input);
  checkContent(ctx, input);
  const p = payloadOf(input);
  if (p.bytes.length === 0 || p.bytes.length > LIMITS.exportUploadBytes) throw new AppError('payload_too_large', 'Exports must be between 1 byte and 5 MB.');
  const sha = createHash('sha256').update(p.bytes).digest('hex');
  const key = exportKey(ctx, input, sha);
  const existing = await maybeOne<ExportRow>(getPool(), `SELECT * FROM export_jobs WHERE workspace_id=$1 AND idempotency_key=$2`, [ctx.access.workspaceId, key]);
  if (existing) return exportJson(existing);
  const id = randomUUID();
  const objectKey = `content-exports/${ctx.access.workspaceId}/${id}`;
  if (config().APP_ENV !== 'production') await ensureBucket();
  await putObject(objectKey, p.bytes, p.mime, { 'export-id': id });
  const warning = sharingWarning(input.destination.kind, parentTitle, conn.account_label);
  const row = await withTx(async (tx) => {
    const r = await maybeOne<ExportRow>(tx,
      `INSERT INTO export_jobs(id, workspace_id, brand_id, connection_id, destination_kind, destination_parent_id, title, format, content_ref, content_key, content_sha256,
              content_bytes, idempotency_key, sharing_warning, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING *`,
      [id, ctx.access.workspaceId, input.content.brandId ?? null, conn.id, input.destination.kind, input.destination.parentId, title, input.format,
        JSON.stringify({ ...input.content, mime: p.mime, payload: p.kind }), objectKey, sha, p.bytes.length, key, warning, ctx.actor.userId]);
    if (!r) return null;
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'export', aggregateId: id, eventType: 'export.requested', payload: { exportId: id } });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: input.content.brandId ?? null, actorUserId: ctx.actor.userId, action: 'content_export.requested', resourceType: 'export_job',
      resourceId: id, diff: { kind: input.destination.kind, format: input.format, content: input.content.kind, bytes: p.bytes.length }, correlationId: ctx.correlationId });
    return r;
  });
  if (!row) {
    await deleteObject(objectKey).catch(() => undefined);
    return exportJson((await maybeOne<ExportRow>(getPool(), `SELECT * FROM export_jobs WHERE workspace_id=$1 AND idempotency_key=$2`, [ctx.access.workspaceId, key]))!);
  }
  return exportJson(row);
}

/** One exporter object per destination kind (all share the same job pipeline). */
export const contentHubExporter: ReportExporter<Ctx> = {
  kinds: ['google_doc', 'drive_file', 'notion_page'],
  export: (ctx, input) => requestExport(ctx, input),
};

export async function getExport(ctx: Ctx, id: string): Promise<ExportJob> {
  assertUuid(id, 'Export');
  const r = await maybeOne<ExportRow>(getPool(), `SELECT * FROM export_jobs WHERE id=$1 AND workspace_id=$2`, [id, ctx.access.workspaceId]);
  if (!r || (r.brand_id && !brandAllowed(ctx, r.brand_id)) || (r.requested_by !== ctx.actor.userId && !authorizeCtx(ctx, 'exports.create', { brandId: r.brand_id }).allowed)) throw notFound('Export');
  return exportJson(r);
}

export async function listExports(ctx: Ctx, brandId: string | null, limit = 30): Promise<ExportJob[]> {
  requireAction(ctx, 'exports.create', { brandId });
  const rows = await many<ExportRow>(getPool(), `SELECT * FROM export_jobs WHERE workspace_id=$1 AND brand_id IS NOT DISTINCT FROM $2 ORDER BY created_at DESC LIMIT $3`,
    [ctx.access.workspaceId, brandId, Math.min(limit, 100)]);
  return rows.map(exportJson);
}

// ------------------------------------------------------------------ worker
function notionBlocksFromText(text: string): unknown[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const blocks: unknown[] = [];
  for (const p of paras) {
    for (let i = 0; i < p.length; i += 2000) {
      blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: p.slice(i, i + 2000) } }] } });
    }
  }
  return blocks;
}

async function finishExport(id: string, status: 'completed' | 'failed', patch: { result?: unknown; code?: string; message?: string }) {
  await getPool().query(`UPDATE export_jobs SET status=$2, result=coalesce($3::jsonb, result), error_code=$4, error_message=$5, completed_at=now() WHERE id=$1`,
    [id, status, patch.result ? JSON.stringify(patch.result) : null, patch.code ?? null, patch.message?.slice(0, 500) ?? null]);
}

/** Worker ('report-export' queue): re-check BOTH destination and content permissions, then create the new document. */
export async function runExport(exportId: string): Promise<ExportJob | null> {
  const runId = randomUUID();
  const row = await maybeOne<ExportRow>(getPool(),
    `UPDATE export_jobs SET status='running', started_at=now(), attempts=attempts+1 WHERE id=$1 AND (status='queued' OR (status='running' AND started_at < now() - interval '15 minutes')) RETURNING *`, [exportId]);
  if (!row) return null;
  try {
    const ctx = await jobCtx(row.requested_by, row.workspace_id, runId);
    if (!ctx) throw new AppError('forbidden', 'The person who requested this export no longer has access.');
    const input = { destination: { kind: row.destination_kind, connectionId: row.connection_id, parentId: row.destination_parent_id }, content: row.content_ref };
    const { conn } = await checkDestination(ctx, input);
    checkContent(ctx, input);
    const bytes = await getObjectBytes(row.content_key!, LIMITS.exportUploadBytes + 1024);
    const result = await withSource(conn, async (s) => {
      if (row.destination_kind === 'google_doc') {
        const html = row.content_ref.payload === 'html' ? bytes : Buffer.from(textToHtml(row.title, bytes.toString('utf8')), 'utf8');
        const f = await createFile(s.google!, { name: row.title, targetMimeType: MIME.doc, parentId: row.destination_parent_id, content: html, contentType: 'text/html' });
        return { url: f.webViewLink ?? null, external_id: f.id };
      }
      if (row.destination_kind === 'drive_file') {
        const ext = { html: '.html', markdown: '.md', csv: '.csv', pdf: '.pdf', text: '.txt' }[row.format];
        const name = row.title.toLowerCase().endsWith(ext) ? row.title : `${row.title}${ext}`;
        const f = await createFile(s.google!, { name, parentId: row.destination_parent_id, content: bytes, contentType: row.content_ref.mime ?? 'application/octet-stream' });
        return { url: f.webViewLink ?? null, external_id: f.id };
      }
      const text = row.content_ref.payload === 'html' ? htmlToText(bytes.toString('utf8')) : row.content_ref.payload === 'text' ? bytes.toString('utf8') : '';
      if (row.content_ref.payload === 'bytes') throw new AppError('validation_failed', 'Binary files cannot be exported to Notion; use HTML or text.');
      const blocks = notionBlocksFromText(text);
      const page = await createChildPage(s.notion!, { parentPageId: row.destination_parent_id!, title: row.title, children: blocks.slice(0, 100) });
      for (let i = 100; i < blocks.length && i < 1000; i += 100) await appendChildren(s.notion!, page.id, blocks.slice(i, i + 100));
      return { url: page.url ?? null, external_id: page.id };
    });
    await finishExport(row.id, 'completed', { result });
    await audit(getPool(), { workspaceId: row.workspace_id, brandId: row.brand_id, actorUserId: row.requested_by, action: 'content_export.completed', resourceType: 'export_job',
      resourceId: row.id, diff: { kind: row.destination_kind, external_id: result.external_id } });
  } catch (err) {
    if (err instanceof SourceAccessError && err.retryable && row.attempts < 5) {
      await getPool().query(`UPDATE export_jobs SET status='queued' WHERE id=$1`, [row.id]);
      throw new RetryLaterError(err.message, err.retryAfterSeconds ?? 30);
    }
    const app = err instanceof AppError ? err : err instanceof SourceAccessError
      ? new AppError(err.kind === 'forbidden' ? 'forbidden' : err.kind === 'not_found' ? 'not_found' : 'provider_error',
        err.kind === 'forbidden' ? 'The destination does not allow Relay to create files there.' : err.kind === 'not_found' ? 'The destination no longer exists or is not shared with Relay.' : 'The destination is unavailable.')
      : new AppError('internal', 'Export failed');
    log.warn('content_export_failed', { exportId: row.id, code: app.code, err: { name: (err as Error).name, message: (err as Error).message } });
    await finishExport(row.id, 'failed', { code: app.code, message: app.message });
  }
  return exportJson((await maybeOne<ExportRow>(getPool(), `SELECT * FROM export_jobs WHERE id=$1`, [row.id]))!);
}

// ------------------------------------------------------------------ content plan export (CH-owned content)
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Build a content plan (posts of a brand / campaign) as HTML and export it to the selected destination. */
export async function exportContentPlan(ctx: Ctx, input: { brand_id: string; campaign_id?: string | null; destination: ExportInput['destination']; title?: string; idempotency_key?: string }): Promise<ExportJob> {
  requireAction(ctx, 'content.read', { brandId: input.brand_id });
  const brand = await assertBrand(ctx, input.brand_id);
  const posts = await many<{ title: string | null; text: string; due_at: Date | null; campaign: string | null; status: string }>(getPool(),
    `SELECT p.title, p.draft->>'baseText' AS text, coalesce((SELECT min(s.due_at) FROM schedules s WHERE s.post_id=p.id AND s.status='active'), p.due_at) AS due_at,
            c.name AS campaign, CASE WHEN EXISTS (SELECT 1 FROM schedules s WHERE s.post_id=p.id AND s.status='active') THEN 'Scheduled'
                                     WHEN EXISTS (SELECT 1 FROM schedules s WHERE s.post_id=p.id AND s.status='pending_approval') THEN 'In review' ELSE 'Draft' END AS status
       FROM posts p LEFT JOIN campaigns c ON c.id=p.campaign_id
      WHERE p.workspace_id=$1 AND p.brand_id=$2 AND p.archived_at IS NULL AND ($3::uuid IS NULL OR p.campaign_id=$3)
      ORDER BY due_at NULLS LAST, p.updated_at DESC LIMIT 200`, [ctx.access.workspaceId, brand.id, input.campaign_id ?? null]);
  const title = input.title?.trim() || `${brand.name} content plan`;
  const rows = posts.map((p) => `<h2>${esc(p.title || 'Untitled post')}</h2><p><b>${esc(p.status)}</b>${p.due_at ? ` · ${esc(p.due_at.toISOString().slice(0, 16).replace('T', ' '))} UTC` : ''}${p.campaign ? ` · ${esc(p.campaign)}` : ''}</p><p>${esc(p.text ?? '').replace(/\n/g, '<br>')}</p>`).join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${rows || '<p>No posts.</p>'}</body></html>`;
  return requestExport(ctx, { destination: input.destination, title, format: 'html', html, content: { kind: 'content_plan', brandId: brand.id, permission: 'content.read', ref: input.campaign_id ?? null }, idempotencyKey: input.idempotency_key });
}
