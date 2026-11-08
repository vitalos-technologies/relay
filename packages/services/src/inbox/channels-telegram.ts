// V3.5 stream B — Telegram bot channel: the explicit WEBHOOK-OWNERSHIP plan (brief §10; HANDOFF "never overwrite an
// existing Telegram webhook") and the per-channel webhook receiver.
//
// A bot has exactly one update consumer (a webhook OR getUpdates polling). Relay:
//  1. Check   — getWebhookInfo. A non-empty url that is not Relay's ⇒ "external": Relay never overwrites it (only the
//               host is shown). Empty ⇒ "none": nobody receives by webhook — but another app may be POLLING
//               (getUpdates), which the API cannot reveal.
//  2. Claim   — only by a person with inbox.manage, only from "none", only with the explicit confirmation that no other
//               app reads this bot's updates, and only after re-checking getWebhookInfo immediately before setWebhook.
//               Relay sets its per-channel URL + a random secret token (stored encrypted), then verifies the result.
//  3. Release — deleteWebhook ONLY if the webhook is still Relay's; otherwise nothing is touched.
// Relay never calls getUpdates. Updates arrive at POST /api/inbox/telegram/:channelId, authenticated by the secret
// token header, persisted + deduplicated (update_id) BEFORE acknowledging, then processed by the inbox worker.
import { randomBytes } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import type { ChannelOptions } from '@social-lite/core/contracts/v35-inbox';
import { telegramDeleteWebhook, telegramSetWebhook, telegramWebhookInfo, type TelegramEnvelope } from '@social-lite/providers/telegram/inbox';
import { getPool, maybeOne, withTx } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { decryptSecret, encryptSecret, settingAad, type EncryptedBlob } from '../crypto.js';
import { log } from '../log.js';
import { writeOutbox } from '../outbox.js';
import { safeEqual } from '../connectors/verify.js';
import { channelRuntime } from './channels-runtime.js';
import { loadChannelFor, toChannelJson } from './channels.js';
import { ingestItems } from './ingest.js';
import { iso, loadChannelRow, type ChannelRow } from './shared.js';

type Owner = NonNullable<ChannelOptions['telegram']>['owner'];
interface TgSettings { owner: Owner; external_host: string | null; checked_at: string | null; pending: number | null; claimed_at?: string | null; claimed_by?: string | null }
const CHECK_TTL_MS = 10 * 60_000;

const aad = (channelId: string) => settingAad(`inbox-channel:${channelId}:webhook`);
export const telegramWebhookUrl = (channelId: string) => `${config().APP_BASE_URL.replace(/\/$/, '')}/api/inbox/telegram/${channelId}`;
const tg = (ch: Pick<ChannelRow, 'settings'>): TgSettings | null => (ch.settings?.telegram as TgSettings | undefined) ?? null;

/** Channel status gate: a Telegram channel is active only while Relay owns the bot's update stream. */
export function telegramGate(settings: Record<string, unknown>, ev: { status: ChannelRow['status']; detail: string | null; missing: string[] }) {
  if (ev.status !== 'active') return ev;
  const t = settings.telegram as TgSettings | undefined;
  if (t?.owner === 'relay') return ev;
  return {
    status: 'needs_permission' as const,
    detail: t?.owner === 'external' ? 'Another app receives this bot’s updates. Relay will not overwrite its webhook.' : 'Relay does not receive this bot’s messages yet. Connect its updates.',
    missing: ['telegram_updates'],
  };
}

/** Safe options summary for clients (no secrets). */
export function channelOptions(r: ChannelRow): ChannelOptions {
  const s = r.settings ?? {};
  const t = tg(r);
  const tpl = s.templates as { items?: unknown[]; refreshed_at?: string } | undefined;
  const poll = s.poll as ChannelOptions['poll'] | undefined;
  return {
    ...(r.kind === 'telegram_bot' ? { telegram: { owner: t?.owner ?? 'unknown', external_host: t?.external_host ?? null, checked_at: t?.checked_at ?? null, pending: t?.pending ?? null } } : {}),
    csat_enabled: s.csat_enabled === true,
    ...(r.kind === 'whatsapp' ? { templates: { count: Array.isArray(tpl?.items) ? tpl!.items!.length : 0, refreshed_at: tpl?.refreshed_at ?? null }, rates: (s.rates as ChannelOptions['rates']) ?? null } : {}),
    ...(poll ? { poll } : {}),
  };
}

