// HubSpot (brief §5): CRM context + customer-care handover.
//  - Contacts are linked to Relay customers only by an explicit, audited action (exact-email search or a person's pick);
//    never by matching names or social handles. Links are reversible (connectors unlinkExternal). Linking says nothing
//    about marketing consent.
//  - Case → ticket through a durable sync job whose idempotency key is the case: repeated delivery creates ONE ticket
//    (AT5); the ticket description carries an origin token so an unknown create is reconciled, not repeated.
//  - Ticket stage/owner/priority are shown in Relay (snapshot); HubSpot never changes the Relay case state.
//  - Conversation summaries reach HubSpot only as a note a person approved (exact text previewed).
//  - Minimisation: contact name, masked email and company only.
import { createHash } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import type { HubspotContactJson, HubspotTicketJson, OutboundPreviewJson } from '@social-lite/core/contracts/v35-integrations';
import type { SyncOutcome } from '@social-lite/core/contracts/v35-connectors';
import { getPool, many, maybeOne, withTx } from '@social-lite/db';
import {
  HUBSPOT_HOSTS, HUBSPOT_PRIORITY, hubspotAddNote, hubspotAuthorizeUrl, hubspotCreateTicket, hubspotExchange, hubspotFindTicketByToken, hubspotGetContact, hubspotGetTicket,
  hubspotOriginToken, hubspotOwners, hubspotPipelines, hubspotRecordUrl, hubspotSearchContacts, hubspotTokenInfo, lastHubspotRate, type HubspotObject,
} from '@social-lite/providers/hubspot/client';
import { hubspotSim } from '@social-lite/providers/hubspot/sim';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { audit } from '../../audit.js';
import { assertUuid, brandAllowed, requireAction } from '../../tenancy.js';
import { enqueueSyncJob, loadIntegration, recordActivity, registerInboundHandler, registerSyncExecutor, upsertExternalLink, type IntegrationRow } from '../../connectors/index.js';
import { appErrorFrom, openConn, outcomeFromError, saveRateLimit } from '../core/runtime.js';
import { loadRelayObject } from '../core/relay-objects.js';
import type { Conn, HubAdapter } from '../core/types.js';

export const hubspotAdapter: HubAdapter = {
  connector: 'hubspot', hosts: HUBSPOT_HOSTS, sim: hubspotSim, connect: 'oauth', webhook: 'global',
  required: ['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET'], simSettings: { hub_id: '9000001' },
  capabilities: ['Find and link contacts (explicit)', 'Show permitted contact and company context', 'Create or link a ticket from a case', 'Map pipeline, stage, owner and priority', 'Add an approved conversation summary'],
  authorizeUrl: (cfg, p) => hubspotAuthorizeUrl({ clientId: cfg.values.HUBSPOT_CLIENT_ID!, redirectUri: cfg.redirectUri, state: p.state }),
  async exchange(t, cfg, p) {
    const tok = await hubspotExchange(t, { clientId: cfg.values.HUBSPOT_CLIENT_ID!, clientSecret: cfg.values.HUBSPOT_CLIENT_SECRET!, redirectUri: cfg.redirectUri, code: p.code });
    const info = await hubspotTokenInfo({ t, token: tok.accessToken });
    return { externalAccountId: info.hubId, displayName: `HubSpot · ${info.hubDomain ?? info.hubId}`, grantedScopes: info.scopes, creds: tok, settings: { hub_id: info.hubId },
      health: { status: 'active', message: `Connected to portal ${info.hubId}.` } };
  },
  async refresh(t, cfg, creds) {
    if (!creds.refreshToken) return null;
    return hubspotExchange(t, { clientId: cfg.values.HUBSPOT_CLIENT_ID!, clientSecret: cfg.values.HUBSPOT_CLIENT_SECRET!, redirectUri: cfg.redirectUri, refreshToken: creds.refreshToken });
  },
  async verify(c) {
    const info = await hubspotTokenInfo(c);
    await hubspotPipelines(c);
    if (lastHubspotRate) await saveRateLimit(c.integrationId, { remaining: lastHubspotRate.remaining, limit: lastHubspotRate.limit, reset_at: null, source: 'X-HubSpot-RateLimit headers' });
    const missing = ['tickets', 'crm.objects.contacts.read'].filter((s) => !info.scopes.includes(s));
    return missing.length ? { status: 'needs_attention', message: `Missing scopes: ${missing.join(', ')}.` } : { status: 'active', message: `Portal ${info.hubId} reachable.` };
  },
  async discover(c, p) {
    if (p.type === 'owner') return (await hubspotOwners(c)).map((o) => ({ resource_type: 'owner', external_id: o.id, name: o.name, url: null, selected: false }));
    return (await hubspotPipelines(c)).map((pl) => ({ resource_type: 'pipeline', external_id: pl.id, name: pl.label, url: null, detail: pl.stages.map((s) => `${s.id}:${s.label}`).join('|'), selected: false }));
  },
};

