// V4 stream ENT — dispatch-time entitlement re-checks in the WORKER paths and MCP (brief §13, acceptance §18.13/§18.15):
// queued social-inbox replies, business-integration sync jobs, listening matching and MCP tools over the protocol.
// Held work is never dropped or duplicated and is released when access returns. Billing facts are injected through the
// entitlement source seam (the billing stream's getBillingState shape).
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BillingState } from '@social-lite/core/contracts/v4-billing';
import type { PlanId } from '@social-lite/core/contracts/v4-plans';
import type { SyncOutcome } from '@social-lite/core/contracts/v35-connectors';
import type { Ctx } from '@social-lite/services';
import { connectMock } from '@social-lite/services/connections/index';
import { dispatchReply, enableChannel, listConversations, getConversation, requestReply, simulateInbound } from '@social-lite/services/inbox/index';
import { createSimulatedIntegration, enqueueSyncJob, registerSyncExecutor, resetConnectorRegistrationsForTests, runSyncJob } from '@social-lite/services/connectors/index';
import { createSearch, observeMessage } from '@social-lite/services/listening/index';
import { setBillingStateSourceForTests, stubBillingState } from '@social-lite/services/entitlements/source';
import { invalidateEntitlements } from '@social-lite/services/entitlements/resolve';
import { automationHold, reevaluateHolds } from '@social-lite/services/entitlements/holds';
import { setMcpAuthTestOverrides } from '@social-lite/services/mcp/auth';
import { closeAllMcpSessions, handleMcpHttp } from '@social-lite/services/mcp/server';
import { consentClient } from '@social-lite/services/mcp/registry';
import { Client, StreamableHTTPClientTransport } from '@social-lite/services/mcp/sdk-client';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, testPool, v2Ctx } from './helpers.js';

const db = () => testPool();
const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const states = new Map<string, Partial<BillingState>>();
const onPlan = (ws: string, plan: PlanId, extra: Partial<BillingState> = {}) =>
  states.set(ws, { plan_id: plan, status: 'active', seats: 1, current_period: { start: iso(-DAY), end: iso(29 * DAY) }, access: 'full', access_reason: null, ...extra });
const restrict = (ws: string) => onPlan(ws, 'professional', { status: 'expired', access: 'restricted', access_reason: 'Your trial has ended. Choose a plan to resume paid actions.' });

const ISS = 'https://idp.test/realms/relay';
const RESOURCE = 'http://localhost:3000/mcp';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });

beforeAll(() => {
  testPool();
  setBillingStateSourceForTests(async (q, ws) => ({ ...(await stubBillingState(q, ws)), ...(states.get(ws) ?? {}) }));
  setMcpAuthTestOverrides({ issuer: ISS, keys: async (kid) => (kid === 'k1' ? keys.publicKey : null) });
});
beforeEach(() => resetConnectorRegistrationsForTests());
afterEach(() => invalidateEntitlements());
afterAll(async () => { setBillingStateSourceForTests(null); await closeAllMcpSessions(); setMcpAuthTestOverrides(null); await closeTestPool(); });

async function inboxWorld() {
  const ws = await createWorkspace('Inbox ENT');
  const brand = await createBrand(ws, 'Care');
  const o = await createUser(undefined, 'Olive Owner');
  await addMember(ws, o.id, 'owner');
  const owner = await v2Ctx(o.id, ws);
  const conn = await connectMock(owner, brand, { provider: 'facebook', display_name: 'Simulated Page', scenario: 'success' });
  const ch = await enableChannel(owner, { connection_id: conn.id });
  return { ws, brand, owner, channelId: ch.id, pageId: conn.provider_account_id };
}

