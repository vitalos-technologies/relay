// Relay support (V4 SUP) — private attachments.
//  1. intent: allow-listed type + size (≤ 10 MB), rate-limited per person → row 'pending' + presigned POST limited to the
//     exact key, content type and size range (private bucket; key never derived from user input).
//  2. the browser uploads straight to storage; the object stays QUARANTINED ('pending') and cannot be attached or opened.
//  3. complete: the server re-reads the bytes, checks size, type allow-list and magic-byte signature (text must be UTF-8
//     without NUL bytes) and marks the row 'ready' or 'rejected' (rejected objects are deleted).
//  4. only 'ready' files owned by the caller can be attached to a message/note; opening re-checks authorization on every
//     request and streams the bytes with nosniff + attachment disposition (images inline) — no long-lived public link.
// No malware scanner is configured in this installation: validation is the quarantine gate (documented gap).
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import {
  SUPPORT_ATTACHMENT_MAX_BYTES, SUPPORT_ATTACHMENT_TYPES, SUPPORT_ATTACHMENTS_PER_MESSAGE, type SupportAttachmentDto, type SupportUploadIntent,
} from '@social-lite/core/contracts/v4-support';
import { getPool, many, maybeOne, one, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { enforceRateLimit } from '../ratelimit.js';
import { deleteObject, ensureBucket, getObjectBytes, ObjectTooLargeError, presignUpload } from '../storage.js';
import { assertUuid } from '../tenancy.js';
import type { PlatformCtx } from '../admin/platform.js';
import { loadVisibleTicket, requireSupportStaff } from './access.js';
import { log } from '../log.js';

export const ATTACH_RATE = { capacity: 20, refillPerSecond: 20 / 600 }; // per person: 20 burst, 20 per 10 min

const intentSchema = z.object({
  filename: z.string().trim().min(1).max(160),
  content_type: z.enum(SUPPORT_ATTACHMENT_TYPES, { message: 'Attach an image (PNG, JPEG, GIF, WebP), a PDF or a text file' }),
  size: z.number().int().min(1).max(SUPPORT_ATTACHMENT_MAX_BYTES, 'Files can be up to 10 MB'),
}).strict();

const safeFilename = (n: string) => n.normalize('NFKC').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 160) || 'file';

interface Row { id: string; filename: string; mime: string | null; size: string | null; state: SupportAttachmentDto['state']; error: string | null; declared_type: string }

/** Download routes: customer, staff, and (V5 WID) the marketing support widget. */
export type AttachmentUrlBase = '/api/support/attachments' | '/api/platform/support/attachments' | '/api/widget/attachments';

export function attachmentDto(r: Row, urlBase: AttachmentUrlBase): SupportAttachmentDto {
  return { id: r.id, filename: r.filename, mime: r.mime ?? r.declared_type, size: r.size === null ? null : Number(r.size), state: r.state, error: r.error,
    url: r.state === 'ready' ? `${urlBase}/${r.id}` : null };
}

// V5 WID: anonymous widget visitors own uploads through their visitor identity (support_attachments.visitor_id).
export type AttachmentOwner = { kind: 'member'; userId: string; workspaceId: string } | { kind: 'staff'; userId: string } | { kind: 'visitor'; visitorId: string };
type Owner = AttachmentOwner;
const ownerUser = (o: Owner): string | null => (o.kind === 'visitor' ? null : o.userId);
const ownerVisitor = (o: Owner): string | null => (o.kind === 'visitor' ? o.visitorId : null);
const ownerWorkspace = (o: Owner): string | null => (o.kind === 'member' ? o.workspaceId : null);

async function createIntent(owner: Owner, raw: unknown, urlBase: AttachmentUrlBase): Promise<SupportUploadIntent> {
  const input = intentSchema.parse(raw);
  await enforceRateLimit('supportAttach', owner.kind === 'visitor' ? `visitor:${owner.visitorId}` : owner.userId, ATTACH_RATE);
  await ensureBucket();
  const id = randomUUID();
  const key = `support/${id}`;
  const r = await one<Row>(getPool(),
    `INSERT INTO support_attachments(id, owner_kind, owner_user_id, workspace_id, filename, declared_type, declared_size, storage_key, visitor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, filename, mime, size::text, state, error, declared_type`,
    [id, owner.kind, ownerUser(owner), ownerWorkspace(owner), safeFilename(input.filename), input.content_type, input.size, key, ownerVisitor(owner)]);
  const post = await presignUpload({ key, contentType: input.content_type, maxBytes: Math.min(input.size, SUPPORT_ATTACHMENT_MAX_BYTES), minBytes: 1, expiresSeconds: 600 });
  return { attachment: attachmentDto(r, urlBase), upload: { url: post.url, method: 'POST', fields: post.fields } };
}

