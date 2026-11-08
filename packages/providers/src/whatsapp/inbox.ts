// WhatsApp Business Platform (Cloud API) inbox adapter — V3.5 stream B. A customer-care channel installed as a business
// integration (integration_connections connector 'whatsapp'): a system-user token + a WhatsApp Business Account (WABA)
// + one registered phone number per inbox channel. Verified 2026-11-08 against developers.facebook.com/docs/whatsapp:
//  - Send: POST /{version}/{phone-number-id}/messages (JSON, Bearer) {messaging_product:'whatsapp', recipient_type:
//    'individual', to, type:'text', text:{body}} or type:'template' {template:{name, language:{code}, components}}
//    → {messages:[{id, message_status}]}. `biz_opaque_callback_data` is echoed in status webhooks: Relay puts its
//    attempt id there so a send whose response was lost is reconciled from the status webhook (no list API exists).
//  - Free-form messages only inside the 24 h customer service window (since the customer's last message); outside it
//    only approved templates (error 131047 otherwise).
//  - Pricing: per-message pricing since 2025-07-01 — template messages are charged per DELIVERED message by category
//    (marketing / utility / authentication) and recipient country; service (free-form) messages are free; utility
//    templates sent inside an open customer service window are free. Actual pricing per message arrives in the
//    status webhook (`pricing {billable, pricing_model, category, type}`) and is stored on the message.
//  - Templates: GET /{waba-id}/message_templates?fields=name,language,status,category,components.
//  - Webhooks object=whatsapp_business_account, field=messages: value.messages[] (inbound), value.statuses[]
//    (sent/delivered/read/failed + pricing). Signature X-Hub-Signature-256 (connector ingress verifier 'whatsapp').
//  - Media: GET /{media-id} → {url, mime_type}; the url needs the same Bearer token (host lookaside.fbsbx.com).
import { TransportError, type AdapterContext, type ProviderCredentials, type PublishConnection } from '@social-lite/core';
import type {
  ChannelCapability, InboundItem, InboxAdapter, ReplyRulesInput, ReplyRulesResult, SendReplyResult, TemplateInfo, TemplateSend,
} from '@social-lite/core/contracts/v35-inbox';
import { ProviderHttpError, call, parseJson, retryAfterAt, safeCode, safeText } from '../shared/http.js';
import type { ErrorClass } from '../shared/classify.js';
import { clip, epochToIso, replyFromError, str } from '../shared/inbox.js';
import { DEFAULT_GRAPH_VERSION, GRAPH_HOST, graphVersion } from '../meta/graph.js';

const DAY = 86_400_000;
export const WHATSAPP_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management'] as const;

export const WHATSAPP_CAPABILITY: ChannelCapability = {
  kind: 'whatsapp',
  conversationTypes: { dm: { read: 'needs_approval', reply: 'needs_approval', visibility: 'private' } },
  inbound: 'webhook',
  history: 'None via the API: only messages received by the webhook after the number was added.',
  replyWindow: 'Free-form replies only within 24 h of the customer’s last message; otherwise an approved template (charged per delivered message).',
  attachments: 'Inbound images, documents, audio and video: metadata, fetched on request. Outbound text and templates.',
  moderation: [],
  receipts: { delivered: true, read: true },
  requires: ['WhatsApp Business Account + registered phone number', 'Meta Business verification and a payment method on the WABA', 'System-user token with whatsapp_business_messaging + whatsapp_business_management', 'Per-message pricing (since 2025-07-01) for templates', 'Approved templates for messages outside the 24 h window'],
  verifiedOn: '2026-11-08',
};

export interface WhatsAppConn { phoneNumberId: string; wabaId: string }
export function waIds(conn: PublishConnection): WhatsAppConn {
  return { phoneNumberId: String(conn.metadata.phone_number_id ?? ''), wabaId: String(conn.metadata.waba_id ?? conn.providerAccountId) };
}

function token(creds: ProviderCredentials): string | null {
  if (creds.kind === 'oauth2') return creds.accessToken || null;
  if (creds.kind === 'mock') return creds.token || null;
  return null;
}

