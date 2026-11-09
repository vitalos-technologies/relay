// V3.5 stream B — WhatsApp Business Platform channel: connect (system-user token + WABA + phone number), approved
// templates (cached on the channel; refreshed on request), the charge shown BEFORE a send, inbound via the verified
// connector ingress (/api/connectors/webhooks/whatsapp → integration_events → this handler) and status webhooks:
// delivered/read receipts, actual pricing per message, failures after acceptance, and confirmation of Unknown sends
// through Relay's callback marker. Free-form text only inside the 24 h window; templates otherwise (charged by Meta).
import { AppError } from '@social-lite/core';
import type { TemplateInfo, TemplateSend } from '@social-lite/core/contracts/v35-inbox';
import { parseWhatsAppWebhook, verifyWhatsAppNumber, whatsAppCharge, whatsAppStatuses } from '@social-lite/providers/whatsapp/inbox';
import {
  WHATSAPP_FREE_SERVICE_MESSAGES_PER_MONTH, whatsAppServiceMonthStart, type WhatsAppChargeNotice, type WhatsAppRates, type WhatsAppServiceAllowance,
} from '@social-lite/core/contracts/whatsapp-charges';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { requireAction } from '../tenancy.js';
import { setupContext } from '../connections/index.js';
import { getSetting } from '../settings.js';
import { upsertIntegrationConnection, toIntegrationJson } from '../connectors/store.js';
import { registerInboundHandler } from '../connectors/registry.js';
import { channelRuntime } from './channels-runtime.js';
import { loadChannelFor } from './channels.js';
import { ingestItems } from './ingest.js';
import { confirmAttemptFromProvider } from './replies.js';
import { inboxEvent, type ChannelRow } from './shared.js';

type Rates = WhatsAppRates;

// ------------------------------------------------------------------ templates + charges
export function cachedTemplates(ch: Pick<ChannelRow, 'settings'>): TemplateInfo[] {
  const t = (ch.settings?.templates as { items?: TemplateInfo[] } | undefined)?.items;
  return Array.isArray(t) ? t : [];
}

/**
 * Free service messages used this month on this channel's phone number (H2). Counts Relay's own free-form sends (and
 * service-category templates) that are queued, sending, sent or unknown, from the earliest possible start of Meta's
 * month, across every channel on the same number; and whether Meta already billed a service message this month.
 */
export async function whatsAppServiceAllowance(db: Queryable, ch: Pick<ChannelRow, 'external_account_id' | 'is_simulated'>, now = new Date()): Promise<WhatsAppServiceAllowance> {
  const since = whatsAppServiceMonthStart(now);
  const r = await one<{ used: number; billed: boolean }>(db,
    `WITH chans AS (SELECT id FROM inbox_channels WHERE kind='whatsapp' AND external_account_id=$1 AND is_simulated=$2)
     SELECT (SELECT count(*)::int FROM inbox_reply_attempts a WHERE a.channel_id IN (SELECT id FROM chans) AND a.created_at >= $3
               AND a.state IN ('queued','sending','sent','unknown') AND (a.template IS NULL OR a.template->>'category' = 'service')) AS used,
            EXISTS (SELECT 1 FROM inbox_messages m WHERE m.channel_id IN (SELECT id FROM chans) AND m.direction='outbound' AND m.provider_created_at >= $3
               AND m.meta->'pricing'->>'category' = 'service' AND m.meta->'pricing'->>'billable' = 'true') AS billed`,
    [ch.external_account_id, ch.is_simulated, since]);
  return { used: r.used, limit: WHATSAPP_FREE_SERVICE_MESSAGES_PER_MONTH, billed_this_month: r.billed };
}

/** The charge for a free-form (service) reply on WhatsApp (shown before sending; acknowledged when billable). */
export function whatsAppServiceCharge(ch: Pick<ChannelRow, 'settings'>, now: Date, service: WhatsAppServiceAllowance): WhatsAppChargeNotice {
  return whatsAppCharge({ template: null, windowOpen: true, now, service, rates: (ch.settings?.rates as Rates | undefined) ?? null });
}

/** Validate a template against the cached approved list and render the exact text that will be sent. */
export function prepareTemplateSend(ch: ChannelRow, input: { name: string; language: string; params: string[] }, windowOpen: boolean,
  opts: { now?: Date; service?: WhatsAppServiceAllowance | null } = {}): { template: TemplateSend; rendered: string; charge: WhatsAppChargeNotice } {
  if (ch.kind !== 'whatsapp') throw new AppError('validation_failed', 'Templates are only available on WhatsApp.');
  const t = cachedTemplates(ch).find((x) => x.name === input.name && x.language === input.language);
  if (!t) throw new AppError('validation_failed', 'Unknown template. Refresh the template list.', { template: 'Not found' });
  if (t.status !== 'APPROVED') throw new AppError('validation_failed', 'This template is not approved by Meta.', { template: t.status });
  if (input.params.length !== t.param_count) throw new AppError('validation_failed', `This template needs ${t.param_count} value${t.param_count === 1 ? '' : 's'}.`, { params: 'Wrong number of values' });
  const rendered = t.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => input.params[Number(n) - 1] ?? '');
  const template: TemplateSend = { name: t.name, language: t.language, category: t.category, params: input.params };
  return { template, rendered: rendered.slice(0, 2000), charge: whatsAppCharge({ template, windowOpen, now: opts.now, service: opts.service ?? null, rates: (ch.settings?.rates as Rates | undefined) ?? null }) };
}

