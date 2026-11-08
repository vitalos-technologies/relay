// Simulated WhatsApp Cloud API for SIMULATED WhatsApp installations (mock_ WABA ids) — V3.5 stream B. Served only via
// the inbox mock transport (inbox-registry.ts). Objects live in the durable mock store (provider tag 'facebook').
// Simulation choices (not provider facts): three fixed templates; error codes follow the Cloud API error reference
// (131047 outside the window, 132001 template missing, 132000 parameter mismatch, 130429 rate limit, 190 token).
import type { HttpRequest, HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv } from '../transport/mock.js';
import { parseJson } from '../shared/http.js';

const DAY = 86_400_000;
const P = 'facebook' as const;

export const SIMULATED_TEMPLATES = [
  { name: 'order_update', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, there is an update on order {{2}}. Reply here if you have questions.' }] },
  { name: 'we_miss_you', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi {{1}}, it has been a while. Reply to this message and we will help.' }] },
  { name: 'support_follow_up', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, following up on your support request. Reply to continue.' }] },
  { name: 'old_promo', language: 'en', status: 'PAUSED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Old promotion.' }] },
];

const err = (status: number, code: number, message: string) => json(status, { error: { message, type: 'OAuthException', code, fbtrace_id: 'mock_trace' } });
const once = async (env: FakeEnv, k: string) => (await env.store.incr(`wa:${env.accountId}:${k}:${env.scenario}`)) === 1;

export const simulatedPhoneNumberId = (wabaId: string) => `${wabaId}_pn1`;

export async function whatsAppFake(req: HttpRequest, env: FakeEnv): Promise<HttpResponse | null> {
  const u = new URL(req.url);
  if (u.hostname !== 'graph.facebook.com') return null;
  const m = /^\/v\d+\.\d+\/(.+)$/.exec(u.pathname);
  if (!m) return null;
  const [first, edge] = m[1]!.split('/');
  const waba = env.accountId;
  const phone = simulatedPhoneNumberId(waba);
  const auth = req.headers?.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return err(401, 190, 'Invalid OAuth access token.');
  if (env.scenario === 'revoked') return err(401, 190, 'Error validating access token: The session has been invalidated.');

  if (first === waba && edge === 'phone_numbers' && req.method === 'GET') {
    return json(200, { data: [{ id: phone, display_phone_number: '+44 7700 900123', verified_name: 'Relay Coffee (simulated)' }] });
  }
  if (first === phone && !edge && req.method === 'GET') return json(200, { id: phone, display_phone_number: '+44 7700 900123', verified_name: 'Relay Coffee (simulated)' });
  if (first === waba && edge === 'message_templates' && req.method === 'GET') return json(200, { data: SIMULATED_TEMPLATES });
  if (first?.startsWith('mock_wamedia_') && !edge && req.method === 'GET') {
    const o = await env.store.get(P, first);
    if (!o) return err(404, 100, 'Media not found');
    return json(200, { id: first, mime_type: o.data.mime ?? 'image/png', data_base64: o.data.base64 ?? Buffer.from('simulated media').toString('base64') });
  }

  if (first === phone && edge === 'messages' && req.method === 'POST') {
    const b = parseJson(typeof req.body === 'string' ? req.body : '') as { to?: string; type?: string; text?: { body?: string }; template?: { name?: string; language?: { code?: string }; components?: Array<{ parameters?: unknown[] }> }; biz_opaque_callback_data?: string; messaging_product?: string };
    if (b.messaging_product !== 'whatsapp' || !b.to) return err(400, 100, 'Invalid parameter');
    if (env.scenario === 'missing_permission') return err(403, 10, 'Application does not have permission for this action');
    if (env.scenario === 'fail_permanent') return err(400, 131026, 'Message undeliverable');
    if (env.scenario === 'rate_limited_once' && await once(env, 'rate')) return err(429, 130429, 'Rate limit hit');
    if (env.scenario === 'fail_transient_once' && await once(env, 'transient')) return err(500, 131000, 'Something went wrong');
    const now = env.now();
    let text: string;
    let template: string | null = null;
    if (b.type === 'text') {
      text = String(b.text?.body ?? '');
      if (!text) return err(400, 100, 'text.body is required');
      const inbound = (await env.store.list(P, waba, 'wa_msg')).filter((o) => o.data.wa_id === b.to && o.data.from === 'user');
      const last = inbound.length ? Math.max(...inbound.map((o) => Date.parse(String(o.data.at)))) : 0;
      if (now.getTime() - last > DAY) return err(400, 131047, 'Re-engagement message: more than 24 hours have passed since the recipient last replied.');
    } else if (b.type === 'template') {
      const t = SIMULATED_TEMPLATES.find((x) => x.name === b.template?.name && x.language === b.template?.language?.code);
      if (!t || t.status !== 'APPROVED') return err(400, 132001, 'Template name does not exist in the translation');
      const want = new Set(t.components[0]!.text.match(/\{\{\d+\}\}/g) ?? []).size;
      const params = (b.template?.components?.[0]?.parameters ?? []) as Array<{ text?: string }>;
      if (params.length !== want) return err(400, 132000, 'Number of parameters does not match the expected number of params');
      text = t.components[0]!.text.replace(/\{\{(\d+)\}\}/g, (_s, n: string) => String(params[Number(n) - 1]?.text ?? ''));
      template = t.name;
    } else return err(400, 131051, 'Unsupported message type');
    const id = env.newId('mock_wamid_');
    await env.store.put({ provider: P, accountId: waba, objectId: id, kind: 'wa_msg', createdAt: now.toISOString(), data: { wa_id: b.to, text, from: 'business', at: now.toISOString(), template, callback: b.biz_opaque_callback_data ?? null } });
    if (env.scenario === 'timeout_after_send' && await once(env, 'timeout')) lostResponse();
    return json(200, { messaging_product: 'whatsapp', contacts: [{ input: b.to, wa_id: b.to }], messages: [{ id, message_status: 'accepted' }] });
  }
  return null;
}

/** Record a simulated customer message so the fake knows the customer service window (simulator only). */
export async function recordSimulatedWhatsApp(env: Pick<FakeEnv, 'store'>, wabaId: string, item: { id: string; waId: string; text: string; at: string; media?: { id: string; mime: string; base64: string } | null }): Promise<void> {
  if (!wabaId.startsWith('mock_')) throw new Error('simulated inbound is only for mock_ accounts');
  await env.store.put({ provider: P, accountId: wabaId, objectId: item.id, kind: 'wa_msg', createdAt: item.at, data: { wa_id: item.waId, text: item.text, from: 'user', at: item.at } });
  if (item.media) await env.store.put({ provider: P, accountId: wabaId, objectId: item.media.id, kind: 'wa_media', createdAt: item.at, data: { mime: item.media.mime, base64: item.media.base64 } });
}

/** Messages the simulated business sent (status-webhook simulation + tests). */
export async function simulatedWhatsAppSent(env: Pick<FakeEnv, 'store'>, wabaId: string): Promise<Array<{ id: string; waId: string; text: string; template: string | null; callback: string | null; at: string }>> {
  return (await env.store.list(P, wabaId, 'wa_msg')).filter((o) => o.data.from === 'business')
    .map((o) => ({ id: o.objectId, waId: String(o.data.wa_id), text: String(o.data.text), template: (o.data.template as string | null) ?? null, callback: (o.data.callback as string | null) ?? null, at: String(o.data.at) }));
}
