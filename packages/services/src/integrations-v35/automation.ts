// Executors for stream E's automation actions (packages/services/src/automation/rules.ts INTEGRATION_ACTIONS). The
// automation engine enqueues `enqueueSyncJob` with these kinds, relay type case|conversation, and a minimal payload
// { source:'relay_automation', rule, category, link, brand_id } — never customer messages. Each executor maps that onto
// the same domain behaviour as the UI:
//  - asana.create_task / monday.create_item → an external task in the installation's single selected project/board
//    (or settings.automation_resource_id), with a safe summary + Relay link;
//  - hubspot.create_ticket → the case's ONE ticket (shared with the UI's hubspot.ticket; conversations need a case);
//  - slack.post_message → a minimal alert to this installation's channels routed for care escalations (deduplicated);
//  - mailchimp.create_campaign_draft → deliberately NOT registered: drafts come only from approved posts and stream E's
//    automation subjects are cases/conversations (content.approved is not a trigger yet), so it stays "Not available yet".
// External status never approves/publishes anything; no executor sends customer content.
import { randomUUID } from 'node:crypto';
import type { SyncOutcome } from '@social-lite/core/contracts/v35-connectors';
import { getPool, maybeOne, many, withTx } from '@social-lite/db';
import { hubspotCreateTicket, hubspotFindTicketByToken, hubspotOriginToken, hubspotRecordUrl, HUBSPOT_PRIORITY } from '@social-lite/providers/hubspot/client';
import { registerSyncExecutor, upsertExternalLink } from '../connectors/index.js';
import { baseUrl, openConn, outcomeFromError } from './core/runtime.js';
import { TASK_PROVIDERS } from './work/providers.js';
import { enqueueSlackEvent } from './slack/service.js';
import type { Conn } from './core/types.js';

type Job = { id: string; workspaceId: string; integrationId: string; relayType: string; relayId: string; payload: Record<string, unknown>; originMarker: string };
const safe = (s: unknown, n = 120) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, n);

async function subject(job: Job): Promise<{ brandId: string | null; title: string; path: string } | null> {
  if (job.relayType === 'case') {
    const c = await maybeOne<{ brand_id: string; number: string; title: string }>(getPool(), `SELECT brand_id, number::text, title FROM care_cases WHERE id=$1 AND workspace_id=$2`, [job.relayId, job.workspaceId]);
    return c ? { brandId: c.brand_id, title: `Case #${c.number}: ${c.title}`, path: `/inbox?case=${job.relayId}` } : null;
  }
  if (job.relayType === 'conversation') {
    const c = await maybeOne<{ brand_id: string; name: string }>(getPool(), `SELECT c.brand_id, ch.display_name AS name FROM inbox_conversations c JOIN inbox_channels ch ON ch.id=c.channel_id WHERE c.id=$1 AND c.workspace_id=$2`, [job.relayId, job.workspaceId]);
    return c ? { brandId: c.brand_id, title: `${c.name} conversation`, path: `/inbox?c=${job.relayId}` } : null;
  }
  return null;
}