function classify(url: string, channelId: string): { owner: Owner; host: string | null } {
  if (!url) return { owner: 'none', host: null };
  if (url === telegramWebhookUrl(channelId)) return { owner: 'relay', host: null };
  let host: string | null = null;
  try { host = new URL(url).host.slice(0, 120); } catch { host = 'unknown host'; }
  return { owner: 'external', host };
}

async function saveTg(id: string, t: TgSettings, status?: { status: ChannelRow['status']; detail: string | null; missing: string[] }): Promise<ChannelRow> {
  const r = await getPool().query<ChannelRow>(
    `UPDATE inbox_channels SET settings = settings || jsonb_build_object('telegram', $2::jsonb),
            status = CASE WHEN $3::text IS NULL OR status = 'paused' THEN status ELSE $3 END, status_detail = CASE WHEN $3::text IS NULL OR status='paused' THEN status_detail ELSE $4 END,
            missing_permissions = CASE WHEN $3::text IS NULL OR status='paused' THEN missing_permissions ELSE $5::text[] END, updated_at=now()
      WHERE id=$1 RETURNING *`, [id, JSON.stringify(t), status?.status ?? null, status?.detail ?? null, status?.missing ?? []]);
  return r.rows[0]!;
}

async function telegramChannel(ctx: Ctx, id: string): Promise<ChannelRow> {
  const ch = await loadChannelFor(ctx, id, 'inbox.manage');
  if (ch.kind !== 'telegram_bot') throw new AppError('validation_failed', 'Not a Telegram channel.');
  if (ch.disconnected_at) throw new AppError('invalid_state', 'This channel was removed.');
  return ch;
}

export async function checkTelegramWebhook(ctx: Ctx, id: string) {
  const ch = await telegramChannel(ctx, id);
  const rt = await channelRuntime(ch);
  const info = await telegramWebhookInfo(rt.ctx, rt.creds).catch((err: Error) => { throw new AppError('provider_error', `Telegram could not be checked (${err.name}). Try again.`); });
  const c = classify(info.url, ch.id);
  const t: TgSettings = { ...(tg(ch) ?? {}), owner: c.owner, external_host: c.host, checked_at: new Date().toISOString(), pending: info.pending };
  const gated = telegramGate({ telegram: t }, { status: 'active', detail: null, missing: [] });
  const row = await saveTg(ch.id, t, ch.status === 'active' || ch.status === 'needs_permission' ? gated : undefined);
  return { channel: toChannelJson(row), webhook: { owner: c.owner, external_host: c.host, pending_updates: info.pending } };
}

export const claimTelegramSchema = z.object({ confirm_no_other_consumer: z.literal(true) }).strict();