export const customerUploadIntent = (ctx: Ctx, raw: unknown) =>
  createIntent({ kind: 'member', userId: ctx.actor.userId, workspaceId: ctx.access.workspaceId }, raw, '/api/support/attachments');
export const staffUploadIntent = (p: PlatformCtx, raw: unknown) => { requireSupportStaff(p); return createIntent({ kind: 'staff', userId: p.actor.userId }, raw, '/api/platform/support/attachments'); };
/** V5 WID: upload intent for a widget visitor (identity from the widget session only). */
export const visitorUploadIntent = (visitorId: string, raw: unknown) => createIntent({ kind: 'visitor', visitorId }, raw, '/api/widget/attachments');

/** Magic-byte / encoding check for the allow-listed types. */
export function sniffMatches(mime: string, b: Buffer): boolean {
  switch (mime) {
    case 'image/png': return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg': return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/gif': return ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1'));
    case 'image/webp': return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'application/pdf': return b.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'text/plain': {
      if (b.includes(0)) return false;
      try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch { return false; }
    }
    default: return false;
  }
}

/** Validate an uploaded object (owner only). Idempotent: a validated row is returned as is. */
async function complete(owner: Owner, id: string, urlBase: AttachmentUrlBase, db: Queryable = getPool()): Promise<SupportAttachmentDto> {
  assertUuid(id, 'Attachment');
  const a = await maybeOne<Row & { storage_key: string; declared_size: string; owner_user_id: string | null; workspace_id: string | null }>(db,
    `SELECT id, filename, mime, size::text, state, error, declared_type, storage_key, declared_size::text, owner_user_id, workspace_id FROM support_attachments
      WHERE id=$1 AND owner_user_id IS NOT DISTINCT FROM $2::uuid AND owner_kind=$3 AND ($4::uuid IS NULL OR workspace_id=$4) AND visitor_id IS NOT DISTINCT FROM $5::uuid`,
    [id, ownerUser(owner), owner.kind, ownerWorkspace(owner), ownerVisitor(owner)]);
  if (!a) throw notFound('Attachment');
  if (a.state !== 'pending') return attachmentDto(a, urlBase);
  const reject = async (error: string) => {
    await deleteObject(a.storage_key).catch(() => undefined);
    const r = await one<Row>(db, `UPDATE support_attachments SET state='rejected', error=$2, validated_at=now() WHERE id=$1 RETURNING id, filename, mime, size::text, state, error, declared_type`, [id, error]);
    return attachmentDto(r, urlBase);
  };
  let bytes: Buffer;
  try {
    bytes = await getObjectBytes(a.storage_key, SUPPORT_ATTACHMENT_MAX_BYTES);
  } catch (err) {
    if (err instanceof ObjectTooLargeError) return reject('Files can be up to 10 MB.');
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (err as Error).name === 'NoSuchKey') throw new AppError('invalid_state', 'The upload has not arrived yet. Try again.');
    throw err;
  }
  if (!bytes.length) return reject('The file is empty.');
  if (!sniffMatches(a.declared_type, bytes)) return reject('The file’s contents don’t match its type.');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const r = await one<Row>(db,
    `UPDATE support_attachments SET state='ready', mime=declared_type, size=$2, sha256=$3, validated_at=now(), error=NULL WHERE id=$1 AND state='pending'
     RETURNING id, filename, mime, size::text, state, error, declared_type`, [id, bytes.length, sha]);
  return attachmentDto(r, urlBase);
}

export const completeCustomerUpload = (ctx: Ctx, id: string) => complete({ kind: 'member', userId: ctx.actor.userId, workspaceId: ctx.access.workspaceId }, id, '/api/support/attachments');
export const completeStaffUpload = (p: PlatformCtx, id: string) => { requireSupportStaff(p); return complete({ kind: 'staff', userId: p.actor.userId }, id, '/api/platform/support/attachments'); };
export const completeVisitorUpload = (visitorId: string, id: string) => complete({ kind: 'visitor', visitorId }, id, '/api/widget/attachments');

/**
 * Bind ready, unattached files owned by the author to a new message or note (same transaction as the message).
 * Anything else (someone else's file, pending/rejected, already attached, other workspace) fails the whole request.
 */
