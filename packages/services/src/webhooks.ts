// Verified webhook ingress (spec §9, §14): authenticate the RAW body, persist + deduplicate, then acknowledge.
// Publishing does not depend on webhooks; receipts are stored for audit/debugging (bodies kept ≤ 7 days)
// and processing never regresses delivery state (terminal states are never changed by a webhook).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '@social-lite/core';
import { maybeOne } from '@social-lite/db';
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
