// V3.5 stream F — cross-stream wiring, admin services, MCP tools and revocation, on real Postgres through the real
// policy path (v2Ctx) and the real /mcp handler (official SDK client, in-process fetch, test JWKS).
//  - listening.alert_fired → automation 'listening.alert' trigger (+ Slack listening alerts, simulated-only routing)
//  - approval.decided → bridge → 'content.approved' trigger
//  - GBP Pub/Sub review notification → poll of the matching Google reviews channel
//  - Telegram channel removal releases Relay's own webhook only
//  - MCP: inbox reads (no internal notes), draft_reply (never sends), assignment, cases (one per retry), listening
//    queries with coverage, AI preparation (honest "not set up"), scope + brand narrowing, revocation
//  - revocation: queued sync jobs re-check the requester; admin + platform views are counts only (AT14 consistency)
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMock } from '@social-lite/services/connections/index';
import {
  addNote, assignConversation, checkTelegramWebhook, claimTelegramWebhook, enableChannel, enableIntegrationChannel, getConversation, handleInboxEvent, inboxAdminOverview,
  integrationAccounts, listConversations, removeChannel, resetInboxHooksForTests, simulateInbound,
} from '@social-lite/services/inbox/index';
import { onGbpReviewNotification, registerGbpReviewNotifications } from '@social-lite/services/inbox/channels-gbp-notify';
import { createPolicy, createRule as createAutomationRule, installAutomation, resetAutomationInstallForTests, setPolicyStatus, automationCatalog } from '@social-lite/services/automation/index';
import { createRule as createListeningRule, createSearch } from '@social-lite/services/listening/index';
import { createSimulatedIntegration, enqueueSyncJob, processIntegrationEvent, registerSyncExecutor, runSyncJob } from '@social-lite/services/connectors/index';
import { careAdminSummary, integrationsAdminOverview, platformCareHealth } from '@social-lite/services/admin/v35';
import { handleEvent } from '@social-lite/services/engine/notify';
import { approve, createPost, submitForReview } from '@social-lite/services';
import { DbMockStore } from '@social-lite/services/mock-store';
import { recordSimulatedReview } from '@social-lite/providers/google-business/inbox-fake';
import { recordSimulatedTelegramWebhook } from '@social-lite/providers/telegram/inbox-fake';
import { setMcpAuthTestOverrides } from '@social-lite/services/mcp/auth';
import { closeAllMcpSessions, handleMcpHttp } from '@social-lite/services/mcp/server';
import { consentClient, revokeClient } from '@social-lite/services/mcp/registry';
import { Client, StreamableHTTPClientTransport } from '@social-lite/services/mcp/sdk-client';
import type { Ctx } from '@social-lite/services';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';
import { seedConnections } from './engine-helpers.js';

const ISS = 'https://idp.test/realms/relay';
const RESOURCE = 'http://localhost:3000/mcp';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const store = () => new DbMockStore(testPool());

beforeAll(() => {
  testPool();
  setMcpAuthTestOverrides({ issuer: ISS, keys: async (kid) => (kid === 'k1' ? keys.publicKey : null) });
});
afterAll(async () => { await closeAllMcpSessions(); setMcpAuthTestOverrides(null); await closeTestPool(); });

async function member(ws: string, role: string, brandId?: string, name = 'Member') {
  const u = await createUser(undefined, name);
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, u.id]);
  await grant(ws, u.id, role, brandId);
  return u;
}

interface World { ws: string; brand: string; brandB: string; owner: Ctx; ownerId: string; agent: Ctx; agentId: string; analystId: string; channelId: string }
async function world(opts: { approvalRequired?: boolean } = {}): Promise<World> {
  const ws = await createWorkspace('Stream F');
  const brand = await createBrand(ws, 'Care brand', { approvalRequired: opts.approvalRequired });
  const brandB = await createBrand(ws, 'Other brand');
  const o = await createUser(undefined, 'Olive Owner');
  await addMember(ws, o.id, 'owner');
  const a = await member(ws, 'care_agent', brand, 'Ann Agent');
  const an = await member(ws, 'analyst', brand, 'Ana Analyst');
  const owner = await v2Ctx(o.id, ws);
  const conn = await connectMock(owner, brand, { provider: 'facebook', display_name: 'Simulated Page' });
  const ch = await enableChannel(owner, { connection_id: conn.id });
  return { ws, brand, brandB, owner, ownerId: o.id, agent: await v2Ctx(a.id, ws), agentId: a.id, analystId: an.id, channelId: ch.id };
}

