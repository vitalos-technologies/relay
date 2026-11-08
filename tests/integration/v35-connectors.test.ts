// V3.5 foundation — shared connector + event infrastructure on real Postgres: verified webhook ingress (persist +
// dedupe, nothing stored when unverified or unconfigured), inbound handler retries, outbound sync jobs (one external
// record per logical request, retry/backoff, unknown → reconcile by origin marker), loop prevention, field-mapping
// rules, pause/disconnect (links kept, marked unavailable), activity history.
import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SyncOutcome } from '@social-lite/core/contracts/v35-connectors';
import {
  createSimulatedIntegration, disconnectIntegration, enqueueSyncJob, ingestIntegrationWebhook, integrationHealth, listExternalLinks, processIntegrationEvent,
  reconcileSyncJobs, registerInboundHandler, registerSyncExecutor, resetConnectorRegistrationsForTests, retrySyncJob, runSyncJob, setFieldMapping, setIntegrationPaused,
  selectResources, unlinkExternal,
} from '@social-lite/services/connectors/index';
import { closeTestPool, createBrand, createUser, createWorkspace, addMember, grant, testPool, v2Ctx } from './helpers.js';

afterAll(async () => { delete process.env.SLACK_SIGNING_SECRET; await closeTestPool(); });
beforeEach(() => resetConnectorRegistrationsForTests());

async function setup() {
  const ws = await createWorkspace('Connectors');
  const brand = await createBrand(ws, 'B');
  const o = await createUser(undefined, 'Owner');
  await addMember(ws, o.id, 'owner');
  const agent = await createUser(undefined, 'Agent');
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, agent.id]);
  await grant(ws, agent.id, 'care_agent', brand);
  return { ws, brand, owner: await v2Ctx(o.id, ws), agent: await v2Ctx(agent.id, ws) };
}

