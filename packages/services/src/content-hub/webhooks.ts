// Optional change notifications (manual refresh remains the primary, required path):
//  - Google Drive changes.watch channels: authenticated by a per-channel random token (only its hash is stored) and
//    correlated by channel id; deduplicated by message number; renewed before expiry (Drive has no auto-renewal);
//    a notification carries NO content — it only triggers a bounded, authorized changes.list.
//  - Notion webhooks: X-Notion-Signature = "sha256=" + HMAC-SHA256(verification_token, raw body), constant-time
//    compared; deduplicated by event id; events are signals only (fetch current state through the API).
// Signals only mark linked items as changed ("change detected"); they never import, publish or approve anything.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from '@social-lite/core';
import { getPool, many, maybeOne } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { decryptSecret, encryptSecret, settingAad } from '../crypto.js';
import { log } from '../log.js';
import { writeOutbox } from '../outbox.js';
import { setSetting } from '../settings.js';
import { requireAction } from '../tenancy.js';
import { loadContentConnection, withSource, type ContentConnectionRow } from './connections.js';
import { LIMITS, notionConfig } from './config.js';
import { getStartPageToken, listChanges, stopChannel, watchChanges } from './google.js';
import { normalizeNotionId } from './notion.js';
import { isOwnEcho } from './writeback.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const CHANNEL_TTL_MS = 6 * 24 * 3600_000;        // changes.watch allows up to one week
const RENEW_BEFORE_MS = 24 * 3600_000;

export function driveWebhookAddress(): string {
  return `${config().APP_BASE_URL.replace(/\/$/, '')}/api/webhooks/google-drive`;
}

// ------------------------------------------------------------------ Drive watch registration
async function registerChannel(conn: ContentConnectionRow, pageToken: string): Promise<void> {
  const channelId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const exp = Date.now() + CHANNEL_TTL_MS;
  const res = await withSource(conn, (s) => watchChanges(s.google!, { pageToken, channelId, address: driveWebhookAddress(), token, expirationMs: exp }));
  await getPool().query(
    `INSERT INTO sync_checkpoints(workspace_id, connection_id, scope, cursor, channel_id, channel_resource_id, channel_token_hash, channel_expires_at)
     VALUES ($1,$2,'drive_changes',$3,$4,$5,$6,$7)
     ON CONFLICT (connection_id, scope) DO UPDATE SET cursor=coalesce(sync_checkpoints.cursor, EXCLUDED.cursor), channel_id=EXCLUDED.channel_id,
       channel_resource_id=EXCLUDED.channel_resource_id, channel_token_hash=EXCLUDED.channel_token_hash, channel_expires_at=EXCLUDED.channel_expires_at,
       last_message_number=NULL, stopped_at=NULL, updated_at=now()`,
    [conn.workspace_id, conn.id, pageToken, channelId, res.resourceId, sha256(token), new Date(res.expiration ? Number(res.expiration) : exp)]);
}

/** Turn on Drive change notifications for a connection (owner/admin action). */
export async function enableDriveWatch(ctx: Ctx, connectionId: string): Promise<{ enabled: true; expires_at: string }> {
  const conn = await loadContentConnection(ctx, connectionId);
  requireAction(ctx, 'connections.manage', { brandId: conn.brand_id });
  if (conn.source !== 'google' || conn.status !== 'active') throw new AppError('invalid_state', 'Only active Google connections can watch for changes.');
  if (config().APP_ENV === 'production' && !config().APP_BASE_URL.startsWith('https://')) throw new AppError('invalid_state', 'Change notifications need an https:// address.');
  const token = await withSource(conn, (s) => getStartPageToken(s.google!));
  await registerChannel(conn, token);
  await audit(getPool(), { workspaceId: conn.workspace_id, brandId: conn.brand_id, actorUserId: ctx.actor.userId, action: 'content_connection.watch_enabled', resourceType: 'content_connection', resourceId: conn.id, correlationId: ctx.correlationId });
  const cp = await maybeOne<{ channel_expires_at: Date }>(getPool(), `SELECT channel_expires_at FROM sync_checkpoints WHERE connection_id=$1 AND scope='drive_changes'`, [conn.id]);
  return { enabled: true, expires_at: cp!.channel_expires_at.toISOString() };
}