const base = (ctx: AdapterContext) => `${(ctx.config.baseUrls?.graph ?? GRAPH_HOST).replace(/\/$/, '')}/${ctx.config.apiVersion ? graphVersion(ctx.config) : DEFAULT_GRAPH_VERSION}`;

export function parseWhatsAppError(res: { status: number; headers: Record<string, string>; body: string }, nowMs: number): ProviderHttpError {
  const e = (parseJson(res.body).error ?? {}) as { code?: number; message?: string; error_data?: { details?: string } };
  return new ProviderHttpError('WhatsApp', res.status, safeCode(e.code !== undefined ? String(e.code) : null), safeText(e.error_data?.details ?? e.message), retryAfterAt(res.headers, nowMs), res.headers);
}

export function classifyWhatsApp(e: ProviderHttpError, nowMs: number): ErrorClass {
  const code = Number(e.code ?? NaN);
  const retry = (ms: number) => (e.retryAtMs ? Math.max(1000, e.retryAtMs - nowMs) : ms);
  if (code === 190 || e.status === 401) return { kind: 'reconnect', code: 'whatsapp_token_invalid', message: 'The WhatsApp token is invalid or expired. Reconnect WhatsApp.' };
  if (code === 10 || (code >= 200 && code <= 299)) return { kind: 'permission', code: 'whatsapp_permission', message: 'The token lacks whatsapp_business_messaging for this number.' };
  if ([4, 80007, 130429, 131056, 131048].includes(code) || e.status === 429) return { kind: 'rate_limited', code: 'rate_limited', message: 'WhatsApp rate limit reached.', retryAfterMs: retry(60_000) };
  if (code === 131047) return { kind: 'invalid', code: 'reply_window_closed', message: 'More than 24 hours since the customer last wrote: only an approved template can be sent.' };
  if (code === 131026) return { kind: 'invalid', code: 'undeliverable', message: 'WhatsApp could not deliver to this number (not on WhatsApp, or an old app version).' };
  if (code === 131042) return { kind: 'budget', code: 'payment_issue', message: 'WhatsApp refused: there is a payment problem on the WhatsApp Business Account.' };
  if (code === 368 || code === 131031) return { kind: 'permission', code: 'account_restricted', message: 'WhatsApp has restricted or locked this account.' };
  if (code >= 132000 && code <= 132999) return { kind: 'invalid', code: 'template_rejected', message: 'WhatsApp rejected the template (not approved, paused, or wrong parameters).' };
  if (e.status >= 500 || [1, 2, 131000, 131016].includes(code)) return { kind: 'server', code: 'server_error', message: 'WhatsApp reported a temporary error.' };
  return { kind: 'invalid', code: e.code ? `whatsapp_${e.code}` : 'rejected', message: 'Check the message and try again.' };
}

// ------------------------------------------------------------------ webhooks
interface WaMessage {
  from?: string; id?: string; timestamp?: string; type?: string; text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string }; document?: { id?: string; filename?: string; mime_type?: string; caption?: string };
  audio?: { id?: string; mime_type?: string }; video?: { id?: string; mime_type?: string; caption?: string }; sticker?: { id?: string; mime_type?: string };
  button?: { text?: string }; interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } }; context?: { id?: string };
}
export interface WaStatus { id?: string; status?: string; timestamp?: string; recipient_id?: string; biz_opaque_callback_data?: string; pricing?: { billable?: boolean; pricing_model?: string; category?: string; type?: string }; errors?: Array<{ code?: number; title?: string }> }
interface WaValue { messaging_product?: string; metadata?: { phone_number_id?: string; display_phone_number?: string }; contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>; messages?: WaMessage[]; statuses?: WaStatus[] }

function eachValue(body: unknown, fn: (v: WaValue) => void): void {
  const b = (body && typeof body === 'object' ? body : {}) as { object?: string; entry?: Array<{ changes?: Array<{ field?: string; value?: WaValue }> }> };
  if (b.object !== 'whatsapp_business_account' || !Array.isArray(b.entry)) return;
  for (const e of b.entry) for (const c of e.changes ?? []) if (c.field === 'messages' && c.value) fn(c.value);
}