const hubId = (c: Pick<Conn, 'settings' | 'externalAccountId'>) => String(c.settings.hub_id ?? c.externalAccountId);
const maskEmail = (e: string | null | undefined) => {
  if (!e) return null;
  const [u, d] = e.split('@');
  return u && d ? `${u[0]}${'•'.repeat(Math.min(6, Math.max(1, u.length - 1)))}@${d}` : null;
};
const contactJson = (c: Conn, o: HubspotObject): HubspotContactJson => ({
  id: o.id, name: [o.properties.firstname, o.properties.lastname].filter(Boolean).join(' ') || 'Unnamed contact', email_masked: maskEmail(o.properties.email),
  company: o.properties.company ?? null, url: hubspotRecordUrl(hubId(c), '0-1', o.id),
});

async function hubspotFor(ctx: Ctx, integrationId: string, brandId: string | null, perm: 'integrations.read' | 'integrations.manage' = 'integrations.read'): Promise<IntegrationRow> {
  const integ = await loadIntegration(ctx, integrationId, perm);
  if (integ.connector !== 'hubspot') throw new AppError('validation_failed', 'Choose a HubSpot integration.');
  if (brandId && integ.brand_id && integ.brand_id !== brandId) throw notFound('Integration');
  return integ;
}

// ------------------------------------------------------------------ contacts
export const contactSearchSchema = z.object({ integration_id: z.string().uuid(), email: z.string().email().max(200).optional(), query: z.string().min(2).max(100).optional() }).strict()
  .refine((v) => !!v.email !== !!v.query, 'Search by exact email or by text');

export async function searchHubspotContacts(ctx: Ctx, input: z.infer<typeof contactSearchSchema>): Promise<{ items: HubspotContactJson[] }> {
  const integ = await hubspotFor(ctx, input.integration_id, null);
  requireAction(ctx, 'inbox.read', integ.brand_id ? { brandId: integ.brand_id } : undefined);
  const c = await openConn(integ.id);
  try { return { items: (await hubspotSearchContacts(c, { email: input.email, query: input.query })).map((o) => contactJson(c, o)) }; } catch (err) { throw await appErrorFrom(err, c); }
}

export const linkContactSchema = z.object({ integration_id: z.string().uuid(), customer_id: z.string().uuid(), contact_id: z.string().min(1).max(40) }).strict();

/** Explicit, audited link of a Relay customer to a HubSpot contact (reversible via DELETE /api/connectors/links/:id). */
export async function linkHubspotContact(ctx: Ctx, input: z.infer<typeof linkContactSchema>) {
  const cust = await maybeOne<{ id: string; brand_id: string | null }>(getPool(), `SELECT id, brand_id FROM inbox_customers WHERE id=$1 AND workspace_id=$2`, [input.customer_id, ctx.access.workspaceId]);
  if (!cust || (cust.brand_id && !brandAllowed(ctx, cust.brand_id))) throw notFound('Customer');
  requireAction(ctx, 'cases.manage', cust.brand_id ? { brandId: cust.brand_id } : undefined);
  const integ = await hubspotFor(ctx, input.integration_id, cust.brand_id);
  const c = await openConn(integ.id);
  let contact: HubspotObject;
  try { contact = await hubspotGetContact(c, input.contact_id); } catch (err) { throw await appErrorFrom(err, c); }
  const link = await withTx(async (tx) => {
    const l = await upsertExternalLink(tx, { workspaceId: ctx.access.workspaceId, brandId: cust.brand_id, integrationId: integ.id, relayType: 'customer', relayId: cust.id,
      externalType: 'contact', externalId: contact.id, externalUrl: hubspotRecordUrl(hubId(c), '0-1', contact.id), actorUserId: ctx.actor.userId });
    await tx.query(`INSERT INTO external_link_snapshots(link_id, workspace_id, data) VALUES ($1,$2,$3) ON CONFLICT (link_id) DO UPDATE SET data=EXCLUDED.data, fetched_at=now(), fetch_error=NULL`,
      [l.id, ctx.access.workspaceId, JSON.stringify(contactJson(c, contact))]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: cust.brand_id, actorUserId: ctx.actor.userId, action: 'integration.contact_linked', resourceType: 'customer', resourceId: cust.id,
      diff: { connector: 'hubspot', contact_id: contact.id, basis: 'explicit_link' }, correlationId: ctx.correlationId });
    return l;
  });
  return { link_id: link.id, contact: contactJson(c, contact), consent: 'not_established' as const };
}