async function runTask(job: Job, connector: 'asana' | 'monday'): Promise<SyncOutcome> {
  const s = await subject(job);
  if (!s) return { kind: 'failed', code: 'not_found', message: 'The case or conversation no longer exists.' };
  const integ = await maybeOne<{ brand_id: string | null; settings: Record<string, unknown> }>(getPool(), `SELECT brand_id, settings FROM integration_connections WHERE id=$1`, [job.integrationId]);
  if (integ?.brand_id && integ.brand_id !== s.brandId) return { kind: 'failed', code: 'scope', message: 'This integration belongs to another brand.' };
  const targets = await many<{ id: string; external_id: string }>(getPool(),
    `SELECT id, external_id FROM integration_resources WHERE integration_id=$1 AND resource_type IN ('project','board') AND selected AND access_state='ok' ORDER BY name`, [job.integrationId]);
  const pref = typeof integ?.settings.automation_resource_id === 'string' ? targets.find((t) => t.id === integ.settings.automation_resource_id) : undefined;
  const target = pref ?? (targets.length === 1 ? targets[0] : undefined);
  if (!target) return { kind: 'failed', code: 'destination_required', message: targets.length ? 'Several projects/boards are selected; choose one for automations.' : 'Select a project or board for this integration first.' };
  // One task per automation job (the job's own idempotency key prevents duplicates on repeated delivery).
  const key = `automation:${job.id}`;
  let row = await maybeOne<{ id: string; external_id: string | null }>(getPool(), `SELECT id, external_id FROM integration_tasks WHERE workspace_id=$1 AND idempotency_key=$2`, [job.workspaceId, key]);
  if (row?.external_id) return { kind: 'succeeded', result: { task_id: row.id, external_id: row.external_id, already: true } };
  const title = `${safe(job.payload.rule, 60) || 'Relay automation'}: ${s.title}`.slice(0, 255);
  const description = `${s.title}${job.payload.category ? `\nCategory: ${safe(job.payload.category, 40)}` : ''}\n\nOpen in Relay (sign-in required): ${baseUrl()}${s.path}\n— Created by a Relay automation`;
  if (!row) {
    const id = randomUUID();
    await getPool().query(
      `INSERT INTO integration_tasks(id, workspace_id, brand_id, integration_id, connector, relay_type, relay_id, resource_id, title, description, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
      [id, job.workspaceId, s.brandId, job.integrationId, connector, job.relayType, job.relayId, target.id, title, description, key]);
    row = { id, external_id: null };
  }
  let c: Conn;
  try { c = await openConn(job.integrationId); } catch (err) { return outcomeFromError(err, job, false); }
  const prov = TASK_PROVIDERS[connector];
  try {
    const existing = await prov.findByMarker(c, target.external_id, job.originMarker, {});   // safe re-run after a lost response
    const t = existing ?? await prov.create(c, { resource: target.external_id, title, description, dueOn: null, priority: 'normal', status: 'open', assignee: null, marker: job.originMarker, columns: {} });
    await getPool().query(`UPDATE integration_tasks SET external_id=$2, external_url=$3, link_state='linked', synced_relay_version=relay_version, external_status=$4, last_pulled_at=now(), updated_at=now() WHERE id=$1`,
      [row.id, t.id, t.url, t.status_label]);
    return { kind: 'succeeded', result: { task_id: row.id, external_id: t.id, external_url: t.url } };
  } catch (err) { return outcomeFromError(err, c, true); }
}

async function runTicket(job: Job): Promise<SyncOutcome> {
  if (job.relayType !== 'case') return { kind: 'failed', code: 'case_required', message: 'HubSpot tickets are created from cases. Create a case first.' };
  const existing = await maybeOne<{ external_id: string }>(getPool(),
    `SELECT external_id FROM external_links WHERE integration_id=$1 AND relay_type='case' AND relay_id=$2 AND external_type='ticket' AND status <> 'unlinked'`, [job.integrationId, job.relayId]);
  if (existing) return { kind: 'succeeded', result: { ticket_id: existing.external_id, already: true } };
  const cs = await maybeOne<{ brand_id: string; number: string; title: string; priority: 'low' | 'normal' | 'high' | 'urgent' }>(getPool(),
    `SELECT brand_id, number::text, title, priority FROM care_cases WHERE id=$1 AND workspace_id=$2`, [job.relayId, job.workspaceId]);
  if (!cs) return { kind: 'failed', code: 'not_found', message: 'The case no longer exists.' };
  const integ = await maybeOne<{ settings: { default_pipeline?: string; default_stage?: string } }>(getPool(), `SELECT settings FROM integration_connections WHERE id=$1`, [job.integrationId]);
  if (!integ?.settings.default_stage) return { kind: 'failed', code: 'stage_required', message: 'Set a default ticket pipeline and stage in HubSpot settings.' };
  let c: Conn;
  try { c = await openConn(job.integrationId); } catch (err) { return outcomeFromError(err, job, false); }
  const token = hubspotOriginToken(job.id);
  try {
    const t = (await hubspotFindTicketByToken(c, token)) ?? await hubspotCreateTicket(c, { contactId: null, properties: {
      subject: `Case #${cs.number}: ${cs.title}`.slice(0, 200), content: `Relay case (sign-in required): ${baseUrl()}/inbox?case=${job.relayId}\n\n[${token}]`,
      hs_pipeline: integ.settings.default_pipeline ?? '0', hs_pipeline_stage: integ.settings.default_stage, hs_ticket_priority: HUBSPOT_PRIORITY[cs.priority],
    } });
    const hub = String(c.settings.hub_id ?? c.externalAccountId);
    await withTx((tx) => upsertExternalLink(tx, { workspaceId: job.workspaceId, brandId: cs.brand_id, integrationId: job.integrationId, relayType: 'case', relayId: job.relayId, externalType: 'ticket', externalId: t.id, externalUrl: hubspotRecordUrl(hub, '0-5', t.id) }));
    return { kind: 'succeeded', result: { ticket_id: t.id } };
  } catch (err) { return outcomeFromError(err, c, true); }
}

async function runSlack(job: Job): Promise<SyncOutcome> {
  const s = await subject(job);
  if (!s) return { kind: 'failed', code: 'not_found', message: 'The case or conversation no longer exists.' };
  const n = await enqueueSlackEvent({ workspaceId: job.workspaceId, integrationId: job.integrationId, category: 'care_escalations', eventKey: `automation:${job.id}`, brandId: s.brandId,
    text: `${safe(job.payload.rule, 80) || 'Automation'}: ${job.relayType === 'case' ? s.title.split(':')[0] : 'conversation needs attention'}`, linkPath: s.path, referenceType: job.relayType, referenceId: job.relayId });
  const already = await maybeOne(getPool(), `SELECT 1 FROM slack_deliveries WHERE integration_id=$1 AND event_key=$2`, [job.integrationId, `automation:${job.id}`]);
  if (!n && !already) return { kind: 'failed', code: 'no_route', message: 'No Slack channel of this integration receives care escalations.' };
  // Queued for the Slack sender (quiet hours, rate limits, retries, delivery history apply).
  return { kind: 'succeeded', result: { deliveries_queued: n } };
}

export function registerAutomationExecutors(): void {
  registerSyncExecutor({ kind: 'asana.create_task', run: (j) => runTask(j, 'asana') });
  registerSyncExecutor({ kind: 'monday.create_item', run: (j) => runTask(j, 'monday') });
  registerSyncExecutor({ kind: 'hubspot.create_ticket', run: runTicket });
  registerSyncExecutor({ kind: 'slack.post_message', run: runSlack });
}