async function policy(w: World, allowed: string[]) {
  const p = await createPolicy(w.owner, {
    name: 'Alerts', brand_ids: [w.brand], channel_ids: [w.channelId], allowed_actions: allowed as never, reply_categories: [],
    limits: { max_actions_per_hour: 100, max_auto_replies_per_day: 0, monthly_token_budget: 0 }, escalation: {}, expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  await setPolicyStatus(w.owner, p.id, 'active');
  return p;
}

async function fireAlert(w: World, simulated = true): Promise<string> {
  const s = await createSearch(w.owner, { brand_id: w.brand, name: 'Brand mentions', role: 'own', terms: ['vitalos'], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] });
  const rule = await createListeningRule(w.owner, { search_id: s.id, name: 'Spike', metric: 'volume', window_minutes: 60, baseline_days: 1, min_sample: 5, multiplier: 2, min_baseline_windows: 3, cooldown_minutes: 120, recipients: [], enabled: true });
  const a = await testPool().query<{ id: string }>(
    `INSERT INTO listening_alerts(workspace_id, brand_id, rule_id, search_id, query_version, metric, window_start, window_end, observed, baseline_mean, baseline_stddev, baseline_windows, threshold, min_sample, coverage, is_simulated, dedupe_key)
     VALUES ($1,$2,$3,$4,1,'volume', now() - interval '1 hour', now(), 12, 2, 1, 24, 6, 5, '{}'::jsonb, $5, $6) RETURNING id`, [w.ws, w.brand, rule.id, s.id, simulated, randomUUID()]);
  return a.rows[0]!.id;
}

describe('Stream F wiring — automation triggers', () => {
  it('listening.alert_fired runs the listening.alert trigger once per alert; only people who can see listening are notified', async () => {
    resetInboxHooksForTests(); resetAutomationInstallForTests(); installAutomation();
    const w = await world();
    const p = await policy(w, ['notify', 'integration_job']);
    // Conversation actions are refused for an alert trigger; notify needs chosen people with listening access.
    await expect(createAutomationRule(w.owner, { policy_id: p.id, name: 'x', trigger: 'listening.alert', conditions: [], actions: [{ type: 'add_note', body: 'x' }] as never, scope: { brand_ids: [w.brand], channel_ids: [] } }))
      .rejects.toMatchObject({ code: 'validation_failed' });
    await expect(createAutomationRule(w.owner, { policy_id: p.id, name: 'x', trigger: 'listening.alert', conditions: [], actions: [{ type: 'notify', to: 'users', user_ids: [w.agentId] }], scope: { brand_ids: [w.brand], channel_ids: [] } }))
      .rejects.toMatchObject({ code: 'validation_failed' });   // care agents have no listening.read
    await createAutomationRule(w.owner, { policy_id: p.id, name: 'Tell Ana', trigger: 'listening.alert', enabled: true, conditions: [], actions: [{ type: 'notify', to: 'users', user_ids: [w.analystId] }], scope: { brand_ids: [w.brand], channel_ids: [] } });
    const cat = await automationCatalog(w.owner);
    expect(cat.triggers.find((t) => t.trigger === 'listening.alert')).toMatchObject({ available: true });
    expect(cat.integration_jobs.some((j) => j.kind === 'mailchimp.create_campaign_draft')).toBe(false);

    const alertId = await fireAlert(w);
    const evt = { event_type: 'listening.alert_fired', workspace_id: w.ws, aggregate_id: alertId, payload: { ruleId: 'r', searchId: 's', brandId: w.brand, simulated: true, origin: { kind: 'system', id: null } } };
    await handleInboxEvent(evt);
    await handleInboxEvent(evt);   // redelivery
    const runs = await testPool().query(`SELECT outcome, subject_type, subject_id FROM automation_runs WHERE workspace_id=$1 AND trigger='listening.alert'`, [w.ws]);
    expect(runs.rows).toEqual([{ outcome: 'succeeded', subject_type: 'listening_alert', subject_id: alertId }]);
    const n = await testPool().query(`SELECT user_id, link_path FROM notifications WHERE workspace_id=$1 AND kind='automation.notify'`, [w.ws]);
    expect(n.rows).toEqual([{ user_id: w.analystId, link_path: `/listening/alerts/${alertId}` }]);
  });

  it('Slack listening alerts: simulated alerts reach only simulated Slack installs, with the alert link', async () => {
    const w = await world();
    const { enqueueSlackEvent } = await import('@social-lite/services/integrations-v35/slack/service');
    const slack = await createSimulatedIntegration(w.owner, { connector: 'slack' });
    const res = await testPool().query<{ id: string }>(`INSERT INTO integration_resources(workspace_id, integration_id, resource_type, external_id, name, metadata) VALUES ($1,$2,'channel','C1','alerts','{"is_private":true}') RETURNING id`, [w.ws, slack.id]);
    await testPool().query(`INSERT INTO slack_alert_routes(workspace_id, integration_id, resource_id, categories, created_by) VALUES ($1,$2,$3,ARRAY['listening_alerts'],$4)`, [w.ws, slack.id, res.rows[0]!.id, w.ownerId]);
    expect(await enqueueSlackEvent({ workspaceId: w.ws, category: 'listening_alerts', eventKey: 'live-1', brandId: w.brand, text: 'x', linkPath: '/x', simulated: false })).toBe(0);
    expect(await enqueueSlackEvent({ workspaceId: w.ws, category: 'listening_alerts', eventKey: 'sim-1', brandId: w.brand, text: 'x', linkPath: '/x', simulated: true })).toBe(1);
  });

  it('approval.decided bridges to content.approved and runs the content.approved trigger once', async () => {
    resetInboxHooksForTests(); resetAutomationInstallForTests(); installAutomation();
    const w = await world({ approvalRequired: true });
    const editor = await member(w.ws, 'editor', w.brand, 'Ed Editor');
    const p = await policy(w, ['notify']);
    await createAutomationRule(w.owner, { policy_id: p.id, name: 'Approved → Ana', trigger: 'content.approved', enabled: true, conditions: [], actions: [{ type: 'notify', to: 'users', user_ids: [w.analystId] }], scope: { brand_ids: [w.brand], channel_ids: [] } });
    const conns = await seedConnections(w.ws, w.brand);
    const ids = [conns.facebook];
    const ed = await v2Ctx(editor.id, w.ws);
    const draft = { baseText: 'Launch', baseLink: null, baseAssetIds: [] as string[], variants: ids.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) };
    const { id: postId } = await createPost(ed, w.brand, { title: 'Launch', draft }, randomUUID());
    const sub = (await submitForReview(ed, postId, { expected_version: 1, connection_ids: ids }, randomUUID())).body as { approval: { id: string; fingerprint: string } };
    await approve(w.owner, sub.approval.id, sub.approval.fingerprint);
    // The collaboration consumer handles 'approval.decided' (twice: at-least-once) → one content.approved row each.
    const decided = (await testPool().query(`SELECT event_type, workspace_id, aggregate_id, payload FROM outbox WHERE aggregate_id=$1 AND event_type='approval.decided'`, [sub.approval.id])).rows[0];
    await handleEvent(decided);
    await handleEvent(decided);
    const bridged = (await testPool().query(`SELECT event_type, workspace_id, aggregate_id, payload FROM outbox WHERE aggregate_id=$1 AND event_type='content.approved'`, [sub.approval.id])).rows;
    expect(bridged.length).toBeGreaterThanOrEqual(1);
    expect(bridged[0].payload).toMatchObject({ postId, brandId: w.brand });
    for (const b of bridged) await handleInboxEvent(b);
    const runs = await testPool().query(`SELECT outcome, subject_type, subject_id FROM automation_runs WHERE workspace_id=$1 AND trigger='content.approved'`, [w.ws]);
    expect(runs.rows).toEqual([{ outcome: 'succeeded', subject_type: 'post', subject_id: postId }]);
  });
});