/** Linked contact for a customer (stored snapshot; refresh=true reads HubSpot now). */
export async function customerCrmContext(ctx: Ctx, customerId: string, refresh = false): Promise<{ link_id: string; integration_id: string; contact: HubspotContactJson; fetched_at: string } | null> {
  assertUuid(customerId, 'Customer');
  const l = await maybeOne<{ id: string; integration_id: string; external_id: string; brand_id: string | null; data: HubspotContactJson | null; fetched_at: Date | null }>(getPool(),
    `SELECT l.id, l.integration_id, l.external_id, l.brand_id, s.data, s.fetched_at FROM external_links l JOIN integration_connections i ON i.id=l.integration_id
       LEFT JOIN external_link_snapshots s ON s.link_id=l.id
      WHERE l.workspace_id=$1 AND l.relay_type='customer' AND l.relay_id=$2 AND l.external_type='contact' AND l.status='linked' AND i.connector='hubspot' LIMIT 1`, [ctx.access.workspaceId, customerId]);
  if (!l || (l.brand_id && !brandAllowed(ctx, l.brand_id))) return null;
  requireAction(ctx, 'inbox.read', l.brand_id ? { brandId: l.brand_id } : undefined);
  await loadIntegration(ctx, l.integration_id, 'integrations.read');
  if (refresh || !l.data) {
    const c = await openConn(l.integration_id);
    try {
      const contact = contactJson(c, await hubspotGetContact(c, l.external_id));
      await getPool().query(`INSERT INTO external_link_snapshots(link_id, workspace_id, data) VALUES ($1,$2,$3) ON CONFLICT (link_id) DO UPDATE SET data=EXCLUDED.data, fetched_at=now(), fetch_error=NULL`, [l.id, ctx.access.workspaceId, JSON.stringify(contact)]);
      return { link_id: l.id, integration_id: l.integration_id, contact, fetched_at: new Date().toISOString() };
    } catch (err) { throw await appErrorFrom(err, c); }
  }
  return { link_id: l.id, integration_id: l.integration_id, contact: l.data, fetched_at: (l.fetched_at ?? new Date()).toISOString() };
}

// ------------------------------------------------------------------ tickets
export const ticketSchema = z.object({
  integration_id: z.string().uuid(), case_id: z.string().uuid(), pipeline: z.string().max(40).optional(), stage: z.string().max(40).optional(), owner_id: z.string().max(40).nullable().optional(),
  contact_id: z.string().max(40).nullable().optional(), subject: z.string().trim().min(1).max(200).optional(),
}).strict();

async function ticketRequest(ctx: Ctx, input: z.infer<typeof ticketSchema>) {
  const obj = await loadRelayObject(ctx, 'case', input.case_id);
  const integ = await hubspotFor(ctx, input.integration_id, obj.brandId);
  const cs = await maybeOne<{ number: string; title: string; priority: 'low' | 'normal' | 'high' | 'urgent'; customer_id: string | null }>(getPool(),
    `SELECT c.number::text, c.title, c.priority,
            (SELECT il.customer_id FROM inbox_conversations v JOIN inbox_identity_links il ON il.contact_id=v.contact_id AND il.unlinked_at IS NULL
              WHERE v.case_id=c.id ORDER BY il.linked_at DESC LIMIT 1) AS customer_id
       FROM care_cases c WHERE c.id=$1`, [obj.id]);
  if (!cs) throw notFound('Case');
  let contactId = input.contact_id ?? null;
  if (contactId === null && input.contact_id === undefined && cs.customer_id) {
    contactId = (await maybeOne<{ external_id: string }>(getPool(), `SELECT external_id FROM external_links WHERE integration_id=$1 AND relay_type='customer' AND relay_id=$2 AND external_type='contact' AND status='linked'`, [integ.id, cs.customer_id]))?.external_id ?? null;
  }
  const s = integ.settings as { default_pipeline?: string; default_stage?: string };
  const pipeline = input.pipeline ?? s.default_pipeline ?? '0';
  const stage = input.stage ?? s.default_stage ?? null;
  if (!stage) throw new AppError('validation_failed', 'Choose a ticket stage (or set a default in HubSpot settings).', { stage: 'Required' });
  return { obj, integ, subject: input.subject ?? `Case #${cs.number}: ${cs.title}`.slice(0, 200), priority: HUBSPOT_PRIORITY[cs.priority], pipeline, stage, owner: input.owner_id ?? null, contactId };
}

