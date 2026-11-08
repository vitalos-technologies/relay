// V3.5 stream C — seven business integrations on real Postgres through the REAL policy path (v2Ctx), simulated
// provider transports (mock_ installations) and locally signed webhook fixtures. Brief §22 acceptance tests 5, 6, 7,
// 8, 9, 13 (+ OAuth state/authority, needs-app-setup honesty, GBP local posts through scheduling/approval, Pub/Sub OIDC).
import { createHmac, generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMock } from '@social-lite/services/connections/index';
import { createCase, enableChannel, listConversations, simulateInbound } from '@social-lite/services/inbox/index';
import {
  enqueueSyncJob, ingestIntegrationWebhook, processIntegrationEvent, reconcileSyncJobs, runSyncJob, selectResources, setFieldMapping,
} from '@social-lite/services/connectors/index';
import {
  addHubspotNote, caseTicket, collectSlackAlerts, confirmSlackLink, connectWithOperatorCredentials, createExternalTask, createHubspotTicket, createSimulatedHubInstallation,
  discoverResources, dispatchDueGbpPosts, enqueueSlackEvent, exportToMailchimp, getExternalTask, handleIntegrationOAuthCallback, hubOverview, linkHubspotContact, listGbpLocalPosts,
  listGbpLocations, listSlackDeliveries, mailchimpExportsForPost, previewTask, pullTask, quietMinutesLeft, requestGbpLocalPosts, saveSlackRoute, sendSlackDeliveries,
  setGoogleJwksForTests, setSimScenario, startIntegrationOAuth, translate, updateExternalTask, updateTranslationSettings, verifyPubsubPush, diagnoseIntegration, getTranslationSettings,
  searchHubspotContacts, previewMailchimpExport,
} from '@social-lite/services/integrations-v35/index';
import { DbSimStore } from '@social-lite/services/integrations-v35/core/sim-store';
import { asanaSimExternalEdit } from '@social-lite/providers/asana/sim';
import { mondaySimExternalEdit } from '@social-lite/providers/monday/sim';
import { approve, createPost, publishNow, submitForReview, type Ctx } from '@social-lite/services';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';
import { seedConnections } from './engine-helpers.js';

const db = () => testPool();
const store = new DbSimStore();
afterAll(async () => { setGoogleJwksForTests(null); await closeTestPool(); });
beforeAll(() => { db(); });

async function member(ws: string, role: string, brandId?: string, name = 'Member') {
  const u = await createUser(undefined, name);
  await db().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, u.id]);
  await grant(ws, u.id, role, brandId);
  return u;
}

const draftFor = (text: string, ids: string[]) => ({ baseText: text, baseLink: null, baseAssetIds: [] as string[], variants: ids.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) });

async function world(opts: { approvalRequired?: boolean } = {}) {
  const ws = await createWorkspace('Integrations');
  const brand = await createBrand(ws, 'Harbour Café', { approvalRequired: opts.approvalRequired });
  const o = await createUser(undefined, 'Olive Owner');
  await addMember(ws, o.id, 'owner');
  const agent = await member(ws, 'care_agent', brand, 'Ann Agent');
  const owner = await v2Ctx(o.id, ws, { mfaVerified: true, authTime: new Date().toISOString() });
  return { ws, brand, ownerId: o.id, owner, agent: await v2Ctx(agent.id, ws), agentId: agent.id };
}

async function caseIn(w: Awaited<ReturnType<typeof world>>): Promise<string> {
  const conn = await connectMock(w.owner, w.brand, { provider: 'facebook', display_name: 'Simulated Page' });
  const ch = await enableChannel(w.owner, { connection_id: conn.id });
  await simulateInbound(w.owner, ch.id, { kind: 'dm', text: 'My order arrived damaged', name: 'Cara Customer' });
  const conv = (await listConversations(w.owner, { queue: 'all' })).items[0]!;
  return (await createCase(w.owner, { conversation_id: conv.id, title: 'Damaged order', priority: 'high' })).id;
}

async function selectAll(ctx: Ctx, integrationId: string, type?: string, parent?: string) {
  const found = await discoverResources(ctx, integrationId, { type: type ?? null, parent: parent ?? null });
  const { items } = await selectResources(ctx, integrationId, { resources: found.items.map((r) => ({ resource_type: r.resource_type, external_id: r.external_id, name: r.name, url: r.url, selected: true })) });
  return items;
}

const jobsFor = async (integrationId: string) => (await db().query<{ id: string; kind: string; state: string }>(`SELECT id, kind, state FROM integration_sync_jobs WHERE integration_id=$1 ORDER BY created_at`, [integrationId])).rows;
const run = async (jobId: string) => runSyncJob(jobId, 'test-worker');

describe('Integrations hub — honest setup + OAuth state', () => {
  it('shows "needs app setup" with the missing operator settings; connect refuses until configured; callback state is single-use and user-bound', async () => {
    const w = await world();
    for (const k of ['ASANA_CLIENT_ID', 'ASANA_CLIENT_SECRET']) delete process.env[k];
    const hub = await hubOverview(w.owner);
    const asana = hub.connectors.find((c) => c.connector === 'asana')!;
    expect(asana).toMatchObject({ configured: false, missing_settings: ['ASANA_CLIENT_ID', 'ASANA_CLIENT_SECRET'], simulation_available: true });
    expect(asana.redirect_uri).toBe('http://localhost:3000/api/connectors/oauth/asana/callback');
    await expect(startIntegrationOAuth(w.owner, { connector: 'asana' })).rejects.toMatchObject({ code: 'provider_not_configured' });
    process.env.ASANA_CLIENT_ID = 'test-client-id'; process.env.ASANA_CLIENT_SECRET = 'test-client-secret';
    try {
      const { authorization_url } = await startIntegrationOAuth(w.owner, { connector: 'asana' });
      const u = new URL(authorization_url);
      expect(u.origin + u.pathname).toBe('https://app.asana.com/-/oauth_authorize');
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      expect(u.searchParams.get('scope')).toContain('tasks:write');
      const state = u.searchParams.get('state')!;
      // Another user cannot consume it; the agent (no integrations.manage) cannot start one.
      expect((await handleIntegrationOAuthCallback({ connector: 'asana', params: new URLSearchParams({ state, code: 'x' }), sessionUserId: w.agentId })).error).toBe('session_mismatch');
      await expect(startIntegrationOAuth(w.agent, { connector: 'asana' })).rejects.toMatchObject({ code: 'forbidden' });
      expect((await handleIntegrationOAuthCallback({ connector: 'asana', params: new URLSearchParams({ state, error: 'access_denied' }), sessionUserId: w.ownerId })).error).toBe('access_denied');
      // Consumed: replay is refused.
      expect((await handleIntegrationOAuthCallback({ connector: 'asana', params: new URLSearchParams({ state, code: 'x' }), sessionUserId: w.ownerId })).error).toBe('invalid_state');
    } finally { delete process.env.ASANA_CLIENT_ID; delete process.env.ASANA_CLIENT_SECRET; }
    // Nothing was invented: no installation exists.
    expect((await hubOverview(w.owner)).connectors.find((c) => c.connector === 'asana')!.installations).toHaveLength(0);
  });
});

