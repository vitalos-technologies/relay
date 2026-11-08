// Composer attachments (V5 §11 "Attach files"): small text documents (plain text, Markdown, CSV, JSON) a person adds
// as a source for one of their tasks. Private to that person and brand, treated as UNTRUSTED content (quoted as data,
// never instructions), text purged after 30 days. Larger or binary documents belong in the Content library.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES } from '@social-lite/core/contracts/v5-ai';
import { getPool, many, maybeOne, one } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { enforceRateLimit } from '../ratelimit.js';
import { assertBrand, assertUuid, requireAction } from '../tenancy.js';
import { cleanText } from '../content-hub/normalize.js';

export const attachmentSchema = z.object({
  brand_id: z.string().uuid(),
  filename: z.string().trim().min(1).max(200),
  mime: z.string().max(100),
  text: z.string().max(ATTACHMENT_MAX_BYTES),
}).strict();

export interface AttachmentDto { id: string; brand_id: string; filename: string; mime: string; bytes: number; created_at: string; available: boolean }

const EXT: Record<string, (typeof ATTACHMENT_TYPES)[number]> = { txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', json: 'application/json' };

export async function addAttachment(ctx: Ctx, raw: unknown): Promise<AttachmentDto> {
  const a = attachmentSchema.parse(raw);
  await assertBrand(ctx, a.brand_id);
  requireAction(ctx, 'ai.use', { brandId: a.brand_id });
  await enforceRateLimit('assistantAttachment', ctx.actor.userId, { capacity: 20, refillPerSecond: 20 / 600 });
  const ext = a.filename.toLowerCase().split('.').pop() ?? '';
  const mime = (ATTACHMENT_TYPES as readonly string[]).includes(a.mime) ? a.mime : EXT[ext];
  if (!mime) throw new AppError('validation_failed', 'Attach a text, Markdown, CSV or JSON file. Link other documents in the Content library.', { file: 'Unsupported type' });
  const bytes = Buffer.byteLength(a.text, 'utf8');
  if (!bytes) throw new AppError('validation_failed', 'This file is empty.', { file: 'Empty' });
  if (bytes > ATTACHMENT_MAX_BYTES) throw new AppError('validation_failed', 'Files can be up to 256 KB.', { file: 'Too large' });
  if (a.text.includes('\u0000')) throw new AppError('validation_failed', 'This does not look like a text file.', { file: 'Binary content' });
  const text = cleanText(a.text.normalize('NFC'));
  const row = await one<{ id: string; created_at: Date }>(getPool(),
    `INSERT INTO ai_attachments(workspace_id, user_id, brand_id, filename, mime, bytes, sha256, text_content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [ctx.access.workspaceId, ctx.actor.userId, a.brand_id, a.filename.replace(/[\\/]/g, '_'), mime, bytes, createHash('sha256').update(text).digest('hex'), text]);
  await audit(getPool(), { workspaceId: ctx.access.workspaceId, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: 'ai.attachment_added', resourceType: 'ai_attachment', resourceId: row.id,
    diff: { bytes, mime }, correlationId: ctx.correlationId });
  return { id: row.id, brand_id: a.brand_id, filename: a.filename, mime, bytes, created_at: row.created_at.toISOString(), available: true };
}

export async function listAttachments(ctx: Ctx, q: { brand_id?: string | null } = {}): Promise<{ items: AttachmentDto[] }> {
  if (q.brand_id) assertUuid(q.brand_id, 'Brand');
  const rows = await many<{ id: string; brand_id: string; filename: string; mime: string; bytes: number; created_at: Date; text_content: string | null }>(getPool(),
    `SELECT id, brand_id, filename, mime, bytes, created_at, (text_content IS NOT NULL)::text AS text_content FROM ai_attachments
      WHERE workspace_id=$1 AND user_id=$2 ${q.brand_id ? 'AND brand_id=$3' : ''} ORDER BY created_at DESC LIMIT 20`,
    q.brand_id ? [ctx.access.workspaceId, ctx.actor.userId, q.brand_id] : [ctx.access.workspaceId, ctx.actor.userId]);
  return { items: rows.map((r) => ({ id: r.id, brand_id: r.brand_id, filename: r.filename, mime: r.mime, bytes: r.bytes, created_at: r.created_at.toISOString(), available: r.text_content === 'true' })) };
}

export async function removeAttachment(ctx: Ctx, id: string): Promise<{ removed: true }> {
  assertUuid(id, 'Attachment');
  const r = await maybeOne<{ id: string }>(getPool(), `DELETE FROM ai_attachments WHERE id=$1 AND workspace_id=$2 AND user_id=$3 RETURNING id`, [id, ctx.access.workspaceId, ctx.actor.userId]);
  if (!r) throw notFound('Attachment');
  return { removed: true };
}