export async function previewHubspotTicket(ctx: Ctx, input: z.infer<typeof ticketSchema>): Promise<OutboundPreviewJson> {
  const r = await ticketRequest(ctx, input);
  return { connector: 'hubspot', destination: `HubSpot ticket · pipeline ${r.pipeline}`, fields: [
    { label: 'Subject', value: r.subject }, { label: 'Description', value: `Relay case link (sign-in required): ${r.obj.url}` }, { label: 'Stage', value: r.stage },
    { label: 'Priority', value: r.priority }, ...(r.owner ? [{ label: 'Owner', value: r.owner }] : []), ...(r.contactId ? [{ label: 'Associated contact', value: r.contactId }] : []),
  ], excluded: ['Customer messages', 'Internal notes', 'Attachments'] };
}

/** One ticket per case: the job's idempotency key is the case, so repeated requests/deliveries return the same job. */
export async function createHubspotTicket(ctx: Ctx, input: z.infer<typeof ticketSchema>) {
  const r = await ticketRequest(ctx, input);
  const existing = await maybeOne<{ id: string; external_id: string; external_url: string | null }>(getPool(),
    `SELECT id, external_id, external_url FROM external_links WHERE integration_id=$1 AND relay_type='case' AND relay_id=$2 AND external_type='ticket' AND status <> 'unlinked'`, [r.integ.id, r.obj.id]);
  if (existing) return { job: null, link: existing, created: false };
  const { job, created } = await enqueueSyncJob(ctx, { integrationId: r.integ.id, kind: 'hubspot.ticket', relayType: 'case', relayId: r.obj.id,
    payload: { subject: r.subject, url: r.obj.url, pipeline: r.pipeline, stage: r.stage, priority: r.priority, owner: r.owner, contact_id: r.contactId } });
  return { job, link: null, created };
}

async function runTicket(job: { id: string; workspaceId: string; integrationId: string; payload: Record<string, unknown>; originMarker: string }): Promise<SyncOutcome> {
  const p = job.payload as { subject: string; url: string; pipeline: string; stage: string; priority: string; owner: string | null; contact_id: string | null };
  let c: Conn;
  try { c = await openConn(job.integrationId); } catch (err) { return outcomeFromError(err, { integrationId: job.integrationId, workspaceId: job.workspaceId }, false); }
  try {
    const t = await hubspotCreateTicket(c, { contactId: p.contact_id, properties: {
      subject: p.subject, content: `Relay case (sign-in required): ${p.url}\n\n[${hubspotOriginToken(job.id)}]`, hs_pipeline: p.pipeline, hs_pipeline_stage: p.stage, hs_ticket_priority: p.priority,
      ...(p.owner ? { hubspot_owner_id: p.owner } : {}),
    } });
    if (lastHubspotRate) await saveRateLimit(c.integrationId, { remaining: lastHubspotRate.remaining, limit: lastHubspotRate.limit, reset_at: null, source: 'X-HubSpot-RateLimit headers' });
    return { kind: 'succeeded', externalId: t.id, externalUrl: hubspotRecordUrl(hubId(c), '0-5', t.id), result: { stage: p.stage } };
  } catch (err) { return outcomeFromError(err, c, true); }
}

async function reconcileTicket(job: { id: string; integrationId: string }) {
  const c = await openConn(job.integrationId);
  const t = await hubspotFindTicketByToken(c, hubspotOriginToken(job.id));
  return t ? { found: true as const, externalId: t.id, externalUrl: hubspotRecordUrl(hubId(c), '0-5', t.id) } : { found: false as const };
}