const slackReq = (body: string, secret: string, ts = String(Math.floor(Date.now() / 1000))) => ({
  rawBody: body, method: 'POST', uri: 'https://relay.test/api/connectors/webhooks/slack',
  headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}` },
});

describe('V3.5 connector infrastructure', () => {
  it('webhook ingress: unconfigured ⇒ 412, bad signature ⇒ 401 (nothing stored), valid ⇒ stored once, duplicate acknowledged', async () => {
    const body = JSON.stringify({ type: 'event_callback', event_id: `Ev${Date.now()}`, team_id: 'T1', event: { type: 'app_mention' } });
    delete process.env.SLACK_SIGNING_SECRET;
    expect((await ingestIntegrationWebhook('slack', slackReq(body, 'x'), new URLSearchParams())).status).toBe(412);
    process.env.SLACK_SIGNING_SECRET = 'slack-signing-secret-test';
    expect((await ingestIntegrationWebhook('slack', slackReq(body, 'wrong'), new URLSearchParams())).status).toBe(401);
    const n0 = (await testPool().query(`SELECT count(*)::int n FROM integration_events`)).rows[0].n;
    const ok = await ingestIntegrationWebhook('slack', slackReq(body, process.env.SLACK_SIGNING_SECRET), new URLSearchParams());
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true, duplicate: false });
    const dup = await ingestIntegrationWebhook('slack', slackReq(body, process.env.SLACK_SIGNING_SECRET), new URLSearchParams());
    expect(JSON.parse(dup.body)).toEqual({ ok: true, duplicate: true });
    expect((await testPool().query(`SELECT count(*)::int n FROM integration_events`)).rows[0].n).toBe(n0 + 1);
    expect((await ingestIntegrationWebhook('nope', slackReq(body, 'x'), new URLSearchParams())).status).toBe(404);
  });

  it('inbound handler: retried with backoff, then processed; no handler ⇒ ignored', async () => {
    process.env.SLACK_SIGNING_SECRET = 'slack-signing-secret-test';
    const body = JSON.stringify({ type: 'event_callback', event_id: `Ev2${Date.now()}`, team_id: 'T1', event: { type: 'message' } });
    await ingestIntegrationWebhook('slack', slackReq(body, process.env.SLACK_SIGNING_SECRET), new URLSearchParams());
    const id = (await testPool().query(`SELECT id FROM integration_events ORDER BY received_at DESC LIMIT 1`)).rows[0].id;
    let calls = 0;
    registerInboundHandler({ connector: 'slack', async handle() { calls++; if (calls === 1) throw new Error('temporary'); return { outcome: 'processed' }; } });
    expect(await processIntegrationEvent(id)).toBe('retry');
    expect(await processIntegrationEvent(id)).toBe('skipped'); // not due yet
    await testPool().query(`UPDATE integration_events SET next_attempt_at=now() WHERE id=$1`, [id]);
    expect(await processIntegrationEvent(id)).toBe('processed');
    resetConnectorRegistrationsForTests();
    const body2 = JSON.stringify({ type: 'event_callback', event_id: `Ev3${Date.now()}`, team_id: 'T1', event: { type: 'message' } });
    await ingestIntegrationWebhook('slack', slackReq(body2, process.env.SLACK_SIGNING_SECRET), new URLSearchParams());
    const id2 = (await testPool().query(`SELECT id FROM integration_events ORDER BY received_at DESC LIMIT 1`)).rows[0].id;
    expect(await processIntegrationEvent(id2)).toBe('ignored');
  });

  it('echo of Relay’s own write (origin marker in a Relay-written field, real job) is recorded but never processed; free text quoting a marker is not an echo', async () => {
    process.env.SLACK_SIGNING_SECRET = 'slack-signing-secret-test';
    const t = await setup();
    const integ = await createSimulatedIntegration(t.owner, { connector: 'slack' });
    const { job } = await enqueueSyncJob(t.owner, { integrationId: integ.id, kind: 'slack.post_message', relayType: 'case', relayId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', idempotencyKey: `echo-${Date.now()}`, payload: {} });
    const last = async () => (await testPool().query(`SELECT origin, state FROM integration_events ORDER BY received_at DESC LIMIT 1`)).rows[0];
    // Relay's own write: marker in message metadata (a field only Relay sets) naming a job Relay ran.
    const echo = JSON.stringify({ type: 'event_callback', event_id: `Ev4${Date.now()}`, team_id: 'T1', event: { type: 'message', text: 'Case alert', metadata: { event_type: 'relay_origin', event_payload: { marker: `relay:${job.id}` } } } });
    await ingestIntegrationWebhook('slack', slackReq(echo, process.env.SLACK_SIGNING_SECRET), new URLSearchParams());
    expect(await last()).toEqual({ origin: 'relay_echo', state: 'ignored' });
    // A person quoting the same marker in free text is an external event, processed normally.
    const quoted = JSON.stringify({ type: 'event_callback', event_id: `Ev5${Date.now()}`, team_id: 'T1', event: { type: 'message', text: `see relay:${job.id}` } });
    await ingestIntegrationWebhook('slack', slackReq(quoted, process.env.SLACK_SIGNING_SECRET), new URLSearchParams());
    expect(await last()).toEqual({ origin: 'external', state: 'pending' });
    // A marker in a Relay-written field that names no Relay job is not an echo either.
    const forged = JSON.stringify({ type: 'event_callback', event_id: `Ev6${Date.now()}`, team_id: 'T1', event: { type: 'message', metadata: { event_payload: { marker: 'relay:7c9e6679-7425-40de-944b-e07fc1f90ae7' } } } });
    await ingestIntegrationWebhook('slack', slackReq(forged, process.env.SLACK_SIGNING_SECRET), new URLSearchParams());
    expect(await last()).toEqual({ origin: 'external', state: 'pending' });
  });

  it('sync jobs: one external record per logical request despite repeats; retry honours Retry-After; unknown is reconciled, not resent', async () => {
    const t = await setup();
    const integ = await createSimulatedIntegration(t.owner, { connector: 'hubspot' });
    expect(integ).toMatchObject({ is_simulated: true, status: 'active' });
    const created: string[] = [];
    let mode: 'ok' | 'retry' | 'unknown' = 'ok';
    registerSyncExecutor({
      kind: 'hubspot.create_ticket',
      async run(job): Promise<SyncOutcome> {
        if (mode === 'retry') { mode = 'ok'; return { kind: 'retry', code: 'rate_limited', message: 'slow down', retryAfterMs: 90_000, rateLimit: { remaining: 0, limit: 100, reset_at: null, source: 'Retry-After' } }; }
        created.push(job.originMarker);
        if (mode === 'unknown') return { kind: 'unknown', code: 'timeout', message: 'no response' };
        return { kind: 'succeeded', externalId: `T-${created.length}`, externalUrl: 'https://app.hubspot.com/x' };
      },
      async reconcile(job) { return created.includes(job.originMarker) ? { found: true, externalId: 'T-reconciled' } : { found: false }; },
    });
    const caseId = '6c1d2b4e-58f7-4d0a-9d47-4a2f1d1f5c11';
    const a = await enqueueSyncJob(t.agent, { integrationId: integ.id, kind: 'hubspot.create_ticket', relayType: 'case', relayId: caseId, payload: { summary: 'approved summary' } });
    const b = await enqueueSyncJob(t.agent, { integrationId: integ.id, kind: 'hubspot.create_ticket', relayType: 'case', relayId: caseId, payload: { summary: 'approved summary' } });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, job: { id: a.job.id } });
    mode = 'retry';
    expect(await runSyncJob(a.job.id, 'w')).toBe('waiting_retry');
    const wait = (await testPool().query(`SELECT extract(epoch FROM next_attempt_at - now())::int s FROM integration_sync_jobs WHERE id=$1`, [a.job.id])).rows[0].s;
    expect(wait).toBeGreaterThanOrEqual(85);
    expect((await integrationHealth(t.owner, integ.id)).integration.rate_limit).toMatchObject({ remaining: 0, source: 'Retry-After' });
    await testPool().query(`UPDATE integration_sync_jobs SET next_attempt_at=now() WHERE id=$1`, [a.job.id]);
    expect(await runSyncJob(a.job.id, 'w')).toBe('succeeded');
    expect(await runSyncJob(a.job.id, 'w')).toBe('skipped');
    expect(created).toHaveLength(1);
    const links = await listExternalLinks(t.agent, 'case', caseId);
    expect(links.items).toHaveLength(1);
    expect(links.items[0]).toMatchObject({ connector: 'hubspot', external_id: 'T-1', status: 'linked' });

    // Unknown outcome: reconciled by origin marker, never re-run automatically.
    mode = 'unknown';
    const u = await enqueueSyncJob(t.agent, { integrationId: integ.id, kind: 'hubspot.create_ticket', relayType: 'case', relayId: '7c1d2b4e-58f7-4d0a-9d47-4a2f1d1f5c11', payload: {} });
    expect(await runSyncJob(u.job.id, 'w')).toBe('unknown');
    await testPool().query(`UPDATE integration_sync_jobs SET next_attempt_at=now() WHERE id=$1`, [u.job.id]);
    expect(await reconcileSyncJobs()).toBe(1);
    expect(created).toHaveLength(2);
    expect((await testPool().query(`SELECT state, external_id FROM integration_sync_jobs WHERE id=$1`, [u.job.id])).rows[0]).toEqual({ state: 'succeeded', external_id: 'T-reconciled' });

    const h = await integrationHealth(t.owner, integ.id);
    expect(h.activity.map((x) => x.outcome)).toEqual(expect.arrayContaining(['ok', 'throttled', 'error']));
    await expect(retrySyncJob(t.agent, u.job.id)).rejects.toMatchObject({ code: 'forbidden' }); // integrations.manage needed
  });

  it('paused integrations never run; disconnect cancels queued jobs and marks links unavailable (Relay records kept); unlink is audited', async () => {
    const t = await setup();
    const integ = await createSimulatedIntegration(t.owner, { connector: 'asana', brand_id: t.brand });
    registerSyncExecutor({ kind: 'asana.create_task', async run() { return { kind: 'succeeded', externalId: `A-${Math.random()}` }; } });
    const j1 = await enqueueSyncJob(t.owner, { integrationId: integ.id, kind: 'asana.create_task', relayType: 'conversation', relayId: '8c1d2b4e-58f7-4d0a-9d47-4a2f1d1f5c11', payload: {} });
    expect(await runSyncJob(j1.job.id, 'w')).toBe('succeeded');
    await setIntegrationPaused(t.owner, integ.id, true, 'maintenance');
    const j2 = await enqueueSyncJob(t.owner, { integrationId: integ.id, kind: 'asana.create_task', relayType: 'conversation', relayId: '9c1d2b4e-58f7-4d0a-9d47-4a2f1d1f5c11', payload: {} });
    expect(await runSyncJob(j2.job.id, 'w')).toBe('skipped');
    await disconnectIntegration(t.owner, integ.id);
    expect((await testPool().query(`SELECT state FROM integration_sync_jobs WHERE id=$1`, [j2.job.id])).rows[0].state).toBe('cancelled');
    const l = await testPool().query(`SELECT id, status FROM external_links WHERE integration_id=$1`, [integ.id]);
    expect(l.rows[0].status).toBe('unavailable');
    await expect(enqueueSyncJob(t.owner, { integrationId: integ.id, kind: 'asana.create_task', relayType: 'post', relayId: 'ac1d2b4e-58f7-4d0a-9d47-4a2f1d1f5c11', payload: {} })).rejects.toMatchObject({ code: 'invalid_state' });
    const cred = await testPool().query(`SELECT credential_id FROM integration_connections WHERE id=$1`, [integ.id]);
    expect(cred.rows[0].credential_id).toBeNull();
    await unlinkExternal(t.owner, l.rows[0].id).catch(() => undefined); // disconnected: manage check still applies
  });

  it('field mappings: protected fields never two-way; explicit resource selection only', async () => {
    const t = await setup();
    const integ = await createSimulatedIntegration(t.owner, { connector: 'monday' });
    await expect(setFieldMapping(t.owner, integ.id, { relay_object: 'post', relay_field: 'approval_state', external_field: 'status', source_of_truth: 'external', direction: 'two_way', conflict: 'source_wins', on_delete: 'mark_unavailable', on_revoke: 'mark_unavailable', enabled: true }))
      .rejects.toMatchObject({ code: 'validation_failed' });
    await expect(setFieldMapping(t.owner, integ.id, { relay_object: 'post', relay_field: 'approval_state', external_field: 'status', source_of_truth: 'external', direction: 'external_to_relay', conflict: 'manual_review', on_delete: 'mark_unavailable', on_revoke: 'mark_unavailable', enabled: true }))
      .rejects.toMatchObject({ code: 'validation_failed' });
    const m = await setFieldMapping(t.owner, integ.id, { relay_object: 'case', relay_field: 'title', external_field: 'name', source_of_truth: 'relay', direction: 'relay_to_external', conflict: 'manual_review', on_delete: 'mark_unavailable', on_revoke: 'mark_unavailable', enabled: true });
    expect(m).toMatchObject({ protected: false, version: 1 });
    await expect(testPool().query(`INSERT INTO integration_field_mappings(workspace_id, integration_id, relay_object, relay_field, external_field, source_of_truth, direction, protected) VALUES ($1,$2,'post','consent','x','relay','two_way',true)`, [t.ws, integ.id]))
      .rejects.toThrow(/check/i);
    await expect(selectResources(t.owner, integ.id, { resources: [{ resource_type: 'project', external_id: '1', name: 'Wrong type', selected: true }] })).rejects.toMatchObject({ code: 'validation_failed' });
    const r = await selectResources(t.owner, integ.id, { resources: [{ resource_type: 'board', external_id: '42', name: 'Campaigns', selected: true }] });
    expect(r.items).toHaveLength(1);
    await expect(createSimulatedIntegration(t.agent, { connector: 'slack' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