export async function listTemplates(ctx: Ctx, channelId: string, refresh = false): Promise<{ items: TemplateInfo[]; refreshed_at: string | null; rates: Rates | null; service_allowance: WhatsAppServiceAllowance }> {
  const ch = await loadChannelFor(ctx, channelId, refresh ? 'inbox.manage' : 'inbox.read');
  if (ch.kind !== 'whatsapp') throw new AppError('validation_failed', 'Templates are only available on WhatsApp.');
  if (refresh) {
    const rt = await channelRuntime(ch);
    const r = await rt.adapter.listTemplates!(rt.ctx, rt.creds, rt.conn);
    if (!r.ok) throw new AppError('provider_error', r.message);
    const at = new Date().toISOString();
    await getPool().query(`UPDATE inbox_channels SET settings = settings || jsonb_build_object('templates', $2::jsonb), updated_at=now() WHERE id=$1`, [ch.id, JSON.stringify({ items: r.items.slice(0, 200), refreshed_at: at })]);
    return { items: r.items, refreshed_at: at, rates: (ch.settings?.rates as Rates | undefined) ?? null, service_allowance: await whatsAppServiceAllowance(getPool(), ch) };
  }
  return { items: cachedTemplates(ch), refreshed_at: ((ch.settings?.templates as { refreshed_at?: string } | undefined)?.refreshed_at) ?? null, rates: (ch.settings?.rates as Rates | undefined) ?? null,
    service_allowance: await whatsAppServiceAllowance(getPool(), ch) };
}

export const ratesSchema = z.object({
  rates: z.record(z.enum(['marketing', 'utility', 'authentication', 'service']), z.object({ amount: z.number().min(0).max(10), currency: z.string().regex(/^[A-Z]{3}$/) }).strict()).nullable(),
}).strict();