describe('queued replies: held at dispatch, released once (§18.13)', () => {
  it('restricted ⇒ new sends refused; an already-queued reply is held (nothing sent) and sends once when access returns', async () => {
    const w = await inboxWorld();
    await simulateInbound(w.owner, w.channelId, { kind: 'dm', text: 'Where is my order?', name: 'Cara' });
    const conv = await getConversation(w.owner, (await listConversations(w.owner, { queue: 'all' })).items[0]!.id);
    const { attempt } = await requestReply(w.owner, conv.id, { mode: 'private_message', body: 'It ships today.', base_version: conv.version, idempotency_key: randomUUID().replace(/-/g, '') });
    restrict(w.ws);
    await expect(requestReply(w.owner, conv.id, { mode: 'private_message', body: 'Another', base_version: conv.version + 1, idempotency_key: randomUUID().replace(/-/g, '') }))
      .rejects.toMatchObject({ code: 'entitlement_required', details: { reason: 'access_restricted' } });
    expect(await dispatchReply(attempt.id, 'w1')).toBe('queued');
    const held = await db().query(`SELECT state, error_code, error_message, attempts FROM inbox_reply_attempts WHERE id=$1`, [attempt.id]);
    expect(held.rows[0]).toMatchObject({ state: 'queued', error_code: 'entitlement_hold', attempts: 0, error_message: expect.stringMatching(/^Held: .*trial has ended/) });
    expect(await dispatchReply(attempt.id, 'w1')).toBe('skipped'); // re-check later, not in a tight loop
    const sentBefore = (await db().query(`SELECT count(*)::int n FROM mock_provider_objects WHERE account_id=$1 AND data->>'from'='page'`, [w.pageId])).rows[0].n;
    expect(sentBefore).toBe(0);
    states.delete(w.ws);
    const r = await reevaluateHolds(w.ws);
    expect(r.released.replies).toBe(1);
    expect(await dispatchReply(attempt.id, 'w1')).toBe('sent');
    expect(await dispatchReply(attempt.id, 'w1')).toBe('skipped');
    const sent = await db().query(`SELECT count(*)::int n FROM inbox_reply_attempts WHERE conversation_id=$1 AND state='sent'`, [conv.id]);
    expect(sent.rows[0].n).toBe(1);
  });
});

describe('business-integration sync jobs: held, charged once, released (§18.13)', () => {
  it('a restricted workspace keeps the job queued with the reason (executor never called); access returns ⇒ runs once', async () => {
    const ws = await createWorkspace('Sync ENT');
    await createBrand(ws, 'B');
    const o = await createUser(undefined, 'Owner');
    await addMember(ws, o.id, 'owner');
    const owner = await v2Ctx(o.id, ws);
    let calls = 0;
    registerSyncExecutor({ kind: 'slack.post_message', async run(): Promise<SyncOutcome> { calls++; return { kind: 'succeeded', externalId: `ext-${calls}` }; } });
    const integ = await createSimulatedIntegration(owner, { connector: 'slack' });
    const { job } = await enqueueSyncJob(owner, { integrationId: integ.id, kind: 'slack.post_message', relayType: 'case', relayId: randomUUID(), payload: {} });
    restrict(ws);
    expect(await runSyncJob(job.id, 'w')).toBe('waiting_retry');
    expect(calls).toBe(0);
    const row = await db().query(`SELECT state, last_error_code, attempts FROM integration_sync_jobs WHERE id=$1`, [job.id]);
    expect(row.rows[0]).toMatchObject({ state: 'queued', last_error_code: 'entitlement_hold', attempts: 0 });
    states.delete(ws);
    expect((await reevaluateHolds(ws)).released.sync_jobs).toBe(1);
    expect(await runSyncJob(job.id, 'w')).toBe('succeeded');
    expect(calls).toBe(1);
    const used = await db().query(`SELECT used FROM usage_counters WHERE workspace_id=$1 AND meter='integration.jobs' AND team_id IS NULL`, [ws]);
    expect(Number(used.rows[0].used)).toBe(1);
    // Standard does not include business integrations: enqueuing is refused with the upgrade target
    onPlan(ws, 'standard');
    await expect(enqueueSyncJob(owner, { integrationId: integ.id, kind: 'slack.post_message', relayType: 'case', relayId: randomUUID(), payload: {} }))
      .rejects.toMatchObject({ code: 'entitlement_required', details: { feature: 'integrations_business', upgrade_to: 'professional' } });
  });
});

describe('automations and listening: blocked/paused with the reason, data kept', () => {
  it('automation runs are blocked with a visible reason on plans without automations', async () => {
    const ws = await createWorkspace('Auto ENT');
    onPlan(ws, 'standard');
    expect(await automationHold(db(), ws)).toMatchObject({ held: true, message: expect.stringMatching(/^Held by plan: Automations isn’t included in Standard/) });
    states.delete(ws);
    expect(await automationHold(db(), ws)).toEqual({ held: false });
  });

  it('restricted ⇒ new public items are still observed but not matched; access returns ⇒ searches re-match stored items', async () => {
    const w = await inboxWorld();
    const s = await createSearch(w.owner, { brand_id: w.brand, name: 'Orders', role: 'own', terms: ['espresso'], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] } as never);
    await db().query(`UPDATE listening_searches SET rematch_state='idle' WHERE id=$1`, [s.id]);
    await reevaluateHolds(w.ws); // record the current (full) access
    restrict(w.ws);
    await reevaluateHolds(w.ws);
    const r = await simulateInbound(w.owner, w.channelId, { kind: 'comment', text: 'Best espresso in town', name: 'Pat' });
    const m = (await db().query<{ id: string }>(`SELECT id FROM inbox_messages WHERE external_id=$1`, [r.external_id])).rows[0]!;
    const res = await observeMessage(m.id);
    expect(res.observationId).toBeTruthy();
    expect(res.matched).toEqual([]);
    states.delete(w.ws);
    const ev = await reevaluateHolds(w.ws);
    expect(ev.released.searches_rematched).toBe(1);
    expect((await db().query(`SELECT rematch_state FROM listening_searches WHERE id=$1`, [s.id])).rows[0].rematch_state).toBe('pending');
  });
});