export async function claimTelegramWebhook(ctx: Ctx, id: string, input: z.infer<typeof claimTelegramSchema>) {
  if (input.confirm_no_other_consumer !== true) throw new AppError('validation_failed', 'Confirm that no other app reads this bot’s updates.');
  const ch = await telegramChannel(ctx, id);
  const prev = tg(ch);
  if (!prev?.checked_at || Date.now() - Date.parse(prev.checked_at) > CHECK_TTL_MS) throw new AppError('invalid_state', 'Check the bot first.', undefined, { reason: 'check_required' });
  const rt = await channelRuntime(ch);
  // Re-check immediately before writing: never overwrite a webhook that appeared since the check.
  const now = await telegramWebhookInfo(rt.ctx, rt.creds);
  const c = classify(now.url, ch.id);
  if (c.owner === 'external') {
    await saveTg(ch.id, { ...prev, owner: 'external', external_host: c.host, checked_at: new Date().toISOString(), pending: now.pending }, telegramGate({ telegram: { owner: 'external' } }, { status: 'active', detail: null, missing: [] }));
    throw new AppError('conflict', `This bot already sends its updates to ${c.host}. Relay does not overwrite another app’s webhook.`, undefined, { reason: 'webhook_in_use', host: c.host });
  }
  if (c.owner === 'none') {
    const secret = randomBytes(32).toString('base64url');
    await getPool().query(`UPDATE inbox_channels SET secret_enc=$2, updated_at=now() WHERE id=$1`, [ch.id, JSON.stringify(encryptSecret(secret, aad(ch.id)))]);
    await telegramSetWebhook(rt.ctx, rt.creds, telegramWebhookUrl(ch.id), secret).catch((err: Error) => { throw new AppError('provider_error', `Telegram refused the webhook (${err.message.slice(0, 120)}).`); });
    const after = await telegramWebhookInfo(rt.ctx, rt.creds);
    if (classify(after.url, ch.id).owner !== 'relay') throw new AppError('provider_error', 'Telegram did not confirm the webhook. Nothing else was changed.');
  }
  const t: TgSettings = { owner: 'relay', external_host: null, checked_at: new Date().toISOString(), pending: now.pending, claimed_at: new Date().toISOString(), claimed_by: ctx.actor.userId };
  const row = await saveTg(ch.id, t, { status: 'active', detail: null, missing: [] });
  await audit(getPool(), { workspaceId: ch.workspace_id, brandId: ch.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.telegram_updates_claimed', resourceType: 'inbox_channel', resourceId: ch.id, diff: { confirmed_no_other_consumer: true, previous: c.owner }, correlationId: ctx.correlationId });
  return { channel: toChannelJson(row) };
}

export async function releaseTelegramWebhook(ctx: Ctx, id: string) {
  const ch = await telegramChannel(ctx, id);
  const rt = await channelRuntime(ch);
  const now = await telegramWebhookInfo(rt.ctx, rt.creds);
  const c = classify(now.url, ch.id);
  if (c.owner === 'relay') await telegramDeleteWebhook(rt.ctx, rt.creds);   // only Relay's own webhook is ever removed
  await getPool().query(`UPDATE inbox_channels SET secret_enc=NULL WHERE id=$1`, [ch.id]);
  const t: TgSettings = { owner: c.owner === 'relay' ? 'none' : c.owner, external_host: c.host, checked_at: new Date().toISOString(), pending: now.pending };
  const row = await saveTg(ch.id, t, telegramGate({ telegram: t }, { status: 'active', detail: null, missing: [] }));
  await audit(getPool(), { workspaceId: ch.workspace_id, brandId: ch.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.telegram_updates_released', resourceType: 'inbox_channel', resourceId: ch.id, diff: { removed_relay_webhook: c.owner === 'relay' }, correlationId: ctx.correlationId });
  return { channel: toChannelJson(row) };
}

// ------------------------------------------------------------------ receiver
export interface ReceiveResult { status: number; body: Record<string, unknown> }

/** POST /api/inbox/telegram/:channelId — authenticate (secret token), persist + dedupe, then acknowledge. */
export async function receiveTelegramUpdate(channelId: string, rawBody: string, secretHeader: string | null): Promise<ReceiveResult> {
  if (!/^[0-9a-f-]{36}$/i.test(channelId)) return { status: 404, body: { error: 'not_found' } };
  if (rawBody.length > 256 * 1024) return { status: 413, body: { error: 'payload_too_large' } };
  const ch = await maybeOne<ChannelRow>(getPool(), `SELECT * FROM inbox_channels WHERE id=$1 AND kind='telegram_bot'`, [channelId]);
  if (!ch?.secret_enc) return { status: 404, body: { error: 'not_found' } };
  let secret: string;
  try { secret = decryptSecret<string>(ch.secret_enc as EncryptedBlob, aad(ch.id)); } catch { return { status: 412, body: { error: 'not_configured' } }; }
  if (!secretHeader || !safeEqual(secretHeader, secret)) { log.warn('telegram_inbox_rejected', { reason: 'bad_secret' }); return { status: 401, body: { error: 'bad_signature' } }; }
  let update: { update_id?: number };
  try { update = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'malformed' } }; }
  if (typeof update.update_id !== 'number') return { status: 400, body: { error: 'malformed' } };
  // Removed channels: acknowledge (Telegram would retry for 24 h) but keep nothing.
  if (ch.disconnected_at) return { status: 200, body: { ok: true, ignored: true } };
  return { status: 200, body: { ok: true, duplicate: !(await storeInbound(ch, String(update.update_id), { bot_id: ch.external_account_id, update } as TelegramEnvelope)) } };
}

/** Persist a verified inbound update (dedupe per channel) and wake the inbox worker. Returns false for duplicates. */
export async function storeInbound(ch: ChannelRow, dedupeKey: string, envelope: unknown): Promise<boolean> {
  return withTx(async (tx) => {
    const r = await maybeOne<{ id: string }>(tx, `INSERT INTO inbox_inbound_events(workspace_id, channel_id, dedupe_key, body) VALUES ($1,$2,$3,$4) ON CONFLICT (channel_id, dedupe_key) DO NOTHING RETURNING id`,
      [ch.workspace_id, ch.id, dedupeKey.slice(0, 200), JSON.stringify(envelope)]);
    if (!r) return false;
    await writeOutbox(tx, { workspaceId: ch.workspace_id, aggregateType: 'inbox_channel', aggregateId: ch.id, eventType: 'inbox.inbound_received', payload: { eventId: r.id } });
    return true;
  });
}

/** Worker: process stored inbound updates of one channel (idempotent; ingestion dedupes by provider id). */
export async function processInboundEvents(channelId: string | null, limit = 50): Promise<number> {
  const rows = (await getPool().query<{ id: string; channel_id: string; body: unknown; attempts: number }>(
    `UPDATE inbox_inbound_events SET attempts=attempts+1 WHERE id IN (
       SELECT id FROM inbox_inbound_events WHERE state IN ('pending','failed') AND ($1::uuid IS NULL OR channel_id=$1) AND attempts < 8 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING id, channel_id, body, attempts`, [channelId, limit])).rows;
  let n = 0;
  for (const e of rows.sort((a, b) => Number(a.id) - Number(b.id))) {
    try {
      const ch = await loadChannelRow(getPool(), e.channel_id);
      if (!ch || ch.disconnected_at) { await getPool().query(`UPDATE inbox_inbound_events SET state='ignored', processed_at=now() WHERE id=$1`, [e.id]); continue; }
      const { getInboxAdapter } = await import('@social-lite/providers');
      const items = getInboxAdapter(ch.kind)?.parseWebhook(e.body) ?? [];
      const r = await ingestItems(ch.kind, items, { simulated: ch.is_simulated });
      await getPool().query(`UPDATE inbox_inbound_events SET state=$2, processed_at=now(), error=NULL WHERE id=$1`, [e.id, r.messages + r.edits + r.deletes + r.duplicates ? 'processed' : 'ignored']);
      n++;
    } catch (err) {
      await getPool().query(`UPDATE inbox_inbound_events SET state='failed', error=$2 WHERE id=$1`, [e.id, (err as Error).message.slice(0, 300)]);
    }
  }
  return n;
}

export async function telegramStatus(ctx: Ctx, id: string) {
  const ch = await loadChannelFor(ctx, id, 'inbox.read');
  if (ch.kind !== 'telegram_bot') throw notFound('Channel');
  return { webhook_url_host: (() => { try { return new URL(telegramWebhookUrl(ch.id)).host; } catch { return null; } })(), state: tg(ch), checked_at: iso(tg(ch)?.checked_at ? new Date(tg(ch)!.checked_at!) : null) };
}
