// Simulated HubSpot API (mock_ installations only). Mirrors the endpoints hubspot/client.ts calls.
import { sjson, type SimEnv, type SimHandler, type SimStore } from '../biz/sim.js';

const err = (status: number, message: string, category = 'VALIDATION_ERROR') => sjson(status, { status: 'error', message, category });

async function seed(env: SimEnv) {
  if (await env.get('meta', 'seeded')) return;
  await env.put('meta', 'seeded', { at: env.now().toISOString() });
  await env.put('contact', 'mock_c_101', { firstname: 'Cara', lastname: 'Customer', email: 'cara.customer@example.com', company: 'Example Bakery' });
  await env.put('contact', 'mock_c_102', { firstname: 'Dev', lastname: 'Patel', email: 'dev.patel@example.org', company: null });
}

const rate = { 'x-hubspot-ratelimit-remaining': '98', 'x-hubspot-ratelimit-max': '100' };
const obj = (id: string, properties: Record<string, unknown>, updatedAt?: unknown) => ({ id, properties, updatedAt: updatedAt ?? new Date().toISOString() });

export const hubspotSim: SimHandler = async (req, env) => {
  await seed(env);
  const p = req.url.pathname;
  const body = req.body && req.headers['content-type']?.includes('json') ? JSON.parse(req.body) as Record<string, unknown> : {};
  if (p === '/oauth/v1/token') return sjson(200, { access_token: `mock_at_${env.newId('')}`, refresh_token: 'mock_rt', expires_in: 1800 });
  if (p.startsWith('/oauth/v1/access-tokens/')) return sjson(200, { hub_id: 9_000_001, hub_domain: 'simulated.hubspot.test', scopes: ['crm.objects.contacts.read', 'crm.objects.companies.read', 'tickets', 'crm.objects.owners.read'] });
  if (p === '/crm/v3/pipelines/tickets') return sjson(200, { results: [{ id: '0', label: 'Support pipeline', stages: [{ id: '1', label: 'New' }, { id: '2', label: 'Waiting on contact' }, { id: '3', label: 'Waiting on us' }, { id: '4', label: 'Closed' }] }] }, rate);
  if (p === '/crm/v3/owners') return sjson(200, { results: [{ id: '501', firstName: 'Morgan', lastName: '(simulated)' }, { id: '502', firstName: 'Taylor', lastName: '(simulated)' }] }, rate);
  if (p === '/crm/v3/objects/contacts/search') {
    const all = await env.list('contact');
    const f = (body.filterGroups as Array<{ filters: Array<{ value: string }> }> | undefined)?.[0]?.filters[0]?.value?.toLowerCase();
    const q = String(body.query ?? '').toLowerCase();
    const hit = all.filter((c) => (f ? String(c.data.email).toLowerCase() === f : q.length >= 2 && Object.values(c.data).some((v) => String(v ?? '').toLowerCase().includes(q))));
    return sjson(200, { total: hit.length, results: hit.map((c) => obj(c.id, c.data)) }, rate);
  }
  const cm = /^\/crm\/v3\/objects\/contacts\/([^/]+)$/.exec(p);
  if (cm) { const c = await env.get('contact', cm[1]!); return c ? sjson(200, obj(cm[1]!, c), rate) : err(404, 'Object not found', 'OBJECT_NOT_FOUND'); }
  if (p === '/crm/v3/objects/tickets' && req.method === 'POST') {
    const props = (body.properties ?? {}) as Record<string, string>;
    if (!props.subject || !props.hs_pipeline_stage) return err(400, 'Property values were not valid: subject and hs_pipeline_stage are required');
    const id = env.newId('mock_t_');
    await env.put('ticket', id, { ...props, associations: body.associations ?? [] });
    return sjson(201, obj(id, props), rate);
  }
  if (p === '/crm/v3/objects/tickets/search') {
    const token = (body.filterGroups as Array<{ filters: Array<{ value: string }> }>)[0]!.filters[0]!.value;
    const hit = (await env.list('ticket')).filter((t) => String(t.data.content ?? '').includes(token));
    return sjson(200, { total: hit.length, results: hit.map((t) => obj(t.id, t.data)) }, rate);
  }
  const tm = /^\/crm\/v3\/objects\/tickets\/([^/]+)$/.exec(p);
  if (tm) {
    const t = await env.get('ticket', tm[1]!);
    if (!t || t.archived) return err(404, 'Object not found', 'OBJECT_NOT_FOUND');
    if (req.method === 'PATCH') { const next = { ...t, ...(body.properties as object) }; await env.put('ticket', tm[1]!, next); return sjson(200, obj(tm[1]!, next), rate); }
    const { associations: _a, ...props } = t;
    return sjson(200, obj(tm[1]!, props), rate);
  }
  if (p === '/crm/v3/objects/notes' && req.method === 'POST') { const id = env.newId('mock_n_'); await env.put('note', id, body); return sjson(201, obj(id, body.properties as Record<string, unknown>), rate); }
  return err(404, `simulated HubSpot: no route ${req.method} ${p}`);
};

/** Simulate a stage change in HubSpot (for demos/tests). Returns the v3 webhook body HubSpot would send. */
export async function hubspotSimStageChange(store: SimStore, accountId: string, ticketId: string, stage: string): Promise<string> {
  const t = await store.get('hubspot', accountId, 'ticket', ticketId);
  if (!t) throw new Error('unknown simulated ticket');
  await store.put('hubspot', accountId, 'ticket', ticketId, { ...t, hs_pipeline_stage: stage });
  return JSON.stringify([{ eventId: Math.floor(Math.random() * 1e9), subscriptionId: 1, portalId: 9000001, occurredAt: Date.now(), subscriptionType: 'ticket.propertyChange', attemptNumber: 0, objectId: ticketId, propertyName: 'hs_pipeline_stage', propertyValue: stage, changeSource: 'CRM_UI' }]);
}