describe('AT5 — HubSpot: a case creates ONE linked ticket despite repeated delivery', () => {
  it('repeat requests + lost response + reconciliation ⇒ exactly one ticket and one link; approved note only', async () => {
    const w = await world();
    const caseId = await caseIn(w);
    const hs = await createSimulatedHubInstallation(w.owner, { connector: 'hubspot', brand_id: w.brand });
    const pipelines = await selectAll(w.owner, hs.id, 'pipeline');
    expect(pipelines[0]).toMatchObject({ resource_type: 'pipeline', name: 'Support pipeline' });
    // Lost response on the create: the provider made the ticket but Relay did not hear back.
    await setSimScenario(w.owner, hs.id, 'timeout_after_send');
    const a = await createHubspotTicket(w.agent, { integration_id: hs.id, case_id: caseId, stage: '1' });
    const b = await createHubspotTicket(w.agent, { integration_id: hs.id, case_id: caseId, stage: '1' });
    // A repeated delivery of the same logical request (e.g. an automation retry) is the same job.
    const c = await enqueueSyncJob(w.agent, { integrationId: hs.id, kind: 'hubspot.ticket', relayType: 'case', relayId: caseId, payload: {} });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job!.id).toBe(a.job!.id);
    expect(c.job.id).toBe(a.job!.id);
    expect(await run(a.job!.id)).toBe('unknown');
    // Unknown is reconciled by the origin token, never blindly re-run.
    await db().query(`UPDATE integration_sync_jobs SET next_attempt_at=now() WHERE id=$1`, [a.job!.id]);
    expect(await reconcileSyncJobs(10)).toBeGreaterThanOrEqual(1);
    const tickets = await store.list('hubspot', (await db().query(`SELECT external_account_id FROM integration_connections WHERE id=$1`, [hs.id])).rows[0].external_account_id, 'ticket');
    expect(tickets).toHaveLength(1);
    const links = await db().query(`SELECT external_id, external_type, status FROM external_links WHERE integration_id=$1 AND relay_id=$2`, [hs.id, caseId]);
    expect(links.rows).toEqual([{ external_id: tickets[0]!.id, external_type: 'ticket', status: 'linked' }]);
    // Asking again after success returns the link, not a new ticket.
    const again = await createHubspotTicket(w.agent, { integration_id: hs.id, case_id: caseId, stage: '1' });
    expect(again).toMatchObject({ created: false, job: null });
    // Ticket context reads the stored snapshot; HubSpot never changes the Relay case state.
    await setSimScenario(w.owner, hs.id, 'success');
    const t = await caseTicket(w.agent, caseId, true);
    expect(t.ticket).toMatchObject({ stage: 'New', pipeline: 'Support pipeline' });
    expect((await db().query(`SELECT state FROM care_cases WHERE id=$1`, [caseId])).rows[0].state).toBe('open');
    // Summary note requires explicit approval and is deduplicated by its exact text.
    const n1 = await addHubspotNote(w.agent, { case_id: caseId, text: 'Customer reported damage; replacement sent.', approved: true });
    const n2 = await addHubspotNote(w.agent, { case_id: caseId, text: 'Customer reported damage; replacement sent.', approved: true });
    expect(n2.job.id).toBe(n1.job.id);
    expect(await run(n1.job.id)).toBe('succeeded');
  });

  it('contacts: exact-email search, explicit link (reversible), masked email, no consent implied; agents without inbox access are refused', async () => {
    const w = await world();
    const hs = await createSimulatedHubInstallation(w.owner, { connector: 'hubspot', brand_id: w.brand });
    const found = await searchHubspotContacts(w.agent, { integration_id: hs.id, email: 'cara.customer@example.com' });
    expect(found.items).toEqual([expect.objectContaining({ name: 'Cara Customer', company: 'Example Bakery' })]);
    expect(found.items[0]!.email_masked).not.toContain('cara.customer');
    const cust = await db().query<{ id: string }>(`INSERT INTO inbox_customers(workspace_id, brand_id, display_name) VALUES ($1,$2,'Cara') RETURNING id`, [w.ws, w.brand]);
    const linked = await linkHubspotContact(w.agent, { integration_id: hs.id, customer_id: cust.rows[0]!.id, contact_id: found.items[0]!.id });
    expect(linked.consent).toBe('not_established');
    const audit = await db().query(`SELECT diff FROM audit_events WHERE action='integration.contact_linked' AND resource_id=$1`, [cust.rows[0]!.id]);
    expect(audit.rows[0].diff).toMatchObject({ basis: 'explicit_link' });
    const viewer = await v2Ctx((await member(w.ws, 'viewer', w.brand)).id, w.ws);
    await expect(searchHubspotContacts(viewer, { integration_id: hs.id, email: 'cara.customer@example.com' })).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|not_found/) });
  });
});