export function parseWhatsAppWebhook(body: unknown): InboundItem[] {
  const out: InboundItem[] = [];
  eachValue(body, (v) => {
    const phone = str(v.metadata?.phone_number_id);
    if (!phone) return;
    const names = new Map((v.contacts ?? []).map((c) => [String(c.wa_id ?? ''), c.profile?.name ?? null]));
    for (const m of v.messages ?? []) {
      if (!m.id || !m.from) continue;
      const media = m.image ?? m.document ?? m.audio ?? m.video ?? m.sticker;
      const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.image?.caption ?? m.document?.caption ?? m.video?.caption ?? '';
      out.push({
        type: 'message', accountId: phone, conversationKind: 'dm', threadKey: `wa:${m.from}`, externalId: m.id, parentExternalId: m.context?.id ?? null,
        direction: 'inbound', author: { externalId: m.from, name: names.get(m.from) ? clip(names.get(m.from), 200) : null, handle: `+${m.from}`.slice(0, 40) },
        text: clip(text), occurredAt: epochToIso(m.timestamp), relatedPostExternalId: null, subject: null,
        attachments: media?.id ? [{ type: clip(m.type, 20) || 'file', name: m.document?.filename ? clip(m.document.filename, 200) : null, size: null, providerRef: `media:${media.id}` }] : [],
        meta: { wa_type: clip(m.type, 20) },
      });
    }
    for (const s of v.statuses ?? []) {
      if (!s.id || !s.recipient_id) continue;
      if (s.status === 'delivered' || s.status === 'read') {
        out.push({ type: 'receipt', accountId: phone, threadKey: `wa:${s.recipient_id}`, kind: s.status, watermark: '1970-01-01T00:00:00.000Z', externalIds: [s.id] });
      }
    }
  });
  return out;
}

/** Status events with pricing / failures / Relay's callback marker (handled by the WhatsApp channel service). */
export function whatsAppStatuses(body: unknown): Array<WaStatus & { phoneNumberId: string }> {
  const out: Array<WaStatus & { phoneNumberId: string }> = [];
  eachValue(body, (v) => { const p = str(v.metadata?.phone_number_id); if (p) for (const s of v.statuses ?? []) out.push({ ...s, phoneNumberId: p }); });
  return out;
}

export function whatsAppReplyRules(i: ReplyRulesInput): ReplyRulesResult {
  if (i.kind !== 'dm' || i.mode !== 'private_message') return { allowed: false, code: 'mode_not_supported', message: 'WhatsApp conversations are private messages.' };
  if (!i.lastInboundAt) return { allowed: false, code: 'reply_window_closed', message: 'No customer message yet: only an approved template can start a conversation.' };
  const last = i.lastInboundAt.getTime();
  if (i.now.getTime() - last <= DAY) return { allowed: true, windowEndsAt: new Date(last + DAY).toISOString() };
  return { allowed: false, code: 'reply_window_closed', message: 'More than 24 hours since the customer last wrote. Send an approved template instead (charged by Meta).' };
}

/** The charge shown BEFORE sending (Meta per-message pricing; exact rates depend on the recipient's country). */
export function whatsAppCharge(input: { template: TemplateSend | null; windowOpen: boolean; rates?: Partial<Record<'marketing' | 'utility' | 'authentication', { amount: number; currency: string }>> | null }): { billable: boolean; category: string; estimate: { amount: number; currency: string } | null; note: string } {
  if (!input.template) return { billable: false, category: 'service', estimate: null, note: 'Free: a reply inside the 24-hour customer service window.' };
  const cat = input.template.category ?? 'marketing';
  if (cat === 'utility' && input.windowOpen) return { billable: false, category: 'utility', estimate: null, note: 'Free: a utility template inside the 24-hour customer service window.' };
  if (cat === 'service') return { billable: false, category: 'service', estimate: null, note: 'Free: a service message.' };
  const rate = input.rates?.[cat as 'marketing' | 'utility' | 'authentication'] ?? null;
  return { billable: true, category: cat, estimate: rate, note: `Charged by Meta per delivered message (${cat} rate for the recipient’s country).` };
}

