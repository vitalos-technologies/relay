// Verified webhook ingress (spec §9, §14): authenticate the RAW body, persist + deduplicate, then acknowledge.
// Publishing does not depend on webhooks; receipts are stored for audit/debugging (bodies kept ≤ 7 days)
// and processing never regresses delivery state (terminal states are never changed by a webhook).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '@social-lite/core';
import { maybeOne, withTx, type Queryable } from '@social-lite/db';
import { getPool } from '@social-lite/db';
import { getSetting } from './settings.js';
import { writeOutbox } from './outbox.js';

const MAX_BODY = 512 * 1024;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface WebhookResult { status: number; body: unknown; contentType?: string }

/** Meta subscription verification handshake (GET). */
export async function verifyMetaSubscription(params: URLSearchParams): Promise<WebhookResult> {
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!expected) throw new AppError('provider_not_configured', 'Meta webhooks are not configured');
  if (params.get('hub.mode') !== 'subscribe' || !safeEqual(params.get('hub.verify_token') ?? '', expected)) throw new AppError('forbidden', 'Verification failed');
  return { status: 200, body: params.get('hub.challenge') ?? '', contentType: 'text/plain' };
}

export async function receiveWebhook(provider: string, raw: string, headers: Headers): Promise<WebhookResult> {
  if (raw.length > MAX_BODY) throw new AppError('payload_too_large', 'Body too large');
  let externalId: string | null = null;
  let eventTime: Date | null = null;
  if (provider === 'telegram') {
    const secret = await getSetting('TELEGRAM_WEBHOOK_SECRET');
    if (!secret) throw new AppError('provider_not_configured', 'Telegram webhooks are not configured');
    if (!safeEqual(headers.get('x-telegram-bot-api-secret-token') ?? '', secret)) throw new AppError('forbidden', 'Invalid webhook secret');
    const body = parse(raw);
    if (typeof body.update_id === 'number') externalId = String(body.update_id);
  } else if (provider === 'meta' || provider === 'facebook' || provider === 'instagram') {
    const secret = await getSetting('META_APP_SECRET');
    if (!secret) throw new AppError('provider_not_configured', 'Meta webhooks are not configured');
    const sig = headers.get('x-hub-signature-256') ?? '';
    const expected = `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`;
    if (!safeEqual(sig, expected)) throw new AppError('forbidden', 'Invalid signature');
    const body = parse(raw);
    const t = Array.isArray(body.entry) ? Number((body.entry[0] as { time?: number })?.time) : NaN;
    if (Number.isFinite(t)) eventTime = new Date(t > 1e12 ? t : t * 1000);
  } else {
    throw new AppError('not_found', 'Unknown webhook provider');
  }
  const digest = createHash('sha256').update(raw).digest('hex');
  const normalized = provider === 'facebook' || provider === 'instagram' ? 'meta' : provider;
  const inserted = await maybeOne<{ id: string }>(getPool(),
    `INSERT INTO webhook_receipts(provider, external_event_id, digest, event_time, body)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`, [normalized, externalId, digest, eventTime, raw]);
  if (inserted) {
    await writeOutbox(getPool(), { workspaceId: null, aggregateType: 'webhook', aggregateId: inserted.id, eventType: 'webhook.received', payload: { provider: normalized } });
  }
  // Duplicates are acknowledged (200) so providers stop redelivering; they are not processed twice.
  return { status: 200, body: { ok: true, duplicate: !inserted } };
}

function parse(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') return v as Record<string, unknown>;
  } catch { /* fallthrough */ }
  throw new AppError('validation_failed', 'Body must be JSON');
}

// ---------------------------------------------------------------- processing (worker)
// Forward-only: a webhook may move Unknown/Processing → Published when it identifies OUR post.
// It never regresses a state, never marks anything failed, and ignores everything else.

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);