/** Operator-entered rate card (Meta's rates vary by recipient country; Relay only shows what the operator entered). */
export async function setWhatsAppRates(ctx: Ctx, channelId: string, input: z.infer<typeof ratesSchema>): Promise<{ rates: Rates | null }> {
  const ch = await loadChannelFor(ctx, channelId, 'inbox.manage');
  if (ch.kind !== 'whatsapp') throw new AppError('validation_failed', 'Rates apply to WhatsApp only.');
  await getPool().query(`UPDATE inbox_channels SET settings = CASE WHEN $2::jsonb IS NULL THEN settings - 'rates' ELSE settings || jsonb_build_object('rates', $2::jsonb) END, updated_at=now() WHERE id=$1`, [ch.id, input.rates ? JSON.stringify(input.rates) : null]);
  await audit(getPool(), { workspaceId: ch.workspace_id, brandId: ch.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.whatsapp_rates_set', resourceType: 'inbox_channel', resourceId: ch.id, correlationId: ctx.correlationId });
  return { rates: input.rates };
}

// ------------------------------------------------------------------ connect (real installations)
export const whatsAppConnectSchema = z.object({
  brand_id: z.string().uuid(),
  waba_id: z.string().regex(/^\d{5,30}$/, 'Use the numeric WhatsApp Business Account ID'),
  phone_number_id: z.string().regex(/^\d{5,30}$/, 'Use the numeric phone number ID'),
  access_token: z.string().min(20).max(1000).regex(/^\S+$/),
}).strict();

/**
 * Install a WhatsApp Business Account from the protected setup form (the token never leaves the server and is stored
 * in the encrypted vault). The number is verified against Meta before anything is saved; scopes come from Meta's
 * debug_token when the Meta app is configured — never assumed.
 */
export async function connectWhatsApp(ctx: Ctx, input: z.infer<typeof whatsAppConnectSchema>): Promise<ReturnType<typeof toIntegrationJson>> {
  requireAction(ctx, 'integrations.manage', { brandId: input.brand_id });
  requireAction(ctx, 'inbox.manage', { brandId: input.brand_id });
  const sctx = await setupContext('facebook');
  const v = await verifyWhatsAppNumber(sctx, input.access_token, input.phone_number_id);
  if (!v.ok) throw new AppError('validation_failed', v.message, { phone_number_id: v.message });
  let granted: string[] = ['whatsapp_business_management'];   // proved by the number lookup above
  const appId = await getSetting('META_APP_ID');
  const appSecret = await getSetting('META_APP_SECRET');
  if (appId && appSecret) {
    try {
      const r = await sctx.transport.send({ method: 'GET', url: `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(input.access_token)}&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`, op: 'whatsapp.debug_token' });
      const scopes = (JSON.parse(r.body) as { data?: { scopes?: string[] } }).data?.scopes;
      if (Array.isArray(scopes)) granted = scopes.filter((s) => typeof s === 'string').slice(0, 50);
    } catch { /* keep the proven minimum */ }
  }
  const row = await withTx(async (tx) => (await upsertIntegrationConnection(tx, {
    workspaceId: ctx.access.workspaceId, brandId: input.brand_id, connector: 'whatsapp', actorUserId: ctx.actor.userId, correlationId: ctx.correlationId,
    externalAccountId: input.waba_id, displayName: v.verifiedName ? `${v.verifiedName} (${v.display})` : v.display, credentials: { kind: 'oauth2', accessToken: input.access_token },
    grantedScopes: granted, expiresAt: null, health: { status: granted.includes('whatsapp_business_messaging') ? 'active' : 'needs_attention', message: granted.includes('whatsapp_business_messaging') ? 'Number verified.' : 'The token may lack whatsapp_business_messaging.' },
    settings: { phone_numbers: [{ id: input.phone_number_id, display: v.display }] },
  })).row);
  return toIntegrationJson(row);
}

// ------------------------------------------------------------------ inbound (connector ingress handler)
/** Apply status webhooks: actual pricing, failures after acceptance, confirmation of Unknown sends. */
export async function applyWhatsAppStatuses(body: unknown, simulated: boolean): Promise<{ priced: number; failed: number; confirmed: number }> {
  const out = { priced: 0, failed: 0, confirmed: 0 };
  for (const s of whatsAppStatuses(body)) {
    const chans = await many<ChannelRow>(getPool(), `SELECT * FROM inbox_channels WHERE kind='whatsapp' AND external_account_id=$1 AND disconnected_at IS NULL AND is_simulated=$2`, [s.phoneNumberId, simulated]);
    for (const ch of chans) {
      const marker = /^relay-attempt:([0-9a-f-]{36})$/i.exec(s.biz_opaque_callback_data ?? '');
      if (marker && s.id && await confirmAttemptFromProvider(marker[1]!, ch.id, s.id)) out.confirmed++;
      if (!s.id) continue;
      if (s.pricing) {
        const pricing = { billable: s.pricing.billable === true, model: s.pricing.pricing_model ?? null, category: s.pricing.category ?? null, type: s.pricing.type ?? null };
        const r = await getPool().query(`UPDATE inbox_messages SET meta = meta || jsonb_build_object('pricing', $3::jsonb) WHERE channel_id=$1 AND external_id=$2`, [ch.id, s.id, JSON.stringify(pricing)]);
        out.priced += r.rowCount ?? 0;
      }
      if (s.status === 'failed') {
        const err = s.errors?.[0];
        const m = await maybeOne<{ id: string; conversation_id: string }>(getPool(),
          `UPDATE inbox_messages SET meta = meta || jsonb_build_object('failed', jsonb_build_object('code', $3::text, 'title', $4::text)) WHERE channel_id=$1 AND external_id=$2 RETURNING id, conversation_id`,
          [ch.id, s.id, err?.code !== undefined ? String(err.code) : null, (err?.title ?? 'Not delivered').slice(0, 120)]);
        if (m) {
          await getPool().query(`UPDATE inbox_conversations SET version=version+1, updated_at=now() WHERE id=$1`, [m.conversation_id]);
          await inboxEvent(getPool(), { workspaceId: ch.workspace_id, conversationId: m.conversation_id, brandId: ch.brand_id, kind: 'message.delivery_failed', data: { message_id: m.id } });
          out.failed++;
        }
      }
    }
  }
  return out;
}

export async function ingestWhatsAppPayload(body: unknown, simulated: boolean): Promise<number> {
  const r = await ingestItems('whatsapp', parseWhatsAppWebhook(body), { simulated });
  const s = await applyWhatsAppStatuses(body, simulated);
  return r.messages + r.receipts + s.priced + s.failed + s.confirmed;
}

let registered = false;
/** Register the verified-webhook handler for connector 'whatsapp' (worker process). Idempotent. */
export function registerWhatsAppInbound(): void {
  if (registered) return;
  registered = true;
  registerInboundHandler({
    connector: 'whatsapp',
    async handle(e) {
      if (e.origin === 'relay_echo') return { outcome: 'ignored', detail: 'origin marker' };
      const n = await ingestWhatsAppPayload(e.body, false);
      return { outcome: n ? 'processed' : 'ignored' };
    },
  });
}