describe('Stream F wiring — channels', () => {
  it('a GBP Pub/Sub review notification polls the matching Google reviews channel (through stream C’s handler)', async () => {
    const w = await world();
    registerGbpReviewNotifications();
    const i = await createSimulatedIntegration(w.owner, { connector: 'google_business_profile', brand_id: w.brand });
    const acc = await integrationAccounts(w.owner, i.id);
    const loc = acc.items[0]!.account_id;
    const ch = await enableIntegrationChannel(w.owner, { integration_id: i.id, account_id: loc });
    await testPool().query(`INSERT INTO integration_resources(workspace_id, integration_id, resource_type, external_id, name, selected) VALUES ($1,$2,'location',$3,'Loc',true) ON CONFLICT DO NOTHING`, [w.ws, i.id, loc]);
    const account = (await testPool().query(`SELECT external_account_id FROM integration_connections WHERE id=$1`, [i.id])).rows[0].external_account_id;
    await recordSimulatedReview({ store: store() }, account, { id: `mock_rev_${randomUUID().slice(0, 8)}`, location: loc, reviewer: 'Pia', rating: 2, comment: 'Cold food', at: new Date().toISOString() });
    expect((await listConversations(w.agent, { queue: 'all', kind: 'review' })).items).toHaveLength(0);
    // Stream C's verified handler (verification happens at the ingress; here the stored event is processed).
    const data = Buffer.from(JSON.stringify({ notificationType: 'NEW_REVIEW', location: loc, review: `${loc}/reviews/x` })).toString('base64');
    const ev = await testPool().query<{ id: string }>(
      `INSERT INTO integration_events(connector, dedupe_key, workspace_id, integration_id, event_type, origin, body, state) VALUES ('google_business_profile',$1,$2,$3,'NEW_REVIEW','external',$4,'pending') RETURNING id`,
      [`pubsub:${randomUUID()}`, w.ws, i.id, JSON.stringify({ message: { data, messageId: randomUUID() } })]);
    expect(await processIntegrationEvent(ev.rows[0]!.id)).toBe('processed');
    const list = await listConversations(w.agent, { queue: 'all', kind: 'review' });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.channel.id).toBe(ch.id);
    // A notification for another location polls nothing.
    expect(await onGbpReviewNotification({ integrationIds: [i.id], notificationType: 'NEW_REVIEW', locationName: 'accounts/0/locations/none' })).toEqual([]);
  });

  it('removing a Telegram channel releases Relay’s webhook, and never another app’s', async () => {
    const w = await world();
    const conn = await connectMock(w.owner, w.brand, { provider: 'telegram', display_name: 'Simulated bot' });
    const ch = await enableChannel(w.owner, { connection_id: conn.id });
    const bot = conn.provider_account_id;
    const hookKey = `mock_webhook_${bot.replace(/^mock_/, '')}`;
    await recordSimulatedTelegramWebhook({ store: store() }, bot, '');
    await checkTelegramWebhook(w.owner, ch.id);
    await claimTelegramWebhook(w.owner, ch.id, { confirm_no_other_consumer: true });
    expect(String((await store().get('telegram', hookKey))?.data.url)).toContain(`/api/inbox/telegram/${ch.id}`);
    await removeChannel(w.owner, ch.id);
    expect((await store().get('telegram', hookKey))?.data.url ?? '').toBe('');
    const row = (await testPool().query(`SELECT disconnected_at, secret_enc FROM inbox_channels WHERE id=$1`, [ch.id])).rows[0];
    expect(row.disconnected_at).not.toBeNull();
    expect(row.secret_enc).toBeNull();
    const a = (await testPool().query(`SELECT diff FROM audit_events WHERE resource_id=$1 AND action='inbox.channel_removed'`, [ch.id])).rows[0];
    expect(a.diff).toMatchObject({ telegram_webhook: 'released' });

    // Another app's webhook: untouched by removal.
    const conn2 = await connectMock(w.owner, w.brand, { provider: 'telegram', display_name: 'Other bot' });
    const ch2 = await enableChannel(w.owner, { connection_id: conn2.id });
    const key2 = `mock_webhook_${conn2.provider_account_id.replace(/^mock_/, '')}`;
    await recordSimulatedTelegramWebhook({ store: store() }, conn2.provider_account_id, 'https://other-app.example/hook');
    await removeChannel(w.owner, ch2.id);
    expect((await store().get('telegram', key2))?.data.url).toBe('https://other-app.example/hook');
  });
});