describe('AT6 — Asana and monday.com sync without loops', () => {
  it('Asana: create from a case; Relay edit pushes; the echo is dropped; an external edit is pulled (mapped two-way) without a push; external Done never touches approvals', async () => {
    const w = await world();
    const caseId = await caseIn(w);
    const asana = await createSimulatedHubInstallation(w.owner, { connector: 'asana', brand_id: w.brand });
    const [proj] = await selectAll(w.owner, asana.id, 'project');
    const preview = await previewTask(w.agent, { integration_id: asana.id, relay_type: 'case', relay_id: caseId, resource_id: proj!.id, title: 'Replace damaged order', priority: 'high' });
    expect(preview.excluded).toContain('Customer messages');
    expect(preview.fields.find((f) => f.label === 'Description')!.value).not.toContain('arrived damaged');
    const { task } = await createExternalTask(w.agent, { integration_id: asana.id, relay_type: 'case', relay_id: caseId, resource_id: proj!.id, title: 'Replace damaged order', priority: 'high', idempotency_key: 'k-asana-1-abcdef' });
    const dup = await createExternalTask(w.agent, { integration_id: asana.id, relay_type: 'case', relay_id: caseId, resource_id: proj!.id, title: 'Replace damaged order', priority: 'high', idempotency_key: 'k-asana-1-abcdef' });
    expect(dup.created).toBe(false);
    const [create] = await jobsFor(asana.id);
    expect(await run(create!.id)).toBe('succeeded');
    const linked = await getExternalTask(w.agent, task.id);
    expect(linked).toMatchObject({ link_state: 'linked', in_sync: true, status: 'open', is_simulated: true });
    // Explicit two-way mappings for status and title (default would be Relay → Asana only).
    for (const f of ['status', 'title'] as const) {
      await setFieldMapping(w.owner, asana.id, { relay_object: 'task', relay_field: f, external_field: f === 'status' ? 'completed' : 'name', source_of_truth: 'relay', direction: 'two_way', conflict: 'manual_review', on_delete: 'mark_unavailable', on_revoke: 'mark_unavailable', enabled: true });
    }
    // Relay edit → one push job → provider updated.
    await updateExternalTask(w.agent, task.id, { expected_version: 1, due_on: '2026-12-01' });
    const push = (await jobsFor(asana.id)).find((j) => j.kind === 'asana.push_task')!;
    expect(await run(push.id)).toBe('succeeded');
    const acct = (await db().query(`SELECT external_account_id FROM integration_connections WHERE id=$1`, [asana.id])).rows[0].external_account_id;
    expect((await store.get('asana', acct, 'task', linked.external_id!))!.due_on).toBe('2026-12-01');
    // Asana's webhook echo of Relay's own write: recognised by the pushed-state hash and dropped.
    expect(await pullTask(task.id, 'webhook')).toBe('echo');
    // A person completes + renames the task in Asana; the signed webhook arrives (handshake first).
    const hookSecret = 'HookSecret0123456789abcd';
    const hs = await ingestIntegrationWebhook('asana', { rawBody: '', method: 'POST', uri: '/x', headers: { 'x-hook-secret': hookSecret } }, new URLSearchParams({ i: asana.id }));
    expect(hs.status).toBe(200);
    const body = await asanaSimExternalEdit(store, acct, linked.external_id!, { completed: true, name: 'Replace damaged order (sent)' });
    const sig = createHmac('sha256', hookSecret).update(body).digest('hex');
    const jobsBefore = (await jobsFor(asana.id)).length;
    const r = await ingestIntegrationWebhook('asana', { rawBody: body, method: 'POST', uri: '/x', headers: { 'x-hook-signature': sig } }, new URLSearchParams({ i: asana.id }));
    expect(r.status).toBe(200);
    const ev = (await db().query(`SELECT id FROM integration_events WHERE integration_id=$1 ORDER BY received_at DESC LIMIT 1`, [asana.id])).rows[0].id;
    expect(await processIntegrationEvent(ev)).toBe('processed');
    const after = await getExternalTask(w.agent, task.id);
    expect(after).toMatchObject({ status: 'done', title: 'Replace damaged order (sent)', in_sync: true, conflict: null });
    // No push was enqueued by the pull (no loop), and a second identical delivery is ignored as a duplicate.
    expect((await jobsFor(asana.id)).length).toBe(jobsBefore);
    expect(JSON.parse((await ingestIntegrationWebhook('asana', { rawBody: body, method: 'POST', uri: '/x', headers: { 'x-hook-signature': sig } }, new URLSearchParams({ i: asana.id }))).body).duplicate).toBe(true);
    expect(await pullTask(task.id, 'poll')).toBe('unchanged');
    // Unsigned / wrong signature: refused and not stored.
    expect((await ingestIntegrationWebhook('asana', { rawBody: body, method: 'POST', uri: '/x', headers: { 'x-hook-signature': 'bad' } }, new URLSearchParams({ i: asana.id }))).status).toBe(401);
    // Conflict: Relay has unsynced edits AND Asana changed the same field ⇒ manual review, nothing overwritten.
    await updateExternalTask(w.agent, task.id, { expected_version: 2, title: 'Relay title' });
    await asanaSimExternalEdit(store, acct, linked.external_id!, { name: 'Asana title' });
    expect(await pullTask(task.id, 'poll')).toBe('conflict');
    const conflicted = await getExternalTask(w.agent, task.id);
    expect(conflicted.title).toBe('Relay title');
    expect(conflicted.conflict).toMatchObject({ title: { relay: 'Relay title', external: 'Asana title' } });
    // Deleted externally ⇒ Relay keeps its record and marks the link unavailable.
    await asanaSimExternalEdit(store, acct, linked.external_id!, { deleted: true });
    expect(await pullTask(task.id, 'poll')).toBe('unavailable');
    expect((await getExternalTask(w.agent, task.id)).link_state).toBe('unavailable');
  });

  it('monday.com: item from an approved post, mapped status column; external "Done" never approves/publishes; JWT-signed webhook pulled once', async () => {
    const w = await world({ approvalRequired: true });
    const conns = await seedConnections(w.ws, w.brand);
    const { id: postId } = await createPost(w.owner, w.brand, { draft: draftFor('Autumn menu launch', [conns.facebook]) }, randomUUID());
    await submitForReview(w.owner, postId, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID());
    const approvalBefore = (await db().query(`SELECT decision FROM approvals WHERE post_id=$1`, [postId])).rows[0].decision;
    const mon = await createSimulatedHubInstallation(w.owner, { connector: 'monday', brand_id: w.brand });
    const boards = await selectAll(w.owner, mon.id, 'board');
    const board = boards.find((b) => b.name === 'Campaign briefs')!;
    for (const [f, col] of [['status', 'status'], ['due_on', 'date4']] as const) {
      await setFieldMapping(w.owner, mon.id, { resource_id: board.id, relay_object: 'task', relay_field: f, external_field: col, source_of_truth: 'relay', direction: 'two_way', conflict: 'manual_review', on_delete: 'mark_unavailable', on_revoke: 'mark_unavailable', enabled: true });
    }
    const { task } = await createExternalTask(w.owner, { integration_id: mon.id, relay_type: 'post', relay_id: postId, resource_id: board.id, title: 'Brief: autumn menu', due_on: '2026-11-20' });
    expect(await run((await jobsFor(mon.id))[0]!.id)).toBe('succeeded');
    const t1 = await getExternalTask(w.owner, task.id);
    const acct = (await db().query(`SELECT external_account_id FROM integration_connections WHERE id=$1`, [mon.id])).rows[0].external_account_id;
    const item = (await store.get('monday', acct, 'item', t1.external_id!))!;
    expect((item.columns as Record<string, { text: string }>).date4!.text).toBe('2026-11-20');
    expect(String((item.updates as string[])[0])).toMatch(/relay:[0-9a-f-]{36}/);
    process.env.MONDAY_SIGNING_SECRET = 'monday-signing-secret-test';
    try {
      const body = await mondaySimExternalEdit(store, acct, t1.external_id!, { status: 'Done' });
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64({ accountId: 1, exp: Math.floor(Date.now() / 1000) + 300 });
      const jwt = `${h}.${p}.${createHmac('sha256', process.env.MONDAY_SIGNING_SECRET).update(`${h}.${p}`).digest('base64url')}`;
      const r = await ingestIntegrationWebhook('monday', { rawBody: body, method: 'POST', uri: '/x', headers: { authorization: jwt } }, new URLSearchParams({ i: mon.id }));
      expect(r.status).toBe(200);
      const ev = (await db().query(`SELECT id FROM integration_events WHERE integration_id=$1 ORDER BY received_at DESC LIMIT 1`, [mon.id])).rows[0].id;
      expect(await processIntegrationEvent(ev)).toBe('processed');
    } finally { delete process.env.MONDAY_SIGNING_SECRET; }
    expect(await getExternalTask(w.owner, task.id)).toMatchObject({ status: 'done', external_status: 'Done' });
    // External Done changed only the work item: the post's review and schedule are untouched.
    expect((await db().query(`SELECT decision FROM approvals WHERE post_id=$1`, [postId])).rows[0].decision).toBe(approvalBefore);
    expect((await db().query(`SELECT status FROM schedules WHERE post_id=$1`, [postId])).rows[0].status).toBe('pending_approval');
    expect((await jobsFor(mon.id)).filter((j) => j.kind === 'monday.push_task')).toHaveLength(0);
  });
});