function templateComponents(t: TemplateSend): unknown[] {
  return t.params.length ? [{ type: 'body', parameters: t.params.map((p) => ({ type: 'text', text: p.slice(0, 1000) })) }] : [];
}

export const whatsAppInboxAdapter: InboxAdapter = {
  kind: 'whatsapp',
  capability: () => WHATSAPP_CAPABILITY,
  missingPermissions(granted, connection) {
    if (connection.isMock) return [];
    const have = new Set(granted ?? []);
    return WHATSAPP_SCOPES.filter((s) => !have.has(s));
  },
  parseWebhook: parseWhatsAppWebhook,
  replyRules: whatsAppReplyRules,
  moderationActions: () => [],

  async sendReply(ctx, creds, conn, input): Promise<SendReplyResult> {
    const t = token(creds);
    if (!t) return { kind: 'rejected', code: 'no_credentials', message: 'No WhatsApp token is stored. Reconnect WhatsApp.', reconnect: true };
    const { phoneNumberId } = waIds(conn);
    const to = input.target.threadKey.startsWith('wa:') ? input.target.threadKey.slice(3) : null;
    if (!phoneNumberId || !to) return { kind: 'rejected', code: 'mode_not_supported', message: 'Unknown WhatsApp recipient.' };
    if (!input.template && input.text.length > 4096) return { kind: 'rejected', code: 'too_long', message: 'WhatsApp text messages are limited to 4,096 characters.' };
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, biz_opaque_callback_data: `relay-attempt:${input.attemptId}`,
      ...(input.template
        ? { type: 'template', template: { name: input.template.name, language: { code: input.template.language }, components: templateComponents(input.template) } }
        : { type: 'text', text: { preview_url: false, body: input.text } }),
    };
    try {
      const r = await call<{ messages?: Array<{ id?: string; message_status?: string }> }>(ctx, { method: 'POST', url: `${base(ctx)}/${phoneNumberId}/messages`, bearer: t, json: payload, op: 'whatsapp.send', publishes: true }, parseWhatsAppError);
      const m = r.data.messages?.[0];
      const id = str(m?.id);
      return id ? { kind: 'sent', externalId: id, detail: { status: r.status, message_status: str(m?.message_status) } } : { kind: 'unknown', code: 'no_id', message: 'WhatsApp accepted the message without an id. Waiting for its status webhook.' };
    } catch (err) {
      return replyFromError(err, classifyWhatsApp, 'WhatsApp', ctx.now().getTime());
    }
  },

  // There is no API to list sent WhatsApp messages: an Unknown send is confirmed by the status webhook carrying
  // Relay's callback marker (services/inbox/channels-whatsapp.ts). Lookups never guess.
  async findSent() { return { found: false }; },

  async listTemplates(ctx, creds, conn) {
    const t = token(creds);
    if (!t) return { ok: false, code: 'no_credentials', message: 'Reconnect WhatsApp.' };
    try {
      const r = await call<{ data?: Array<{ name?: string; language?: string; status?: string; category?: string; components?: Array<{ type?: string; text?: string; example?: { body_text?: unknown } }> }> }>(ctx,
        { method: 'GET', url: `${base(ctx)}/${waIds(conn).wabaId}/message_templates`, bearer: t, query: { fields: 'name,language,status,category,components', limit: '100' }, op: 'whatsapp.templates' }, parseWhatsAppError);
      const items: TemplateInfo[] = (r.data.data ?? []).filter((x) => x.name && x.language).map((x) => {
        const bodyC = x.components?.find((c) => c.type === 'BODY');
        const body = bodyC?.text ?? '';
        const cat = String(x.category ?? '').toLowerCase();
        // Meta returns sample values for positional parameters as example.body_text[[...]] (shown as field hints only).
        const ex = Array.isArray(bodyC?.example?.body_text) && Array.isArray((bodyC!.example!.body_text as unknown[])[0]) ? ((bodyC!.example!.body_text as unknown[][])[0]!).map((v) => String(v).slice(0, 60)) : undefined;
        return { name: String(x.name), language: String(x.language), status: String(x.status ?? 'UNKNOWN'), category: (['marketing', 'utility', 'authentication'].includes(cat) ? cat : null) as TemplateInfo['category'], body: body.slice(0, 1024), param_count: new Set(body.match(/\{\{\d+\}\}/g) ?? []).size, ...(ex?.length ? { examples: ex.slice(0, 20) } : {}) };
      });
      return { ok: true, items };
    } catch (err) {
      if (err instanceof TransportError) return { ok: false, code: 'network', message: 'WhatsApp could not be reached.' };
      if (err instanceof ProviderHttpError) return { ok: false, code: classifyWhatsApp(err, Date.now()).code, message: 'WhatsApp refused the template list.' };
      throw err;
    }
  },

  async resolveAttachment(ctx, creds, conn, input) {
    const t = token(creds);
    if (!t || !input.providerRef.startsWith('media:')) return { kind: 'error', code: 'no_reference', message: 'No media reference.' };
    try {
      const r = await call<{ url?: string; mime_type?: string; file_size?: number; data_base64?: string }>(ctx, { method: 'GET', url: `${base(ctx)}/${input.providerRef.slice(6)}`, bearer: t, op: 'whatsapp.media' }, parseWhatsAppError);
      if (conn.isMock && r.data.data_base64) return { kind: 'bytes', base64: r.data.data_base64, mime: r.data.mime_type ?? 'application/octet-stream', name: null };
      if (!r.data.url) return { kind: 'error', code: 'expired', message: 'WhatsApp no longer has this media (links expire).' };
      return { kind: 'url', url: r.data.url, headers: { authorization: `Bearer ${t}` }, allowHosts: ['lookaside.fbsbx.com'], mime: r.data.mime_type ?? null, name: null };
    } catch (err) {
      if (err instanceof TransportError) return { kind: 'error', code: 'network', message: 'WhatsApp could not be reached.' };
      if (err instanceof ProviderHttpError) return { kind: 'error', code: 'refused', message: 'WhatsApp refused the media lookup (it may have expired).' };
      throw err;
    }
  },
};