describe('Stream F revocation + admin', () => {
  it('a queued integration job stops when its requester loses access (nothing is sent)', async () => {
    const w = await world();
    let calls = 0;
    registerSyncExecutor({ kind: 'hubspot.f_test', run: async () => { calls++; return { kind: 'succeeded' } as never; } });
    const integ = await createSimulatedIntegration(w.owner, { connector: 'hubspot', brand_id: w.brand });
    const job = await enqueueSyncJob(w.agent, { integrationId: integ.id, kind: 'hubspot.f_test', relayType: 'case', relayId: randomUUID(), idempotencyKey: `f-${randomUUID()}`, payload: {} });
    await testPool().query(`UPDATE memberships SET status='suspended' WHERE workspace_id=$1 AND user_id=$2`, [w.ws, w.agentId]);
    expect(await runSyncJob(job.job.id, 'test')).toBe('failed');
    expect(calls).toBe(0);
    const r = (await testPool().query(`SELECT last_error_code FROM integration_sync_jobs WHERE id=$1`, [job.job.id])).rows[0];
    expect(r.last_error_code).toBe('requester_lost_access');
  });

  it('admin summary reuses each stream’s service and platform health is counts only (no names, no text)', async () => {
    const w = await world();
    await simulateInbound(w.owner, w.channelId, { kind: 'dm', text: 'SECRET-CUSTOMER-TEXT where is my order', name: 'Cara Private' });
    const sum = await careAdminSummary(w.owner);
    const inbox = await inboxAdminOverview(w.owner);
    expect(sum.inbox).toEqual({ ...inbox, generated_at: expect.any(String) });
    expect(sum.listening).not.toBeNull();
    expect(sum.ai).not.toBeNull();
    expect(sum.integrations).not.toBeNull();
    expect(JSON.stringify(sum)).not.toContain('SECRET-CUSTOMER-TEXT');
    expect(JSON.stringify(sum)).not.toContain('Cara Private');
    await expect(careAdminSummary(w.agent)).rejects.toMatchObject({ code: 'forbidden' });
    const integ = await integrationsAdminOverview(w.owner);
    expect(integ.integrations).toEqual([]);
    const p = await platformCareHealth();
    const text = JSON.stringify(p);
    expect(text).not.toContain('SECRET-CUSTOMER-TEXT');
    expect(text).not.toContain('Stream F');   // no workspace names
    expect(p.inbox.channels_active).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ MCP
function jwt(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = { iss: ISS, aud: RESOURCE, azp: 'test-client', iat: now, exp: now + 300, typ: 'Bearer', scope: 'social.read', acr: 'mfa', amr: ['pwd', 'otp'], auth_time: now, ...claims };
  const data = `${enc({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${enc(body)}`;
  return `${data}.${sign('sha256', Buffer.from(data), keys.privateKey).toString('base64url')}`;
}
async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'relay-protocol-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (url: string | URL, init?: RequestInit) => handleMcpHttp(new Request(url, init)) }));
  return client;
}
type ToolOut = { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ type: string; text?: string }> };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as ToolOut;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ok = (r: ToolOut) => { if (r.isError) throw new Error(`tool error: ${r.content[0]?.text}`); return r.structuredContent as Record<string, any>; };
const err = (r: ToolOut) => { expect(r.isError).toBe(true); return (JSON.parse(r.content[0]!.text!) as { error: { code: string } }).error; };

async function mcpWorld(scopes: string, role: 'care_agent' | 'owner' = 'care_agent', consentBrands: 'A' | null = null) {
  const sub = randomUUID();
  const u = await testPool().query<{ id: string }>(`INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified, name) VALUES ($1,$2,$3,true,'MCP Agent') RETURNING id`,
    [ISS, sub, `mcp-${sub.slice(0, 8)}@test.relay.test`]);
  const userId = u.rows[0]!.id;
  const w = await world();
  if (role === 'owner') await addMember(w.ws, userId, 'owner');
  else { await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [w.ws, userId]); await grant(w.ws, userId, 'care_agent', w.brand); }
  const client = await connect(jwt({ sub, scope: scopes }));
  await call(client, 'list_workspaces');
  const web = await v2Ctx(userId, w.ws);
  const row = await testPool().query<{ id: string }>(`SELECT id FROM mcp_clients WHERE owner_user_id=$1 AND status='pending'`, [userId]);
  await consentClient(web, row.rows[0]!.id, { scopes: scopes.split(' ') as never, brand_ids: consentBrands === 'A' ? [w.brand] : null });
  return { ...w, userId, client, web, rowId: row.rows[0]!.id };
}

describe('Stream F MCP — inbox, cases, listening, AI preparation', () => {
  it('reads exclude internal notes; draft_reply saves a draft and never sends; assignment + cases are idempotent and versioned', async () => {
    const m = await mcpWorld('inbox.read inbox.draft inbox.assign cases.manage');
    await simulateInbound(m.owner, m.channelId, { kind: 'dm', text: 'Where is my order?', name: 'Cara' });
    const list = ok(await call(m.client, 'list_conversations', { workspace_id: m.ws }));
    expect(list.items).toHaveLength(1);
    const convId = list.items[0].id as string;
    await addNote(m.owner, convId, { body: 'INTERNAL-NOTE do not share' });
    const conv = ok(await call(m.client, 'get_conversation', { workspace_id: m.ws, conversation_id: convId }));
    expect(JSON.stringify(conv)).not.toContain('INTERNAL-NOTE');
    expect(conv.timeline.some((e: { type: string; body?: string }) => e.type === 'message' && e.body === 'Where is my order?')).toBe(true);
    expect(conv.content_notice).toMatch(/untrusted/);

    const d = ok(await call(m.client, 'draft_reply', { workspace_id: m.ws, conversation_id: convId, mode: 'private_message', body: 'It ships today.', base_version: conv.version, idempotency_key: 'draft-0001' }));
    expect(d).toMatchObject({ saved: true, sent: false });
    const again = ok(await call(m.client, 'draft_reply', { workspace_id: m.ws, conversation_id: convId, mode: 'private_message', body: 'It ships today.', base_version: conv.version, idempotency_key: 'draft-0001' }));
    expect(again.duplicate).toBe(true);
    expect(err(await call(m.client, 'draft_reply', { workspace_id: m.ws, conversation_id: convId, mode: 'private_message', body: 'Different', base_version: conv.version, idempotency_key: 'draft-0001' })).code).toBe('idempotency_conflict');
    expect((await testPool().query(`SELECT count(*)::int n FROM inbox_reply_attempts WHERE conversation_id=$1`, [convId])).rows[0].n).toBe(0);
    expect((await getConversation(m.web, convId)).draft?.body).toBe('It ships today.');

    const a = ok(await call(m.client, 'assign_conversation', { workspace_id: m.ws, conversation_id: convId, assignee_id: m.agentId, idempotency_key: 'assign-0001' }));
    expect(a.assignee.id).toBe(m.agentId);
    expect(err(await call(m.client, 'assign_conversation', { workspace_id: m.ws, conversation_id: convId, assignee_id: m.analystId, idempotency_key: 'assign-0002' })).code).toBe('validation_failed');

    const c1 = ok(await call(m.client, 'create_case', { workspace_id: m.ws, conversation_id: convId, title: 'Late order', idempotency_key: 'case-0001' }));
    const c2 = ok(await call(m.client, 'create_case', { workspace_id: m.ws, conversation_id: convId, title: 'Late order', idempotency_key: 'case-0001' }));
    expect(c2.id).toBe(c1.id);
    expect((await testPool().query(`SELECT count(*)::int n FROM care_cases WHERE workspace_id=$1`, [m.ws])).rows[0].n).toBe(1);
    expect(err(await call(m.client, 'update_case', { workspace_id: m.ws, case_id: c1.id, version: c1.version + 5, state: 'waiting', idempotency_key: 'case-upd-01' })).code).toBe('version_conflict');
    const res = ok(await call(m.client, 'update_case', { workspace_id: m.ws, case_id: c1.id, version: c1.version, state: 'resolved', resolution_reason: 'Shipped', idempotency_key: 'case-upd-02' }));
    expect(res.state).toBe('resolved');
    // AT14: the app sees the same persisted state the MCP client changed; audit names the person.
    expect((await listConversations(m.web, { queue: 'all' })).items[0]).toMatchObject({ case: { id: c1.id, state: 'resolved' }, assignee: { id: m.agentId } });
    const audit = await testPool().query(`SELECT tool, result FROM mcp_audit WHERE client_row_id=$1 ORDER BY id`, [m.rowId]);
    expect(audit.rows.map((r) => r.tool)).toEqual(expect.arrayContaining(['draft_reply', 'assign_conversation', 'create_case', 'update_case']));
    expect(audit.rows.find((r) => r.tool === 'update_case' && r.result === 'error')).toBeTruthy();
  });

  it('scopes and brands narrow every tool; revocation ends access on the next call', async () => {
    const m = await mcpWorld('inbox.read', 'owner', 'A');
    await simulateInbound(m.owner, m.channelId, { kind: 'dm', text: 'Hi', name: 'Cara' });
    const connB = await connectMock(m.owner, m.brandB, { provider: 'facebook', display_name: 'Other Page' });
    const chB = await enableChannel(m.owner, { connection_id: connB.id });
    await simulateInbound(m.owner, chB.id, { kind: 'dm', text: 'Other brand', name: 'Dan' });
    const list = ok(await call(m.client, 'list_conversations', { workspace_id: m.ws }));
    expect(list.items.map((c: { brand_id: string }) => c.brand_id)).toEqual([m.brand]);
    const convB = (await listConversations(m.owner, { queue: 'all', channel_id: chB.id })).items[0]!.id;
    expect(err(await call(m.client, 'get_conversation', { workspace_id: m.ws, conversation_id: convB })).code).toBe('not_found');
    const convA = list.items[0].id as string;
    // No draft/listening scope on the token ⇒ the HTTP layer answers with an RFC 6750 scope challenge; nothing runs.
    await expect(call(m.client, 'draft_reply', { workspace_id: m.ws, conversation_id: convA, mode: 'private_message', body: 'x', base_version: 1, idempotency_key: 'draft-0002' })).rejects.toThrow(/Insufficient scope: needs inbox.draft/);
    await expect(call(m.client, 'query_listening', { workspace_id: m.ws, search_id: randomUUID(), view: 'timeline' })).rejects.toThrow(/Insufficient scope/);
    expect((await testPool().query(`SELECT count(*)::int n FROM inbox_drafts WHERE conversation_id=$1`, [convA])).rows[0].n).toBe(0);
    // Membership revocation (AT12) and client revocation both end access immediately.
    await testPool().query(`UPDATE memberships SET status='suspended' WHERE workspace_id=$1 AND user_id=$2`, [m.ws, m.userId]);
    expect(['not_found', 'forbidden', 'client_revoked']).toContain(err(await call(m.client, 'list_conversations', { workspace_id: m.ws })).code);
    await testPool().query(`UPDATE memberships SET status='active' WHERE workspace_id=$1 AND user_id=$2`, [m.ws, m.userId]);
    expect(ok(await call(m.client, 'list_conversations', { workspace_id: m.ws })).items).toHaveLength(1);
    await revokeClient(m.web, m.rowId);
    await expect(call(m.client, 'list_conversations', { workspace_id: m.ws })).rejects.toThrow(/revoked/);
  });

  it('listening queries carry coverage; AI preparation fails honestly without a provider and never needs a send scope', async () => {
    const m = await mcpWorld('listening.read inbox.read ai.prepare', 'owner');
    const s = await createSearch(m.owner, { brand_id: m.brand, name: 'Mentions', role: 'own', terms: ['vitalos'], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] });
    const searches = ok(await call(m.client, 'list_listening_searches', { workspace_id: m.ws }));
    expect(searches.items.map((x: { id: string }) => x.id)).toContain(s.id);
    const t = ok(await call(m.client, 'query_listening', { workspace_id: m.ws, search_id: s.id, view: 'timeline', days: 7 }));
    expect(t.coverage).toBeTruthy();
    const mentions = ok(await call(m.client, 'query_listening', { workspace_id: m.ws, search_id: s.id, view: 'mentions' }));
    expect(Array.isArray(mentions.items)).toBe(true);
    expect(ok(await call(m.client, 'list_listening_alerts', { workspace_id: m.ws })).items).toEqual([]);
    await simulateInbound(m.owner, m.channelId, { kind: 'dm', text: 'Hello', name: 'Cara' });
    const conv = (await listConversations(m.owner, { queue: 'all' })).items[0]!.id;
    const e = err(await call(m.client, 'prepare_with_ai', { workspace_id: m.ws, task: 'summarize_conversation', conversation_id: conv, idempotency_key: 'ai-prep-0001' }));
    expect(e.code).toBe('not_configured');
    expect((await testPool().query(`SELECT count(*)::int n FROM ai_runs WHERE workspace_id=$1`, [m.ws])).rows[0].n).toBe(0);
    expect(err(await call(m.client, 'prepare_with_ai', { workspace_id: m.ws, task: 'summarize_listening', idempotency_key: 'ai-prep-0002' })).code).toBe('validation_failed');
  });
});

// Keep the assignment helper referenced (used by other suites through the same services).
void assignConversation;
