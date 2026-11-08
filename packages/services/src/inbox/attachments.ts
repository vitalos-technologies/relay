// V3.5 stream B — inbound attachments (brief §13 "safely process attachments"). Ingestion stores METADATA only; nothing
// is downloaded automatically. When a person with inbox.read opens an attachment, Relay:
//  1. asks the provider adapter where the bytes are (short-lived provider link or file reference);
//  2. downloads with the SSRF-safe fetcher: https only, only the provider's media hosts, public IPs, ≤ 20 MB, ≤ 30 s;
//  3. accepts only allow-listed types (images, PDF, audio, video, plain text) and checks image/PDF signatures;
//  4. stores the bytes privately (object storage, per workspace) and serves them through this authorized route as a
//     download (Content-Disposition: attachment, nosniff) — authorization is re-checked on every request.
// Files of messages deleted at the provider are deleted by the worker retention loop.
import { createHash } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import { getPool, maybeOne } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { safeFetch, SsrfBlockedError } from '../ssrf.js';
import { getObjectBytes, putObject } from '../storage.js';
import { ChannelUnavailableError, channelRuntime } from './channels-runtime.js';
import { loadChannelRow, loadConversation } from './shared.js';

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = /^(image\/(png|jpeg|gif|webp)|application\/pdf|audio\/(mpeg|ogg|aac|mp4|amr)|video\/(mp4|3gpp)|text\/plain)$/;

