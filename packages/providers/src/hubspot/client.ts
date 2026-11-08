// HubSpot CRM API client (V3.5 stream C). Docs checked 2026-11-08: developers.hubspot.com/docs/api/oauth-quickstart-guide
// (app.hubspot.com/oauth/authorize, api.hubapi.com/oauth/v1/token, 30-minute access tokens + refresh),
// CRM v3 objects (contacts/search, tickets create/get/search, notes + associations), pipelines, owners, v3 webhooks.
// Minimisation: only the properties listed below are requested; emails are masked before leaving the service layer.
// Rate limits: X-HubSpot-RateLimit-Remaining / -Max headers when present.
import { apiError, form, parseJson, type BizResponse, type BizTransport } from '../biz/transport.js';

export const HUBSPOT_API = 'https://api.hubapi.com';
export const HUBSPOT_AUTHORIZE = 'https://app.hubspot.com/oauth/authorize';
export const HUBSPOT_SCOPES = ['crm.objects.contacts.read', 'crm.objects.companies.read', 'tickets', 'crm.objects.owners.read'] as const;
export const HUBSPOT_HOSTS = ['api.hubapi.com'] as const;
/** HubSpot-defined association type ids (v4 associations): ticket→contact 16, note→ticket 228. */
export const ASSOC_TICKET_TO_CONTACT = 16;
export const ASSOC_NOTE_TO_TICKET = 228;
export const CONTACT_PROPS = ['firstname', 'lastname', 'email', 'company'] as const;
export const TICKET_PROPS = ['subject', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority', 'hubspot_owner_id', 'content'] as const;

export interface HubspotCall { t: BizTransport; token: string }
export interface HubspotObject { id: string; properties: Record<string, string | null>; updatedAt?: string }
export interface HubspotRate { remaining: number | null; limit: number | null }
export let lastHubspotRate: HubspotRate | null = null;

async function call<T>(c: HubspotCall, method: 'GET' | 'POST' | 'PATCH', path: string, op: string, body?: unknown): Promise<T> {
  const res = await c.t.send({ method, url: `${HUBSPOT_API}${path}`, op, mutating: method !== 'GET' && !op.endsWith('.search'),
    headers: { authorization: `Bearer ${c.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  observe(res);
  const j = parseJson<T & { message?: string; category?: string }>(res.body);
  if (res.status >= 200 && res.status < 300 && j) return j;
  throw apiError(res, `HubSpot: ${(j?.message ?? `HTTP ${res.status}`).slice(0, 160)}`, j?.category ?? null);
}

function observe(res: BizResponse) {
  const rem = res.headers['x-hubspot-ratelimit-remaining'];
  const max = res.headers['x-hubspot-ratelimit-max'];
  if (rem || max) lastHubspotRate = { remaining: rem ? Number(rem) : null, limit: max ? Number(max) : null };
}

export function hubspotAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  return `${HUBSPOT_AUTHORIZE}?${new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, state: p.state, scope: HUBSPOT_SCOPES.join(' ') })}`;
}

export async function hubspotExchange(t: BizTransport, p: { clientId: string; clientSecret: string; redirectUri: string; code?: string; refreshToken?: string }): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: string | null }> {
  const res = await t.send({ method: 'POST', url: `${HUBSPOT_API}/oauth/v1/token`, op: 'hubspot.oauth.token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(p.refreshToken ? { grant_type: 'refresh_token', client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, refresh_token: p.refreshToken }
      : { grant_type: 'authorization_code', client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, code: p.code }) });
  const j = parseJson<{ access_token?: string; refresh_token?: string; expires_in?: number }>(res.body);
  if (res.status !== 200 || !j?.access_token) throw apiError(res, 'HubSpot: token request was refused');
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? p.refreshToken ?? null, expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000).toISOString() : null };
}

/** Token metadata: portal (hub) id and granted scopes. */
export async function hubspotTokenInfo(c: HubspotCall): Promise<{ hubId: string; hubDomain: string | null; scopes: string[] }> {
  const j = await call<{ hub_id: number; hub_domain?: string; scopes?: string[] }>(c, 'GET', `/oauth/v1/access-tokens/${encodeURIComponent(c.token)}`, 'hubspot.oauth.info');
  return { hubId: String(j.hub_id), hubDomain: j.hub_domain ?? null, scopes: j.scopes ?? [] };
}

export const hubspotPipelines = (c: HubspotCall) =>
  call<{ results: Array<{ id: string; label: string; stages: Array<{ id: string; label: string }> }> }>(c, 'GET', '/crm/v3/pipelines/tickets', 'hubspot.pipelines.list').then((r) => r.results);

export const hubspotOwners = (c: HubspotCall) =>
  call<{ results: Array<{ id: string; firstName?: string; lastName?: string }> }>(c, 'GET', '/crm/v3/owners?limit=100', 'hubspot.owners.list')
    .then((r) => r.results.map((o) => ({ id: o.id, name: [o.firstName, o.lastName].filter(Boolean).join(' ') || `Owner ${o.id}` })));

/** Exact-email search (a reliable identifier) or free-text query; linking is always an explicit choice. */
export async function hubspotSearchContacts(c: HubspotCall, q: { email?: string; query?: string }): Promise<HubspotObject[]> {
  const body = q.email
    ? { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: q.email }] }], properties: CONTACT_PROPS, limit: 10 }
    : { query: q.query ?? '', properties: CONTACT_PROPS, limit: 10 };
  return (await call<{ results: HubspotObject[] }>(c, 'POST', '/crm/v3/objects/contacts/search', 'hubspot.contacts.search', body)).results;
}

export const hubspotGetContact = (c: HubspotCall, id: string) => call<HubspotObject>(c, 'GET', `/crm/v3/objects/contacts/${encodeURIComponent(id)}?properties=${CONTACT_PROPS.join(',')}`, 'hubspot.contacts.get');

export async function hubspotCreateTicket(c: HubspotCall, p: { properties: Record<string, string>; contactId: string | null }): Promise<HubspotObject> {
  return call<HubspotObject>(c, 'POST', '/crm/v3/objects/tickets', 'hubspot.tickets.create', {
    properties: p.properties,
    ...(p.contactId ? { associations: [{ to: { id: p.contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC_TICKET_TO_CONTACT }] }] } : {}),
  });
}

export const hubspotGetTicket = (c: HubspotCall, id: string) => call<HubspotObject>(c, 'GET', `/crm/v3/objects/tickets/${encodeURIComponent(id)}?properties=${TICKET_PROPS.join(',')}`, 'hubspot.tickets.get');
export const hubspotUpdateTicket = (c: HubspotCall, id: string, properties: Record<string, string>) => call<HubspotObject>(c, 'PATCH', `/crm/v3/objects/tickets/${encodeURIComponent(id)}`, 'hubspot.tickets.update', { properties });

/** Reconcile an unknown create: the ticket description carries the origin token. */
export async function hubspotFindTicketByToken(c: HubspotCall, token: string): Promise<HubspotObject | null> {
  const r = await call<{ results: HubspotObject[] }>(c, 'POST', '/crm/v3/objects/tickets/search', 'hubspot.tickets.search',
    { filterGroups: [{ filters: [{ propertyName: 'content', operator: 'CONTAINS_TOKEN', value: token }] }], properties: TICKET_PROPS, limit: 5 });
  return r.results[0] ?? null;
}

export async function hubspotAddNote(c: HubspotCall, ticketId: string, text: string): Promise<HubspotObject> {
  return call<HubspotObject>(c, 'POST', '/crm/v3/objects/notes', 'hubspot.notes.create', {
    properties: { hs_note_body: text, hs_timestamp: new Date().toISOString() },
    associations: [{ to: { id: ticketId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC_NOTE_TO_TICKET }] }],
  });
}

export const hubspotRecordUrl = (hubId: string, objectTypeId: '0-1' | '0-5', id: string) => `https://app.hubspot.com/contacts/${hubId}/record/${objectTypeId}/${id}`;

/** Relay priority → HubSpot hs_ticket_priority. */
export const HUBSPOT_PRIORITY: Record<'low' | 'normal' | 'high' | 'urgent', string> = { low: 'LOW', normal: 'MEDIUM', high: 'HIGH', urgent: 'HIGH' };

/** Origin token safe for CONTAINS_TOKEN search (no separators): relay + job id without dashes. */
export const hubspotOriginToken = (jobId: string) => `relay${jobId.replace(/-/g, '')}`;