/** Verify a token + phone number before installing (setup page). */
export async function verifyWhatsAppNumber(ctx: AdapterContext, accessToken: string, phoneNumberId: string): Promise<{ ok: true; display: string; verifiedName: string | null } | { ok: false; code: string; message: string }> {
  try {
    const r = await call<{ display_phone_number?: string; verified_name?: string }>(ctx, { method: 'GET', url: `${base(ctx)}/${phoneNumberId}`, bearer: accessToken, query: { fields: 'display_phone_number,verified_name' }, op: 'whatsapp.phone_number' }, parseWhatsAppError);
    return { ok: true, display: str(r.data.display_phone_number) ?? phoneNumberId, verifiedName: str(r.data.verified_name) };
  } catch (err) {
    if (err instanceof TransportError) return { ok: false, code: 'network', message: 'WhatsApp could not be reached. Try again.' };
    if (err instanceof ProviderHttpError) { const c = classifyWhatsApp(err, Date.now()); return { ok: false, code: c.code, message: c.message }; }
    throw err;
  }
}

/** Phone numbers of a WABA (choose which ones become inbox channels). */
export async function listWhatsAppNumbers(ctx: AdapterContext, creds: ProviderCredentials, wabaId: string): Promise<{ ok: true; items: Array<{ id: string; display: string; name: string | null }> } | { ok: false; message: string }> {
  const t = token(creds);
  if (!t) return { ok: false, message: 'Reconnect WhatsApp.' };
  try {
    const r = await call<{ data?: Array<{ id?: string; display_phone_number?: string; verified_name?: string }> }>(ctx, { method: 'GET', url: `${base(ctx)}/${wabaId}/phone_numbers`, bearer: t, query: { fields: 'id,display_phone_number,verified_name' }, op: 'whatsapp.phone_numbers' }, parseWhatsAppError);
    return { ok: true, items: (r.data.data ?? []).filter((x) => x.id).map((x) => ({ id: String(x.id), display: str(x.display_phone_number) ?? String(x.id), name: str(x.verified_name) })) };
  } catch (err) {
    if (err instanceof TransportError || err instanceof ProviderHttpError) return { ok: false, message: 'WhatsApp refused or could not be reached.' };
    throw err;
  }
}