/** Ticket linked to a case (+ stored snapshot; refresh=true reads HubSpot now). */
export async function caseTicket(ctx: Ctx, caseId: string, refresh = false): Promise<{ link_id: string | null; job: { id: string; state: string; last_error: string | null } | null; ticket: HubspotTicketJson | null }> {
  const obj = await loadRelayObject(ctx, 'case', caseId, 'integrations.read');
  const l = await maybeOne<{ id: string; integration_id: string; external_id: string; external_url: string | null; status: string; data: HubspotTicketJson | null; fetched_at: Date | null }>(getPool(),
    `SELECT l.id, l.integration_id, l.external_id, l.external_url, l.status, s.data, s.fetched_at FROM external_links l JOIN integration_connections i ON i.id=l.integration_id
       LEFT JOIN external_link_snapshots s ON s.link_id=l.id WHERE l.workspace_id=$1 AND l.relay_type='case' AND l.relay_id=$2 AND l.external_type='ticket' AND l.status <> 'unlinked' AND i.connector='hubspot' LIMIT 1`,
    [ctx.access.workspaceId, obj.id]);
  const job = await maybeOne<{ id: string; state: string; last_error: string | null }>(getPool(),
    `SELECT j.id, j.state, j.last_error FROM integration_sync_jobs j WHERE j.workspace_id=$1 AND j.kind='hubspot.ticket' AND j.relay_id=$2 ORDER BY j.created_at DESC LIMIT 1`, [ctx.access.workspaceId, obj.id]);
  if (!l) return { link_id: null, job, ticket: null };
  if ((refresh || !l.data) && l.status === 'linked') {
    try { return { link_id: l.id, job, ticket: await refreshTicketSnapshot(l.id, l.integration_id, l.external_id, ctx.access.workspaceId) }; } catch (err) {
      if (refresh) throw await appErrorFrom(err, { integrationId: l.integration_id, workspaceId: ctx.access.workspaceId });
    }
  }
  return { link_id: l.id, job, ticket: l.data ?? { id: l.external_id, subject: '', pipeline: null, stage: null, priority: null, owner: null, url: l.external_url, fetched_at: null } };
}

async function refreshTicketSnapshot(linkId: string, integrationId: string, ticketId: string, workspaceId: string): Promise<HubspotTicketJson> {
  const c = await openConn(integrationId, { allowPaused: true });
  try {
    const t = await hubspotGetTicket(c, ticketId);
    const pipelines = await hubspotPipelines(c).catch(() => []);
    const pl = pipelines.find((p) => p.id === t.properties.hs_pipeline);
    const owners = t.properties.hubspot_owner_id ? await hubspotOwners(c).catch(() => []) : [];
    const json: HubspotTicketJson = { id: t.id, subject: t.properties.subject ?? '', pipeline: pl?.label ?? t.properties.hs_pipeline ?? null, stage: pl?.stages.find((s) => s.id === t.properties.hs_pipeline_stage)?.label ?? t.properties.hs_pipeline_stage ?? null,
      priority: t.properties.hs_ticket_priority ?? null, owner: owners.find((o) => o.id === t.properties.hubspot_owner_id)?.name ?? t.properties.hubspot_owner_id ?? null, url: hubspotRecordUrl(hubId(c), '0-5', t.id), fetched_at: new Date().toISOString() };
    await getPool().query(`INSERT INTO external_link_snapshots(link_id, workspace_id, data) VALUES ($1,$2,$3) ON CONFLICT (link_id) DO UPDATE SET data=EXCLUDED.data, fetched_at=now(), fetch_error=NULL`, [linkId, workspaceId, JSON.stringify(json)]);
    await getPool().query(`UPDATE external_links SET last_synced_at=now(), status='linked', status_detail=NULL WHERE id=$1`, [linkId]);
    return json;
  } catch (err) {
    if ((err as { kind?: string }).kind === 'not_found') await getPool().query(`UPDATE external_links SET status='unavailable', status_detail='The ticket was deleted or is no longer accessible.', updated_at=now() WHERE id=$1`, [linkId]);
    throw err;
  }
}

// ------------------------------------------------------------------ approved summary → ticket note
export const noteSchema = z.object({ case_id: z.string().uuid(), text: z.string().trim().min(1).max(4000), approved: z.literal(true) }).strict();