async function confirm(db: Queryable, deliveryId: string, providerId: string, note: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE deliveries SET state='published', needs_reconcile=false, lease_owner=NULL, lease_expires_at=NULL,
            provider_ids=(SELECT array_agg(DISTINCT x) FROM unnest(provider_ids || ARRAY[$2]::text[]) x),
            published_at=coalesce(published_at, now()), last_error_code=NULL, last_error_message=$3, updated_at=now()
      WHERE id=$1 AND state IN ('unknown','processing') RETURNING workspace_id, schedule_id, post_id`, [deliveryId, providerId, note]);
  const row = r.rows[0] as { workspace_id: string; schedule_id: string; post_id: string } | undefined;
  if (!row) return false;
  await writeOutbox(db, { workspaceId: row.workspace_id, aggregateType: 'delivery', aggregateId: deliveryId, eventType: 'delivery.state_changed', payload: { state: 'published', postId: row.post_id, scheduleId: row.schedule_id } });
  await db.query(`UPDATE schedules SET status='completed' WHERE id=$1 AND status='active'
                   AND NOT EXISTS (SELECT 1 FROM deliveries WHERE schedule_id=$1 AND state NOT IN ('published','failed','cancelled','expired'))`, [row.schedule_id]);
  return true;
}

export async function processWebhookReceipt(receiptId: string): Promise<{ confirmed: number; state: 'processed' | 'ignored' }> {
  const db = getPool();
  const rec = await maybeOne<{ provider: string; body: unknown; processing_state: string }>(db, `SELECT provider, body, processing_state FROM webhook_receipts WHERE id=$1`, [receiptId]);
  if (!rec || rec.processing_state !== 'pending' || !rec.body || typeof rec.body !== 'object') return { confirmed: 0, state: 'ignored' };
  const body = rec.body as Record<string, unknown>;
  let confirmed = 0;
  if (rec.provider === 'meta') {
    const ids = new Set<string>();
    for (const e of (Array.isArray(body.entry) ? body.entry : []) as Array<{ changes?: Array<{ value?: Record<string, unknown> }> }>) {
      for (const c of e.changes ?? []) {
        for (const k of ['post_id', 'media_id', 'id']) { const v = c.value?.[k]; if (typeof v === 'string' && /^[\d_]{1,64}$/.test(v)) ids.add(v); }
      }
    }
    for (const id of ids) {
      const rows = await db.query<{ id: string }>(`SELECT id FROM deliveries WHERE provider IN ('facebook','instagram') AND NOT is_mock AND state IN ('unknown','processing') AND $1 = ANY(provider_ids) LIMIT 5`, [id]);
      for (const d of rows.rows) if (await withTx((tx) => confirm(tx, d.id, id, 'Confirmed by a verified Meta webhook.'), db)) confirmed++;
    }
  } else if (rec.provider === 'telegram') {
    const post = (body.channel_post ?? null) as { chat?: { id?: number }; message_id?: number; text?: string; caption?: string; date?: number } | null;
    if (post?.chat?.id !== undefined && typeof post.message_id === 'number') {
      const text = norm(post.text ?? post.caption ?? '');
      const at = new Date((post.date ?? 0) * 1000);
      const cands = await db.query<{ id: string; rendered_text: string; link: string | null }>(
        `SELECT d.id, v.rendered_text, v.link FROM deliveries d JOIN connections c ON c.id=d.connection_id JOIN variants v ON v.id=d.variant_id
          WHERE d.provider='telegram' AND NOT d.is_mock AND d.state='unknown' AND c.provider_account_id=$1
            AND $2::timestamptz BETWEEN coalesce(d.unknown_since, d.due_at) - interval '15 minutes' AND coalesce(d.unknown_since, now()) + interval '15 minutes'`,
        [String(post.chat.id), at]);
      // Only an unambiguous single text match resolves an Unknown result.
      const matches = cands.rows.filter((c) => { const mine = norm(c.rendered_text).slice(0, 120); return mine.length > 0 && text.startsWith(mine); });
      if (matches.length === 1 && await withTx((tx) => confirm(tx, matches[0]!.id, String(post.message_id!), 'Confirmed by the Telegram channel update.'), db)) confirmed++;
    }
  }
  const state = confirmed ? 'processed' : 'ignored';
  await db.query(`UPDATE webhook_receipts SET processing_state=$2, processed_at=now() WHERE id=$1`, [receiptId, state]);
  return { confirmed, state };
}