export async function bindAttachments(db: Queryable, p: { ids: string[]; owner: Owner; ticketId: string; messageId?: string | null; noteId?: string | null }): Promise<void> {
  const ids = [...new Set(p.ids)];
  if (!ids.length) return;
  if (ids.length > SUPPORT_ATTACHMENTS_PER_MESSAGE) throw new AppError('validation_failed', `Attach up to ${SUPPORT_ATTACHMENTS_PER_MESSAGE} files`, { attachment_ids: 'Too many files' });
  for (const id of ids) assertUuid(id, 'Attachment');
  const r = await db.query(
    `UPDATE support_attachments SET ticket_id=$1, message_id=$2, note_id=$3, attached_at=now()
      WHERE id = ANY($4::uuid[]) AND owner_user_id IS NOT DISTINCT FROM $5::uuid AND owner_kind=$6 AND state='ready' AND ticket_id IS NULL AND ($7::uuid IS NULL OR workspace_id=$7)
        AND visitor_id IS NOT DISTINCT FROM $8::uuid`,
    [p.ticketId, p.messageId ?? null, p.noteId ?? null, ids, ownerUser(p.owner), p.owner.kind, ownerWorkspace(p.owner), ownerVisitor(p.owner)]);
  if (r.rowCount !== ids.length) throw new AppError('validation_failed', 'One of the files is not ready or not yours. Upload it again.', { attachment_ids: 'Not available' });
}

export async function attachmentsFor(db: Queryable, col: 'message_id' | 'note_id', ids: string[], urlBase: AttachmentUrlBase): Promise<Map<string, SupportAttachmentDto[]>> {
  const out = new Map<string, SupportAttachmentDto[]>();
  if (!ids.length) return out;
  const rows = await many<Row & { parent: string }>(db,
    `SELECT id, filename, mime, size::text, state, error, declared_type, ${col} AS parent FROM support_attachments WHERE ${col} = ANY($1::uuid[]) AND state='ready' ORDER BY created_at, id`, [ids]);
  for (const r of rows) out.set(r.parent, [...(out.get(r.parent) ?? []), attachmentDto(r, urlBase)]);
  return out;
}

export interface OpenedFile { bytes: Buffer; mime: string; filename: string; inline: boolean }

export async function readReady(a: { storage_key: string; mime: string | null; filename: string }): Promise<OpenedFile> {
  const mime = a.mime ?? 'application/octet-stream';
  return { bytes: await getObjectBytes(a.storage_key, SUPPORT_ATTACHMENT_MAX_BYTES), mime, filename: a.filename, inline: mime.startsWith('image/') };
}

/**
 * Customer download: files on customer-visible MESSAGES of a ticket the caller can see, or the caller's own unattached
 * upload. Files on internal notes are never served here.
 */
export async function openCustomerAttachment(ctx: Ctx, id: string, db: Queryable = getPool()): Promise<OpenedFile> {
  assertUuid(id, 'Attachment');
  const a = await maybeOne<{ ticket_id: string | null; message_id: string | null; note_id: string | null; owner_user_id: string | null; workspace_id: string | null; storage_key: string; mime: string | null; filename: string; state: string }>(db,
    `SELECT ticket_id, message_id, note_id, owner_user_id, workspace_id, storage_key, mime, filename, state FROM support_attachments WHERE id=$1`, [id]);
  if (!a || a.state !== 'ready' || a.note_id) throw notFound('Attachment');
  if (!a.ticket_id) {
    if (a.owner_user_id !== ctx.actor.userId || a.workspace_id !== ctx.access.workspaceId) throw notFound('Attachment');
  } else {
    if (!a.message_id) throw notFound('Attachment');
    await loadVisibleTicket(ctx, a.ticket_id, db); // not_found when not visible
  }
  return readReady(a);
}

/** Staff download (support staff only): any validated support file, including internal-note files. */
export async function openStaffAttachment(p: PlatformCtx, id: string, db: Queryable = getPool()): Promise<OpenedFile> {
  requireSupportStaff(p);
  assertUuid(id, 'Attachment');
  const a = await maybeOne<{ ticket_id: string | null; owner_user_id: string | null; storage_key: string; mime: string | null; filename: string; state: string }>(db,
    `SELECT ticket_id, owner_user_id, storage_key, mime, filename, state FROM support_attachments WHERE id=$1`, [id]);
  if (!a || a.state !== 'ready' || (!a.ticket_id && a.owner_user_id !== p.actor.userId)) throw notFound('Attachment');
  return readReady(a);
}

/** Worker: drop uploads never attached within an hour (pending or ready) and their objects. */
export async function sweepStaleUploads(db: Queryable = getPool(), limit = 200): Promise<number> {
  const rows = await many<{ id: string; storage_key: string }>(db,
    `SELECT id, storage_key FROM support_attachments WHERE ticket_id IS NULL AND state IN ('pending','ready') AND created_at < now() - interval '1 hour' ORDER BY created_at LIMIT $1`, [limit]);
  for (const r of rows) {
    await deleteObject(r.storage_key).catch((err) => log.warn('support_attachment_delete_failed', { err: err as Error }));
    await db.query(`UPDATE support_attachments SET state='deleted' WHERE id=$1`, [r.id]);
  }
  return rows.length;
}