/** The exact text a person reviewed and approved goes to the ticket as a note (one note per distinct text). */
export async function addHubspotNote(ctx: Ctx, input: z.infer<typeof noteSchema>) {
  const obj = await loadRelayObject(ctx, 'case', input.case_id);
  const l = await maybeOne<{ integration_id: string; external_id: string }>(getPool(),
    `SELECT l.integration_id, l.external_id FROM external_links l JOIN integration_connections i ON i.id=l.integration_id WHERE l.workspace_id=$1 AND l.relay_type='case' AND l.relay_id=$2 AND l.external_type='ticket' AND l.status='linked' AND i.connector='hubspot'`,
    [ctx.access.workspaceId, obj.id]);
  if (!l) throw new AppError('invalid_state', 'Create or link a HubSpot ticket first.');
  const digest = createHash('sha256').update(input.text).digest('hex').slice(0, 24);
  return enqueueSyncJob(ctx, { integrationId: l.integration_id, kind: 'hubspot.add_note', relayType: 'case', relayId: obj.id, idempotencyKey: `hubspot.note:${obj.id}:${digest}`, payload: { ticket_id: l.external_id, text: input.text } });
}

async function runNote(job: { workspaceId: string; integrationId: string; payload: Record<string, unknown> }): Promise<SyncOutcome> {
  let c: Conn;
  try { c = await openConn(job.integrationId); } catch (err) { return outcomeFromError(err, { integrationId: job.integrationId, workspaceId: job.workspaceId }, false); }
  try {
    const n = await hubspotAddNote(c, String(job.payload.ticket_id), String(job.payload.text));
    return { kind: 'succeeded', result: { note_id: n.id } };
  } catch (err) { return outcomeFromError(err, c, true); }
}

export async function setHubspotDefaults(ctx: Ctx, integrationId: string, input: { default_pipeline: string; default_stage: string }) {
  const integ = await hubspotFor(ctx, integrationId, null, 'integrations.manage');
  if (!/^[\w-]{1,40}$/.test(input.default_pipeline) || !/^[\w-]{1,40}$/.test(input.default_stage)) throw new AppError('validation_failed', 'Choose a pipeline and stage.');
  await getPool().query(`UPDATE integration_connections SET settings = settings || $2::jsonb, updated_at=now() WHERE id=$1`, [integ.id, JSON.stringify(input)]);
  await audit(getPool(), { workspaceId: integ.workspace_id, brandId: integ.brand_id, actorUserId: ctx.actor.userId, action: 'integration.configured', resourceType: 'integration', resourceId: integ.id, diff: input, correlationId: ctx.correlationId });
  return { ok: true };
}

export function registerHubspot(): void {
  registerSyncExecutor({ kind: 'hubspot.ticket', run: runTicket, reconcile: reconcileTicket });
  registerSyncExecutor({ kind: 'hubspot.add_note', run: runNote });
  // v3 app webhooks arrive on the global URL (portalId identifies the account): ticket changes refresh the snapshot;
  // deletions mark the link unavailable. The Relay case itself is never changed by HubSpot.
  registerInboundHandler({
    connector: 'hubspot',
    async handle(e) {
      const events = Array.isArray(e.body) ? e.body as Array<{ portalId?: number; objectId?: number | string; subscriptionType?: string }> : [];
      let n = 0;
      for (const ev of events) {
        if (!ev.subscriptionType?.startsWith('ticket.') || ev.objectId === undefined) continue;
        const links = await many<{ id: string; integration_id: string; workspace_id: string }>(getPool(),
          `SELECT l.id, l.integration_id, l.workspace_id FROM external_links l JOIN integration_connections i ON i.id=l.integration_id
            WHERE i.connector='hubspot' AND i.external_account_id=$1 AND i.disconnected_at IS NULL AND l.external_type='ticket' AND l.external_id=$2 AND l.status <> 'unlinked'`, [String(ev.portalId ?? ''), String(ev.objectId)]);
        for (const l of links) {
          if (ev.subscriptionType === 'ticket.deletion') {
            await getPool().query(`UPDATE external_links SET status='unavailable', status_detail='The ticket was deleted in HubSpot.', updated_at=now() WHERE id=$1`, [l.id]);
          } else {
            await refreshTicketSnapshot(l.id, l.integration_id, String(ev.objectId), l.workspace_id).catch(async (err) => {
              await recordActivity(getPool(), { workspaceId: l.workspace_id, integrationId: l.integration_id, kind: 'webhook', outcome: 'error', code: 'snapshot_failed', message: (err as Error).name });
            });
          }
          n++;
        }
      }
      return { outcome: n ? 'processed' : 'ignored', detail: `${n} linked ticket(s)` };
    },
  });
}