function sniff(mime: string, b: Buffer): boolean {
  if (mime === 'image/png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8;
  if (mime === 'image/gif') return b.subarray(0, 4).toString('latin1') === 'GIF8';
  if (mime === 'application/pdf') return b.subarray(0, 5).toString('latin1') === '%PDF-';
  return true;
}

const safeName = (n: string | null, idx: number, mime: string) => (n ?? `attachment-${idx + 1}.${mime.split('/')[1]?.split(';')[0] ?? 'bin'}`).replace(/[^\w.-]+/g, '_').slice(0, 120);

export interface AttachmentFile { bytes: Buffer; mime: string; filename: string }

export async function openAttachment(ctx: Ctx, messageId: string, idx: number): Promise<AttachmentFile> {
  if (!/^[0-9a-f-]{36}$/i.test(messageId) || !Number.isInteger(idx) || idx < 0 || idx > 9) throw notFound('Attachment');
  const m = await maybeOne<{ id: string; workspace_id: string; conversation_id: string; channel_id: string; deleted_at: Date | null; attachments: Array<{ type: string; name: string | null; providerRef?: string | null }> }>(getPool(),
    `SELECT id, workspace_id, conversation_id, channel_id, deleted_at, attachments FROM inbox_messages WHERE id=$1 AND workspace_id=$2`, [messageId, ctx.access.workspaceId]);
  if (!m) throw notFound('Attachment');
  const conv = await loadConversation(ctx, m.conversation_id, 'inbox.read');
  if (m.deleted_at) throw new AppError('invalid_state', 'The sender deleted this message.');
  const meta = m.attachments[idx];
  if (!meta) throw notFound('Attachment');
  const stored = await maybeOne<{ state: string; storage_key: string | null; mime: string | null; error_message: string | null }>(getPool(), `SELECT state, storage_key, mime, error_message FROM inbox_attachments WHERE message_id=$1 AND idx=$2`, [m.id, idx]);
  if (stored?.state === 'stored' && stored.storage_key && stored.mime) return { bytes: await getObjectBytes(stored.storage_key, ATTACHMENT_MAX_BYTES), mime: stored.mime, filename: safeName(meta.name, idx, stored.mime) };
  if (stored?.state === 'blocked') throw new AppError('invalid_state', stored.error_message ?? 'This file type is not allowed.');

  const record = async (state: 'stored' | 'failed' | 'blocked', f: { mime?: string | null; size?: number; sha?: string; key?: string; code?: string; message?: string }) => {
    await getPool().query(
      `INSERT INTO inbox_attachments(workspace_id, message_id, idx, state, mime, size, sha256, storage_key, error_code, error_message, fetched_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (message_id, idx) DO UPDATE SET state=EXCLUDED.state, mime=EXCLUDED.mime, size=EXCLUDED.size, sha256=EXCLUDED.sha256, storage_key=EXCLUDED.storage_key,
         error_code=EXCLUDED.error_code, error_message=EXCLUDED.error_message, fetched_by=EXCLUDED.fetched_by, fetched_at=now()`,
      [m.workspace_id, m.id, idx, state, f.mime ?? null, f.size ?? null, f.sha ?? null, f.key ?? null, f.code ?? null, f.message ?? null, ctx.actor.userId]);
  };
  if (!meta.providerRef) throw new AppError('invalid_state', 'The network does not provide this file to apps.');
  const ch = await loadChannelRow(getPool(), m.channel_id);
  if (!ch) throw notFound('Attachment');
  let rt;
  try { rt = await channelRuntime(ch); } catch (err) { if (err instanceof ChannelUnavailableError) throw new AppError('invalid_state', err.message); throw err; }
  if (!rt.adapter.resolveAttachment) throw new AppError('invalid_state', 'Files cannot be downloaded from this network.');
  const src = await rt.adapter.resolveAttachment(rt.ctx, rt.creds, rt.conn, { providerRef: meta.providerRef, type: meta.type });
  let bytes: Buffer;
  let mime: string;
  if (src.kind === 'error') { await record('failed', { code: src.code, message: src.message }); throw new AppError('provider_error', src.message); }
  if (src.kind === 'bytes') {
    if (!rt.simulated) throw new AppError('provider_error', 'Unexpected inline file from a live network.');
    bytes = Buffer.from(src.base64, 'base64');
    mime = src.mime === 'application/octet-stream' ? 'text/plain' : src.mime;
  } else {
    try {
      const r = await safeFetch(src.url, { maxBytes: ATTACHMENT_MAX_BYTES, timeoutMs: 30_000, allowHosts: src.allowHosts, headers: src.headers, maxRedirects: 2 });
      if (r.status !== 200) { await record('failed', { code: `http_${r.status}`, message: 'The network no longer provides this file.' }); throw new AppError('provider_error', 'The network no longer provides this file (links expire).'); }
      bytes = r.body;
      mime = (src.mime ?? r.contentType ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
    } catch (err) {
      if (err instanceof SsrfBlockedError) { await record('blocked', { code: 'blocked_host', message: 'The file is hosted somewhere Relay does not download from.' }); throw new AppError('invalid_state', 'The file is hosted somewhere Relay does not download from.'); }
      throw err;
    }
  }
  if (bytes.byteLength > ATTACHMENT_MAX_BYTES) { await record('blocked', { code: 'too_large', message: 'Files over 20 MB are not downloaded.' }); throw new AppError('invalid_state', 'Files over 20 MB are not downloaded.'); }
  if (!ALLOWED.test(mime) || !sniff(mime, bytes)) { await record('blocked', { mime, size: bytes.byteLength, code: 'type_not_allowed', message: 'This file type is not allowed.' }); throw new AppError('invalid_state', 'This file type is not allowed.'); }
  const sha = createHash('sha256').update(bytes).digest('hex');
  const key = `inbox/${m.workspace_id}/${m.id}/${idx}`;
  await putObject(key, bytes, mime);
  await record('stored', { mime, size: bytes.byteLength, sha, key });
  await audit(getPool(), { workspaceId: m.workspace_id, brandId: conv.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.attachment_fetched', resourceType: 'inbox_message', resourceId: m.id, diff: { idx, size: bytes.byteLength, mime }, correlationId: ctx.correlationId });
  return { bytes, mime, filename: safeName(meta.name, idx, mime) };
}