/** Worker sweep: renew channels that expire within a day (new channel id; the old one is stopped). */
export async function renewDriveChannels(limit = 50): Promise<number> {
  const rows = await many<ContentConnectionRow & { cp_channel_id: string; cp_resource_id: string; cp_cursor: string | null }>(getPool(),
    `SELECT c.*, cp.channel_id AS cp_channel_id, cp.channel_resource_id AS cp_resource_id, cp.cursor AS cp_cursor
       FROM sync_checkpoints cp JOIN content_connections c ON c.id=cp.connection_id
      WHERE cp.scope='drive_changes' AND cp.stopped_at IS NULL AND cp.channel_id IS NOT NULL AND cp.channel_expires_at < now() + make_interval(secs => $1)
        AND c.status='active' AND c.disconnected_at IS NULL LIMIT $2`, [RENEW_BEFORE_MS / 1000, limit]);
  let n = 0;
  for (const r of rows) {
    try {
      await registerChannel(r, r.cp_cursor ?? await withSource(r, (s) => getStartPageToken(s.google!)));
      await withSource(r, (s) => stopChannel(s.google!, r.cp_channel_id, r.cp_resource_id)).catch(() => undefined);
      n++;
    } catch (err) {
      log.warn('drive_channel_renew_failed', { connectionId: r.id, err: { name: (err as Error).name } });
      await getPool().query(`UPDATE sync_checkpoints SET last_error=$2, updated_at=now() WHERE connection_id=$1 AND scope='drive_changes'`, [r.id, 'renewal failed']);
    }
  }
  return n;
}

// ------------------------------------------------------------------ Drive notification receiver
export type DriveNotificationResult = 'accepted' | 'duplicate' | 'sync' | 'unknown_channel' | 'bad_token' | 'stopped';

/** Verify + dedupe a Drive notification (headers only; the body is empty by design). */
export async function handleDriveNotification(h: { channelId: string | null; token: string | null; resourceState: string | null; messageNumber: string | null; resourceId: string | null }): Promise<DriveNotificationResult> {
  if (!h.channelId || h.channelId.length > 64) return 'unknown_channel';
  const cp = await maybeOne<{ id: string; workspace_id: string; connection_id: string; channel_token_hash: Buffer; channel_resource_id: string; stopped_at: Date | null }>(getPool(),
    `SELECT id, workspace_id, connection_id, channel_token_hash, channel_resource_id, stopped_at FROM sync_checkpoints WHERE channel_id=$1`, [h.channelId]);
  if (!cp) return 'unknown_channel';
  const presented = sha256(h.token ?? '');
  if (!h.token || presented.length !== cp.channel_token_hash.length || !timingSafeEqual(presented, cp.channel_token_hash)) return 'bad_token';
  if (h.resourceId && h.resourceId !== cp.channel_resource_id) return 'bad_token';
  if (cp.stopped_at) return 'stopped';
  if (h.resourceState === 'sync') return 'sync';
  const msg = Number(h.messageNumber ?? '0');
  const ins = await maybeOne(getPool(),
    `INSERT INTO content_source_events(source, event_key, workspace_id, kind, summary) VALUES ('google_drive', $1, $2, $3, $4) ON CONFLICT (source, event_key) DO NOTHING RETURNING id`,
    [`${h.channelId}:${Number.isFinite(msg) ? msg : 'x'}`, cp.workspace_id, (h.resourceState ?? 'change').slice(0, 30), JSON.stringify({ channel: h.channelId })]);
  if (!ins) return 'duplicate';
  await writeOutbox(getPool(), { workspaceId: cp.workspace_id, aggregateType: 'sync_checkpoint', aggregateId: cp.id, eventType: 'source.changes_signal', payload: { checkpointId: cp.id } });
  return 'accepted';
}