describe('AT7 — Slack interactions reject unauthorized or revoked actors', () => {
  const secret = 'slack-signing-secret-test';
  const signed = (payload: object, ts = String(Math.floor(Date.now() / 1000))) => {
    const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    return { rawBody: raw, method: 'POST', uri: '/api/connectors/webhooks/slack', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}` } };
  };
  async function click(actionId: string, slackUser: string, team = 'mock_T1') {
    const r = await ingestIntegrationWebhook('slack', signed({ type: 'block_actions', trigger_id: randomUUID(), team: { id: team }, user: { id: slackUser }, actions: [{ action_id: 'relay_approve', value: actionId }], response_url: 'https://hooks.slack.com/actions/T/1/x' }), new URLSearchParams());
    expect(r.status).toBe(200);
    const ev = (await db().query(`SELECT id FROM integration_events WHERE connector='slack' ORDER BY received_at DESC LIMIT 1`)).rows[0].id;
    await processIntegrationEvent(ev);
    return (await db().query(`SELECT state, last_error FROM integration_events WHERE id=$1`, [ev])).rows[0];
  }

  it('routes, dedupe, private-only categories, approval bound to the exact revision, link-required, revoked member refused, unsigned refused', async () => {
    process.env.SLACK_SIGNING_SECRET = secret;
    const w = await world({ approvalRequired: true });
    const approver = await member(w.ws, 'approver', w.brand, 'Ava Approver');
    const conns = await seedConnections(w.ws, w.brand);
    const slack = await createSimulatedHubInstallation(w.owner, { connector: 'slack' });
    const chans = await selectAll(w.owner, slack.id);
    const pub = chans.find((c) => c.name === '#social-approvals')!;
    const priv = chans.find((c) => c.name === '#care-escalations')!;
    await expect(saveSlackRoute(w.owner, { integration_id: slack.id, resource_id: pub.id, categories: ['approvals', 'care_escalations'], brand_ids: null, quiet_start: null, quiet_end: null, timezone: 'UTC', max_per_hour: 20, summary_time: null, enabled: true }))
      .rejects.toMatchObject({ code: 'validation_failed' });
    await saveSlackRoute(w.owner, { integration_id: slack.id, resource_id: pub.id, categories: ['approvals'], brand_ids: null, quiet_start: null, quiet_end: null, timezone: 'UTC', max_per_hour: 20, summary_time: null, enabled: true });
    await saveSlackRoute(w.owner, { integration_id: slack.id, resource_id: priv.id, categories: ['care_escalations', 'assignments'], brand_ids: null, quiet_start: null, quiet_end: null, timezone: 'UTC', max_per_hour: 20, summary_time: null, enabled: true });
    const mkApproval = async (text: string) => {
      const { id } = await createPost(w.owner, w.brand, { draft: draftFor(text, [conns.facebook]) }, randomUUID());
      await submitForReview(w.owner, id, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID());
      return (await db().query<{ id: string; fingerprint: string }>(`SELECT id, fingerprint FROM approvals WHERE post_id=$1`, [id])).rows[0]!;
    };
    const a1 = await mkApproval('Weekend brunch is back');
    // The notification feed (one row per reviewer) becomes ONE channel message.
    for (const uid of [w.ownerId, approver.id]) {
      await db().query(`INSERT INTO notifications(workspace_id, user_id, severity, kind, title, reference_type, reference_id, dedupe_key, brand_id, link_path, event_type)
        VALUES ($1,$2,'info','approval.requested','A post is waiting for your review','approval',$3,$4,$5,$6,'review_requested')`, [w.ws, uid, a1.id, `approval:${a1.id}:stage:1`, w.brand, `/approvals/${a1.id}`]);
    }
    expect(await collectSlackAlerts()).toBe(1);
    expect(await collectSlackAlerts()).toBe(0);
    expect((await sendSlackDeliveries()).sent).toBe(1);
    const hist = await listSlackDeliveries(w.owner, slack.id);
    expect(hist.items[0]).toMatchObject({ state: 'sent', category: 'approvals', text: 'Approval requested · Harbour Café' });
    const msg = (await store.list('slack', 'mock_slack_' + w.ws.slice(0, 8), 'message'))[0]!.data as { text: string; blocks: Array<{ elements?: Array<{ value?: string; action_id: string }> }> };
    expect(msg.text).not.toContain('Weekend brunch');
    const actionId = msg.blocks[1]!.elements!.find((e) => e.action_id === 'relay_approve')!.value!;

    // Unsigned / tampered: refused at the ingress, nothing stored.
    const bad = signed({ type: 'block_actions' }); bad.headers['x-slack-signature'] = 'v0=deadbeef';
    expect((await ingestIntegrationWebhook('slack', bad, new URLSearchParams())).status).toBe(401);
    // Unlinked Slack user: no matching by name/email — a link is required; nothing approved.
    await click(actionId, 'U_AVA');
    expect((await db().query(`SELECT decision FROM approvals WHERE id=$1`, [a1.id])).rows[0].decision).toBe('pending');
    const tok = await db().query(`SELECT 1 FROM slack_link_tokens WHERE slack_user_id='U_AVA' AND consumed_at IS NULL`);
    expect(tok.rowCount).toBe(1);
    // The approver links (token issued for the verified Slack identity) — simulate the link page with a fresh token.
    const { randomBytes, createHash } = await import('node:crypto');
    const linkToken = randomBytes(16).toString('base64url');
    await db().query(`INSERT INTO slack_link_tokens(token_hash, workspace_id, integration_id, slack_team_id, slack_user_id, expires_at) VALUES ($1,$2,$3,'mock_T1','U_AVA', now() + interval '5 minutes')`, [createHash('sha256').update(linkToken).digest(), w.ws, slack.id]);
    const avaCtx = await v2Ctx(approver.id, w.ws);
    await confirmSlackLink(avaCtx, linkToken);
    await expect(confirmSlackLink(avaCtx, linkToken)).rejects.toMatchObject({ code: 'invalid_state' });
    await click(actionId, 'U_AVA');
    expect((await db().query(`SELECT decision, reviewer_id FROM approvals WHERE id=$1`, [a1.id])).rows[0]).toEqual({ decision: 'approved', reviewer_id: approver.id });
    // Replay of the same button: already used ⇒ refused.
    await click(actionId, 'U_AVA');
    expect((await db().query(`SELECT count(*)::int n FROM audit_events WHERE action='integration.slack_approved' AND resource_id=$1`, [a1.id])).rows[0].n).toBe(1);

    // Revoked actor: the linked approver loses membership ⇒ refused immediately; the approval stays pending.
    const a2 = await mkApproval('Live music on Friday');
    await enqueueSlackEvent({ workspaceId: w.ws, category: 'approvals', eventKey: `n:approval.requested:approval:${a2.id}:stage`, brandId: w.brand, text: 'Approval requested', linkPath: `/approvals/${a2.id}`, approvalId: a2.id });
    const act2 = (await db().query(`SELECT id FROM slack_actions WHERE approval_id=$1`, [a2.id])).rows[0].id;
    await db().query(`UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND user_id=$2`, [w.ws, approver.id]);
    await click(act2, 'U_AVA');
    expect((await db().query(`SELECT decision FROM approvals WHERE id=$1`, [a2.id])).rows[0].decision).toBe('pending');
    expect((await db().query(`SELECT count(*)::int n FROM audit_events WHERE action='integration.slack_action_refused' AND resource_id=$1`, [a2.id])).rows[0].n).toBe(1);

    // Changed content: the button is bound to the revision + fingerprint ⇒ fresh review required.
    await db().query(`UPDATE memberships SET removed_at=NULL WHERE workspace_id=$1 AND user_id=$2`, [w.ws, approver.id]);
    await db().query(`UPDATE slack_actions SET fingerprint='stale-fingerprint' WHERE id=$1`, [act2]);
    await click(act2, 'U_AVA');
    expect((await db().query(`SELECT decision FROM approvals WHERE id=$1`, [a2.id])).rows[0].decision).toBe('pending');
    // A different Slack workspace cannot use another team's action id.
    await click(act2, 'U_AVA', 'T_OTHER');
    expect((await db().query(`SELECT decision FROM approvals WHERE id=$1`, [a2.id])).rows[0].decision).toBe('pending');
    delete process.env.SLACK_SIGNING_SECRET;
  });

  it('quiet hours defer; per-channel rate limit delays; private-only category skips public channels', () => {
    const now = new Date('2026-11-08T23:30:00Z');
    expect(quietMinutesLeft({ quiet_start: '22:00', quiet_end: '07:00', timezone: 'UTC' }, now)).toBe(450);
    expect(quietMinutesLeft({ quiet_start: '22:00', quiet_end: '07:00', timezone: 'UTC' }, new Date('2026-11-08T12:00:00Z'))).toBe(0);
    expect(quietMinutesLeft({ quiet_start: null, quiet_end: null, timezone: 'UTC' }, now)).toBe(0);
  });
});

describe('AT8 — Mailchimp export creates a draft; never sends or subscribes', () => {
  it('approved content only; one draft per post; status "save"; no send/members calls exist', async () => {
    const w = await world();
    const conns = await seedConnections(w.ws, w.brand);
    const { id: postId } = await createPost(w.owner, w.brand, { draft: draftFor('Our autumn menu is here.\n\nBook a table this week.', [conns.facebook]) }, randomUUID());
    const mc = await createSimulatedHubInstallation(w.owner, { connector: 'mailchimp', brand_id: w.brand });
    const auds = await selectAll(w.owner, mc.id);
    const input = { integration_id: mc.id, post_id: postId, audience_resource_id: auds[0]!.id, subject: 'Autumn menu' };
    await expect(exportToMailchimp(w.owner, input)).rejects.toMatchObject({ code: 'invalid_state' });   // not scheduled/approved yet
    await publishNow(w.owner, postId, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID());
    const preview = await previewMailchimpExport(w.owner, input);
    expect(preview.excluded).toContain('No email is sent');
    const a = await exportToMailchimp(w.owner, input);
    const b = await exportToMailchimp(w.owner, input);
    expect(b.job.id).toBe(a.job.id);
    expect(await run(a.job.id)).toBe('succeeded');
    const acct = (await db().query(`SELECT external_account_id FROM integration_connections WHERE id=$1`, [mc.id])).rows[0].external_account_id;
    const camps = await store.list('mailchimp', acct, 'campaign');
    expect(camps).toHaveLength(1);
    expect(camps[0]!.data).toMatchObject({ status: 'save', html_set: true });
    expect((await store.list('mailchimp', acct, 'member'))).toHaveLength(0);
    const ex = await mailchimpExportsForPost(w.owner, postId);
    expect(ex.items[0]).toMatchObject({ status: 'save', is_simulated: true });
    const sendCalls = await db().query(`SELECT count(*)::int n FROM integration_sync_jobs WHERE integration_id=$1 AND kind NOT IN ('mailchimp.campaign')`, [mc.id]);
    expect(sendCalls.rows[0].n).toBe(0);
  });
});

describe('AT9 — Translation preserves the original and never sends', () => {
  it('off until an admin enables it (billing acknowledged); customer content needs its own switch; cached; nothing sent', async () => {
    const w = await world();
    const caseId = await caseIn(w);
    const msg = (await db().query<{ id: string; body: string; conversation_id: string }>(`SELECT m.id, m.body, m.conversation_id FROM inbox_messages m JOIN inbox_conversations c ON c.id=m.conversation_id WHERE c.case_id=$1`, [caseId])).rows[0]!;
    await expect(translate(w.agent, { source_type: 'inbox_message', source_id: msg.id, target_lang: 'es' })).rejects.toMatchObject({ details: { reason: 'translation_disabled' } });
    await expect(updateTranslationSettings(w.owner, { enabled: true, allow_customer_content: false, monthly_char_cap: 100000, glossary_id: null })).rejects.toMatchObject({ code: 'invalid_state' }); // not connected
    await createSimulatedHubInstallation(w.owner, { connector: 'google_translate' });
    await expect(updateTranslationSettings(w.owner, { enabled: true, allow_customer_content: false, monthly_char_cap: 100000, glossary_id: null })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(updateTranslationSettings(w.agent, { enabled: true, allow_customer_content: true, monthly_char_cap: 100000, glossary_id: null, acknowledge_billing: true })).rejects.toMatchObject({ code: 'forbidden' });
    await updateTranslationSettings(w.owner, { enabled: true, allow_customer_content: false, monthly_char_cap: 100000, glossary_id: null, acknowledge_billing: true });
    await expect(translate(w.agent, { source_type: 'inbox_message', source_id: msg.id, target_lang: 'es' })).rejects.toMatchObject({ code: 'forbidden' });
    await updateTranslationSettings(w.owner, { enabled: true, allow_customer_content: true, monthly_char_cap: 100000, glossary_id: null });
    const t = await translate(w.agent, { source_type: 'inbox_message', source_id: msg.id, target_lang: 'es' });
    expect(t).toMatchObject({ machine_translated: true, target_lang: 'es', source_lang: 'en', detected: true, original_text: msg.body, is_simulated: true });
    expect(t.translated_text).toContain('[Simulated → es]');
    expect(t.cost_estimate_usd).toBeGreaterThan(0);
    // Original untouched; no reply attempts were created.
    expect((await db().query(`SELECT body FROM inbox_messages WHERE id=$1`, [msg.id])).rows[0].body).toBe(msg.body);
    expect((await db().query(`SELECT count(*)::int n FROM inbox_reply_attempts WHERE conversation_id=$1`, [msg.conversation_id])).rows[0].n).toBe(0);
    // Reply draft: links, mentions and placeholders survive exactly; the result is for review only.
    const d = await translate(w.agent, { source_type: 'reply_draft', source_id: msg.conversation_id, text: 'Hi @cara, see https://example.com/returns?id=7 — ref {{order}}', target_lang: 'fr', source_lang: 'en' });
    expect(d.translated_text).toContain('https://example.com/returns?id=7');
    expect(d.translated_text).toContain('@cara');
    expect(d.translated_text).toContain('{{order}}');
    // Same source + target ⇒ stored translation, no new characters billed.
    const again = await translate(w.agent, { source_type: 'inbox_message', source_id: msg.id, target_lang: 'es' });
    expect(again.id).toBe(t.id);
    const s = await getTranslationSettings(w.owner);
    expect(s.usage.month_requests).toBe(2);
    expect(s.price_per_million_usd).toBe(20);
  });
});

describe('AT13 — provider outages produce recoverable states (no invented success)', () => {
  it('outage ⇒ waiting_retry; rate limit ⇒ throttled with observed reset; revoked ⇒ reconnect required, links unavailable, Relay record kept', async () => {
    const w = await world();
    const caseId = await caseIn(w);
    const asana = await createSimulatedHubInstallation(w.owner, { connector: 'asana', brand_id: w.brand });
    const [proj] = await selectAll(w.owner, asana.id, 'project');
    await setSimScenario(w.owner, asana.id, 'outage');
    const { task } = await createExternalTask(w.agent, { integration_id: asana.id, relay_type: 'case', relay_id: caseId, resource_id: proj!.id, title: 'Follow up' });
    const [job] = await jobsFor(asana.id);
    expect(await run(job!.id)).toBe('waiting_retry');
    expect((await getExternalTask(w.agent, task.id)).link_state).toBe('pending');
    const diag = await diagnoseIntegration(w.owner, asana.id);
    expect(diag.status).toBe('needs_attention');
    await setSimScenario(w.owner, asana.id, 'rate_limited_once');
    await db().query(`UPDATE integration_sync_jobs SET next_attempt_at=now() WHERE id=$1`, [job!.id]);
    expect(await run(job!.id)).toBe('waiting_retry');
    const rl = (await db().query(`SELECT rate_limit FROM integration_connections WHERE id=$1`, [asana.id])).rows[0].rate_limit;
    expect(rl).toMatchObject({ remaining: 0, source: 'Retry-After' });
    await db().query(`UPDATE integration_sync_jobs SET next_attempt_at=now() WHERE id=$1`, [job!.id]);
    expect(await run(job!.id)).toBe('succeeded');
    // Access revoked at the provider.
    const hs = await createSimulatedHubInstallation(w.owner, { connector: 'hubspot', brand_id: w.brand });
    const tj = await createHubspotTicket(w.agent, { integration_id: hs.id, case_id: caseId, stage: '1' });
    expect(await run(tj.job!.id)).toBe('succeeded');
    await setSimScenario(w.owner, hs.id, 'revoked');
    await expect(caseTicket(w.agent, caseId, true)).rejects.toBeTruthy();
    const integ = (await db().query(`SELECT status, credential_id FROM integration_connections WHERE id=$1`, [hs.id])).rows[0];
    expect(integ).toEqual({ status: 'reconnect_required', credential_id: null });
    expect((await db().query(`SELECT status FROM external_links WHERE integration_id=$1`, [hs.id])).rows[0].status).toBe('unavailable');
    expect((await db().query(`SELECT count(*)::int n FROM care_cases WHERE id=$1`, [caseId])).rows[0].n).toBe(1);
  });
});

describe('Google Business Profile — local posts through scheduling + approval; Pub/Sub OIDC', () => {
  it('explicit locations with a count guard; waits for approval; changed content ⇒ needs review; due + approved ⇒ live', async () => {
    const w = await world({ approvalRequired: true });
    const conns = await seedConnections(w.ws, w.brand);
    const gbp = await createSimulatedHubInstallation(w.owner, { connector: 'google_business_profile', brand_id: w.brand });
    const locs = await selectAll(w.owner, gbp.id, 'location');
    expect(locs).toHaveLength(3);
    const forB = await listGbpLocations(w.agent, { brandId: w.brand });
    expect(forB.items[0]!.location_name).toMatch(/^accounts\/mock_acc_1\/locations\/mock_loc_\d$/);
    const { id: postId } = await createPost(w.owner, w.brand, { draft: draftFor('Pumpkin spice is back at all cafés', [conns.facebook]) }, randomUUID());
    await expect(requestGbpLocalPosts(w.owner, { post_id: postId, location_resource_ids: [locs[0]!.id], confirm_location_count: 1 })).rejects.toMatchObject({ code: 'invalid_state' });
    await submitForReview(w.owner, postId, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID());
    await expect(requestGbpLocalPosts(w.owner, { post_id: postId, location_resource_ids: locs.map((l) => l.id), confirm_location_count: 1 })).rejects.toMatchObject({ code: 'validation_failed' });
    const req = await requestGbpLocalPosts(w.owner, { post_id: postId, location_resource_ids: [locs[0]!.id, locs[1]!.id], confirm_location_count: 2 });
    expect(req.items.map((i) => i.state)).toEqual(['waiting_approval', 'waiting_approval']);
    await dispatchDueGbpPosts();
    expect((await listGbpLocalPosts(w.owner, postId)).items.every((i) => i.state === 'waiting_approval')).toBe(true);
    const ap = (await db().query<{ id: string; fingerprint: string }>(`SELECT id, fingerprint FROM approvals WHERE post_id=$1`, [postId])).rows[0]!;
    const approver = await member(w.ws, 'approver', w.brand, 'Ava');
    await approve(await v2Ctx(approver.id, w.ws), ap.id, ap.fingerprint);
    await dispatchDueGbpPosts();
    const after = await listGbpLocalPosts(w.owner, postId);
    expect(after.items.every((i) => i.state === 'publishing')).toBe(true);
    for (const j of await jobsFor(gbp.id)) expect(await run(j.id)).toBe('succeeded');
    const live = await listGbpLocalPosts(w.owner, postId);
    expect(live.items.map((i) => i.state)).toEqual(['live', 'live']);
    const acct = (await db().query(`SELECT external_account_id FROM integration_connections WHERE id=$1`, [gbp.id])).rows[0].external_account_id;
    const posts = await store.list('google_business_profile', acct, 'localPost');
    expect(posts).toHaveLength(2);
    expect(posts.every((p) => p.data.summary === 'Pumpkin spice is back at all cafés')).toBe(true);
    // A new revision supersedes the schedule ⇒ an outstanding request for the old version needs review.
    const third = await requestGbpLocalPosts(w.owner, { post_id: postId, location_resource_ids: [locs[2]!.id], confirm_location_count: 1 });
    expect(third.items.find((i) => i.location_resource_id === locs[2]!.id)!.state).toBe('scheduled');
    await db().query(`UPDATE schedules SET status='superseded' WHERE post_id=$1`, [postId]);
    await dispatchDueGbpPosts();
    expect((await listGbpLocalPosts(w.owner, postId)).items.find((i) => i.location_resource_id === locs[2]!.id)!.state).toBe('needs_review');
  });

  it('Pub/Sub push: Google-signed OIDC token checked (signature, audience, service account, expiry)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...(publicKey.export({ format: 'jwk' }) as { n: string; e: string; kty: string }), kid: 'test-kid', alg: 'RS256' };
    setGoogleJwksForTests([jwk]);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const tok = (claims: object, kid = 'test-kid') => {
      const h = b64({ alg: 'RS256', kid, typ: 'JWT' }); const p = b64(claims);
      return `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url')}`;
    };
    const aud = 'https://relay.test/api/connectors/webhooks/google_business_profile'; const sa = 'push@proj.iam.gserviceaccount.com';
    const body = JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ notificationType: 'NEW_REVIEW', location: 'accounts/1/locations/2', review: 'accounts/1/locations/2/reviews/3' })).toString('base64'), messageId: 'm-1', publishTime: new Date().toISOString() }, subscription: 'projects/p/subscriptions/s' });
    const good = { iss: 'https://accounts.google.com', aud, email: sa, email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 };
    const req = (t: string) => ({ rawBody: body, headers: { authorization: `Bearer ${t}` }, method: 'POST', uri: '/', now: new Date() });
    expect(await verifyPubsubPush(req(tok(good)), aud, sa)).toMatchObject({ ok: true, dedupeKey: 'pubsub:m-1', eventType: 'NEW_REVIEW' });
    expect(await verifyPubsubPush(req(tok({ ...good, aud: 'other' })), aud, sa)).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(await verifyPubsubPush(req(tok({ ...good, email: 'evil@x.iam.gserviceaccount.com' })), aud, sa)).toMatchObject({ ok: false });
    expect(await verifyPubsubPush(req(tok({ ...good, exp: 1000 })), aud, sa)).toMatchObject({ ok: false, reason: 'stale' });
    expect(await verifyPubsubPush(req(tok(good, 'unknown-kid')), aud, sa)).toMatchObject({ ok: false });
    expect(await verifyPubsubPush(req(tok(good)), null, sa)).toMatchObject({ ok: false, reason: 'not_configured' });
  });
});