// ------------------------------------------------------------------ MCP over the protocol
function jwt(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = { iss: ISS, aud: RESOURCE, azp: 'test-client', iat: now, exp: now + 300, typ: 'Bearer', scope: 'social.read drafts.write', acr: 'mfa', amr: ['pwd', 'otp'], auth_time: now, ...claims };
  const data = `${enc({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${enc(body)}`;
  return `${data}.${sign('sha256', Buffer.from(data), keys.privateKey).toString('base64url')}`;
}
type ToolOut = { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ type: string; text?: string }> };
const errOf = (r: ToolOut) => (JSON.parse(r.content[0]!.text!) as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;

async function mcpWorld(): Promise<{ ws: string; brand: string; client: Client; web: Ctx }> {
  const sub = randomUUID();
  const u = (await db().query<{ id: string }>(`INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified, name) VALUES ($1,$2,$3,true,'MCP') RETURNING id`, [ISS, sub, `mcp-${sub.slice(0, 8)}@test.relay.test`])).rows[0]!;
  const ws = await createWorkspace('MCP ENT');
  const brand = await createBrand(ws, 'A');
  await addMember(ws, u.id, 'owner');
  const client = new Client({ name: 'relay-ent-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { requestInit: { headers: { Authorization: `Bearer ${jwt({ sub })}` } }, fetch: (url, init) => handleMcpHttp(new Request(url, init)) }));
  await client.callTool({ name: 'list_workspaces', arguments: {} });
  const web = await v2Ctx(u.id, ws);
  const row = (await db().query<{ id: string }>(`SELECT id FROM mcp_clients WHERE owner_user_id=$1 AND status='pending'`, [u.id])).rows[0]!;
  await consentClient(web, row.id, { scopes: ['social.read', 'drafts.write'], brand_ids: null });
  return { ws, brand, client, web };
}

describe('MCP tools enforce the plan (§18.13)', () => {
  it('legacy: tools work; Standard: refused with entitlement_required (audited as denied); restricted: reads ok, writes refused', async () => {
    const w = await mcpWorld();
    const call = async (name: string, args: Record<string, unknown>) => (await w.client.callTool({ name, arguments: args })) as ToolOut;
    expect((await call('list_brands', { workspace_id: w.ws })).isError).toBeFalsy();
    onPlan(w.ws, 'standard');
    const denied = await call('list_brands', { workspace_id: w.ws });
    expect(denied.isError).toBe(true);
    expect(errOf(denied)).toMatchObject({ code: 'entitlement_required', details: { feature: 'mcp', upgrade_to: 'professional' } });
    const audit = await db().query(`SELECT result, error_code FROM mcp_audit WHERE workspace_id=$1 ORDER BY id DESC LIMIT 1`, [w.ws]);
    expect(audit.rows[0]).toEqual({ result: 'denied', error_code: 'entitlement_required' });
    restrict(w.ws);
    expect((await call('list_brands', { workspace_id: w.ws })).isError).toBeFalsy();
    const write = await call('create_draft', { workspace_id: w.ws, brand_id: w.brand, text: 'Hello', connection_ids: [], idempotency_key: `d-${randomUUID()}` });
    expect(errOf(write)).toMatchObject({ code: 'entitlement_required', details: { reason: 'access_restricted' } });
    // one unit per allowed call, in the period bucket of the billing state at the time (calendar month for legacy)
    const used = await db().query(`SELECT sum(used)::int n FROM usage_counters WHERE workspace_id=$1 AND meter='mcp.calls' AND team_id IS NULL`, [w.ws]);
    expect(used.rows[0].n).toBe(2);
  });
});