/** Worker: bounded changes.list with the saved authorization; marks matching linked items as changed or lost. */
export async function processDriveChanges(checkpointId: string): Promise<{ changed: number; lost: number }> {
  const cp = await maybeOne<{ id: string; connection_id: string; cursor: string | null; stopped_at: Date | null }>(getPool(),
    `SELECT id, connection_id, cursor, stopped_at FROM sync_checkpoints WHERE id=$1`, [checkpointId]);
  if (!cp || cp.stopped_at || !cp.cursor) return { changed: 0, lost: 0 };
  const conn = await maybeOne<ContentConnectionRow>(getPool(), `SELECT * FROM content_connections WHERE id=$1`, [cp.connection_id]);
  if (!conn || conn.status !== 'active' || conn.disconnected_at) return { changed: 0, lost: 0 };
  let token: string = cp.cursor;
  let changed = 0;
  let lost = 0;
  await withSource(conn, async (s) => {
    for (let page = 0; page < LIMITS.driveChangesPages; page++) {
      const res = await listChanges(s.google!, token);
      for (const ch of res.changes) {
        if (!ch.fileId) continue;
        const gone = ch.removed || ch.file?.trashed;
        const r = await getPool().query(
          gone
            ? `UPDATE source_items SET state='access_lost', state_detail='Removed or no longer shared at the source.', preview=NULL, external_url=NULL, updated_at=now()
                WHERE connection_id=$1 AND external_id=$2 AND state='linked'`
            : `UPDATE source_items SET change_detected_at=now(), updated_at=now() WHERE connection_id=$1 AND external_id=$2 AND state='linked'
                AND source_version IS DISTINCT FROM $3`,
          gone ? [conn.id, ch.fileId] : [conn.id, ch.fileId, ch.file?.version ?? null]);
        if (gone) lost += r.rowCount ?? 0; else changed += r.rowCount ?? 0;
      }
      if (res.newStartPageToken) { token = res.newStartPageToken; break; }
      if (!res.nextPageToken) break;
      token = res.nextPageToken;
    }
  });
  await getPool().query(`UPDATE sync_checkpoints SET cursor=$2, last_run_at=now(), last_error=NULL, updated_at=now() WHERE id=$1`, [cp.id, token]);
  return { changed, lost };
}

// ------------------------------------------------------------------ Notion webhooks
export type NotionWebhookResult = 'verification_recorded' | 'accepted' | 'duplicate' | 'ignored' | 'bad_signature' | 'not_configured';

export function notionSignature(token: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', token).update(rawBody).digest('hex')}`;
}

function sigEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface NotionEvent { id?: string; type?: string; workspace_id?: string; integration_id?: string; authors?: Array<{ id?: string; type?: string }>; entity?: { id?: string; type?: string }; data?: { parent?: { id?: string; type?: string; data_source_id?: string } } }