describe('Operator-credential connect (Translation) refuses without Setup values', () => {
  it('missing project/service account ⇒ provider_not_configured', async () => {
    const w = await world();
    delete process.env.GOOGLE_TRANSLATE_PROJECT_ID; delete process.env.GOOGLE_TRANSLATE_SERVICE_ACCOUNT_JSON;
    await expect(connectWithOperatorCredentials(w.owner, { connector: 'google_translate' })).rejects.toMatchObject({ code: 'provider_not_configured' });
  });
});

describe('Stream E automation action kinds (executors registered by stream C)', () => {
  it('asana.create_task / monday.create_item / hubspot.create_ticket / slack.post_message run; mailchimp draft stays unavailable', async () => {
    const { syncExecutor } = await import('@social-lite/services/connectors/registry');
    for (const k of ['asana.create_task', 'monday.create_item', 'hubspot.create_ticket', 'slack.post_message']) expect(syncExecutor(k)).toBeTruthy();
    expect(syncExecutor('mailchimp.create_campaign_draft')).toBeNull();
    const w = await world();
    const caseId = await caseIn(w);
    const payload = { source: 'relay_automation', rule: 'Damage → task', category: 'complaint', link: null, brand_id: w.brand };
    // Asana: needs exactly one selected project (or an automation default).
    const asana = await createSimulatedHubInstallation(w.owner, { connector: 'asana', brand_id: w.brand });
    await selectAll(w.owner, asana.id, 'project');
    const j1 = await enqueueSyncJob(w.owner, { integrationId: asana.id, kind: 'asana.create_task', relayType: 'case', relayId: caseId, idempotencyKey: 'automation:r1:e1:0', payload });
    expect(await run(j1.job.id)).toBe('failed');   // two projects selected, no default
    await db().query(`UPDATE integration_resources SET selected=false WHERE integration_id=$1 AND name='Campaign production'`, [asana.id]);
    const j1b = await enqueueSyncJob(w.owner, { integrationId: asana.id, kind: 'asana.create_task', relayType: 'case', relayId: caseId, idempotencyKey: 'automation:r1:e2:0', payload });
    expect(await run(j1b.job.id)).toBe('succeeded');
    const t = (await db().query(`SELECT title, description, link_state FROM integration_tasks WHERE idempotency_key=$1`, [`automation:${j1b.job.id}`])).rows[0];
    expect(t).toMatchObject({ link_state: 'linked' });
    expect(t.title).toContain('Damage → task');
    expect(t.description).not.toContain('arrived damaged');
    // HubSpot: one ticket per case even across UI + automation requests.
    const hs = await createSimulatedHubInstallation(w.owner, { connector: 'hubspot', brand_id: w.brand });
    await db().query(`UPDATE integration_connections SET settings = settings || '{"default_pipeline":"0","default_stage":"1"}'::jsonb WHERE id=$1`, [hs.id]);
    for (const k of ['a', 'b']) {
      const j = await enqueueSyncJob(w.owner, { integrationId: hs.id, kind: 'hubspot.create_ticket', relayType: 'case', relayId: caseId, idempotencyKey: `automation:r2:${k}:0`, payload });
      expect(await run(j.job.id)).toBe('succeeded');
    }
    const ui = await createHubspotTicket(w.agent, { integration_id: hs.id, case_id: caseId, stage: '1' });
    expect(ui).toMatchObject({ created: false, job: null });
    const acct = (await db().query(`SELECT external_account_id FROM integration_connections WHERE id=$1`, [hs.id])).rows[0].external_account_id;
    expect(await store.list('hubspot', acct, 'ticket')).toHaveLength(1);
    // Slack: queued to this installation's care-escalation channels only.
    const slack = await createSimulatedHubInstallation(w.owner, { connector: 'slack' });
    const chans = await selectAll(w.owner, slack.id);
    const sj = await enqueueSyncJob(w.owner, { integrationId: slack.id, kind: 'slack.post_message', relayType: 'case', relayId: caseId, idempotencyKey: 'automation:r3:e1:0', payload });
    expect(await run(sj.job.id)).toBe('failed');   // no route yet
    await saveSlackRoute(w.owner, { integration_id: slack.id, resource_id: chans.find((c) => c.name === '#care-escalations')!.id, categories: ['care_escalations'], brand_ids: null, quiet_start: null, quiet_end: null, timezone: 'UTC', max_per_hour: 20, summary_time: null, enabled: true });
    const sj2 = await enqueueSyncJob(w.owner, { integrationId: slack.id, kind: 'slack.post_message', relayType: 'case', relayId: caseId, idempotencyKey: 'automation:r3:e2:0', payload });
    expect(await run(sj2.job.id)).toBe('succeeded');
    expect((await db().query(`SELECT count(*)::int n FROM slack_deliveries WHERE integration_id=$1`, [slack.id])).rows[0].n).toBe(1);
  });
});