export async function handleNotionWebhook(rawBody: string, signature: string | null): Promise<NotionWebhookResult> {
  let body: NotionEvent & { verification_token?: string };
  try { body = JSON.parse(rawBody) as typeof body; } catch { return 'bad_signature'; }
  const cfg = await notionConfig();
  // One-time subscription handshake: Notion posts the verification_token (unsigned). It is stored encrypted for an owner
  // to adopt in Setup — never trusted automatically (anyone can POST here).
  if (typeof body.verification_token === 'string' && !body.type) {
    if (body.verification_token.length < 16 || body.verification_token.length > 512) return 'ignored';
    await getPool().query(
      `INSERT INTO content_source_events(source, event_key, kind, summary, secret_enc) VALUES ('notion', $1, 'verification', '{}'::jsonb, $2) ON CONFLICT (source, event_key) DO NOTHING`,
      [`verification:${createHash('sha256').update(body.verification_token).digest('hex').slice(0, 32)}`, JSON.stringify(encryptSecret(body.verification_token, settingAad('NOTION_WEBHOOK_VERIFICATION_TOKEN')))]);
    return 'verification_recorded';
  }
  if (!cfg.webhookToken) return 'not_configured';
  if (!signature || !sigEqual(signature, notionSignature(cfg.webhookToken, rawBody))) return 'bad_signature';
  if (!body.id || !body.entity?.id || !body.workspace_id) return 'ignored';
  const ins = await maybeOne(getPool(),
    `INSERT INTO content_source_events(source, event_key, kind, summary) VALUES ('notion', $1, $2, $3) ON CONFLICT (source, event_key) DO NOTHING RETURNING id`,
    [`event:${body.id.slice(0, 64)}`, (body.type ?? 'unknown').slice(0, 60), JSON.stringify({ entity: body.entity.type, workspace: body.workspace_id })]);
  if (!ins) return 'duplicate';
  const conns = await many<{ id: string; workspace_id: string; external_account_id: string }>(getPool(),
    `SELECT id, workspace_id, external_account_id FROM content_connections WHERE source='notion' AND external_workspace_id=$1 AND status='active' AND disconnected_at IS NULL`, [body.workspace_id]);
  const entityIds = [body.entity.id, body.data?.parent?.data_source_id, body.data?.parent?.type === 'data_source' ? body.data?.parent?.id : null]
    .filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{32,36}$/i.test(x)).map(normalizeNotionId);
  let marked = 0;
  for (const c of conns) {
    // Echo of Relay's own writeback (authored only by this connection's bot): ignore — prevents update loops.
    if (isOwnEcho(body.authors, c.external_account_id)) continue;
    const deleted = body.type === 'page.deleted' || body.type === 'data_source.deleted';
    const r = await getPool().query(
      deleted
        ? `UPDATE source_items SET state='removed', state_detail='Moved to trash in Notion.', preview=NULL, external_url=NULL, updated_at=now() WHERE connection_id=$1 AND external_id = ANY($2::text[]) AND state='linked'`
        : `UPDATE source_items SET change_detected_at=now(), updated_at=now() WHERE connection_id=$1 AND external_id = ANY($2::text[]) AND state='linked'`,
      [c.id, entityIds]);
    marked += r.rowCount ?? 0;
  }
  await getPool().query(`UPDATE content_source_events SET processed_at=now(), summary = summary || $2::jsonb WHERE source='notion' AND event_key=$1`, [`event:${body.id.slice(0, 64)}`, JSON.stringify({ marked })]);
  return marked ? 'accepted' : 'ignored';
}

/** Owner: adopt the most recent Notion verification token (sets NOTION_WEBHOOK_VERIFICATION_TOKEN) and show it once to paste into Notion. */
export async function adoptNotionVerificationToken(ctx: Ctx): Promise<{ verification_token: string; received_at: string }> {
  requireAction(ctx, 'setup.manage');
  const row = await maybeOne<{ secret_enc: never; received_at: Date }>(getPool(),
    `SELECT secret_enc, received_at FROM content_source_events WHERE source='notion' AND kind='verification' AND received_at > now() - interval '1 day' ORDER BY received_at DESC LIMIT 1`);
  if (!row) throw new AppError('not_found', 'No verification request from Notion in the last day. Create or resend the subscription in Notion.');
  const token = decryptSecret<string>(row.secret_enc, settingAad('NOTION_WEBHOOK_VERIFICATION_TOKEN'));
  await setSetting('NOTION_WEBHOOK_VERIFICATION_TOKEN', token, ctx.actor.userId);
  await audit(getPool(), { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'setup.updated', resourceType: 'app_setting', resourceId: 'NOTION_WEBHOOK_VERIFICATION_TOKEN', correlationId: ctx.correlationId });
  return { verification_token: token, received_at: row.received_at.toISOString() };
}
