// V3.1 Admin §18: MCP-created drafts, Content hub imports and analytics syncs show up consistently in the main app and
// the admin views (change markers + admin read models), through the REAL MCP handler, import job and sync pipeline.
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdapterContext, HttpRequest, HttpResponse } from '@social-lite/core';
import { getPostDetail } from '@social-lite/services';
import { setMcpAuthTestOverrides } from '@social-lite/services/mcp/auth';
import { closeAllMcpSessions, handleMcpHttp } from '@social-lite/services/mcp/server';
import { consentClient } from '@social-lite/services/mcp/registry';
import { Client, StreamableHTTPClientTransport } from '@social-lite/services/mcp/sdk-client';
import { connectTestSource } from '@social-lite/services/content-hub/connections';
import { registerSelection } from '@social-lite/services/content-hub/items';
import { runImport } from '@social-lite/services/content-hub/imports';
import { ensureSyncCursors, runConnectionSync } from '@social-lite/services/analytics/sync';
import type { AnalyticsDeps } from '@social-lite/services/analytics/index';
import { adminAnalyticsOps, adminChanges, adminJobs, adminOverview } from '@social-lite/services/admin/index';
import { listActivity } from '@social-lite/services/product/activity';
import { addMember, closeTestPool, createBrand, createWorkspace, testPool, v2Ctx } from './helpers.js';
import { seedConnections } from './engine-helpers.js';
import { connection, publish } from './v3-analytics-helpers.js';

const ISS = 'https://idp.test/realms/relay';
const RESOURCE = 'http://localhost:3000/mcp';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ALL = 'social.read drafts.write reviews.submit publishing.schedule publishing.publish analytics.read reports.export';

beforeAll(() => { testPool(); setMcpAuthTestOverrides({ issuer: ISS, keys: async (kid) => (kid === 'k1' ? keys.publicKey : null) }); });
afterAll(async () => { await closeAllMcpSessions(); setMcpAuthTestOverrides(null); await closeTestPool(); });

function jwt(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${enc({ iss: ISS, aud: RESOURCE, azp: 'test-client', iat: now, exp: now + 300, typ: 'Bearer', sub, scope: ALL, acr: 'mfa', amr: ['pwd', 'otp'], auth_time: now })}`;
  return `${data}.${sign('sha256', Buffer.from(data), keys.privateKey).toString('base64url')}`;
}
type ToolOut = { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ type: string; text?: string }> };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as ToolOut;
const ok = (r: ToolOut) => { if (r.isError) throw new Error(`tool error: ${r.content[0]?.text}`); return r.structuredContent as Record<string, any>; };

async function mcpWorld() {
  const sub = randomUUID();
  const user = (await testPool().query<{ id: string }>(`INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified, name) VALUES ($1,$2,$3,true,'MCP admin') RETURNING id`, [ISS, sub, `mcpadm-${sub.slice(0, 8)}@test.relay.test`])).rows[0]!;
  const ws = await createWorkspace('MCP admin WS');
  const brand = await createBrand(ws, 'Brand A');
  await addMember(ws, user.id, 'owner');
  const conns = await seedConnections(ws, brand);
  const client = new Client({ name: 'relay-admin-sync-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { requestInit: { headers: { Authorization: `Bearer ${jwt(sub)}` } }, fetch: (u, i) => handleMcpHttp(new Request(u, i)) }));
  await call(client, 'list_workspaces');
  const web = await v2Ctx(user.id, ws);
  const row = (await testPool().query<{ id: string }>(`SELECT id FROM mcp_clients WHERE owner_user_id=$1 AND status='pending'`, [user.id])).rows[0]!;
  await consentClient(web, row.id, { scopes: ALL.split(' '), brand_ids: null });
  return { ws, brand, conns, client, web: () => v2Ctx(user.id, ws) };
}

describe('MCP, imports and analytics propagate to main + admin (§18)', () => {
  it('an MCP-created draft appears in the main app, the admin change feed and the audit log', async () => {
    const w = await mcpWorld();
    const before = (await adminChanges(await w.web())).topics;
    const d = ok(await call(w.client, 'create_draft', { workspace_id: w.ws, brand_id: w.brand, text: 'Drafted by an agent', connection_ids: [w.conns.facebook], idempotency_key: `d-${randomUUID()}` }));
    const post = await getPostDetail(await w.web(), d.post_id as string);
    expect(post.draft.baseText).toBe('Drafted by an agent');
    const after = (await adminChanges(await w.web())).topics;
    expect(after.content).not.toBe(before.content);
    expect(after.audit).not.toBe(before.audit);
    const act = await listActivity(await w.web(), { category: 'all', limit: 20 });
    expect(JSON.stringify(act)).toMatch(/post\.|mcp|draft/);
  });

  it('a Content hub import appears in content (new draft) and in admin job history', async () => {
    const w = await mcpWorld();
    const web = await w.web();
    const conn = await connectTestSource(web, { source: 'google', brand_id: w.brand });
    const sel = await registerSelection(web, { connection_id: conn.id, brand_id: w.brand, items: [{ id: 'demoDoc000000000000001' }] });
    const pv = ok(await call(w.client, 'preview_source', { workspace_id: w.ws, source_item_id: sel.items[0]!.id }));
    const sections = (pv.sections as Array<{ id: string }>).map((s) => s.id);
    const before = (await adminChanges(web)).topics;
    const q = ok(await call(w.client, 'import_source_to_draft', { workspace_id: w.ws, source_item_id: sel.items[0]!.id, fingerprint: pv.fingerprint, section_ids: [sections[0]], idempotency_key: `imp-${randomUUID()}` }));
    const queued = await adminJobs(await w.web(), { kind: 'import' });
    expect(queued.items.find((j) => j.id === q.import_id)).toMatchObject({ status: 'queued' });
    await runImport(q.import_id as string);
    const done = await adminJobs(await w.web(), { kind: 'import' });
    expect(done.items.find((j) => j.id === q.import_id)).toMatchObject({ status: 'completed', failed: false });
    const after = (await adminChanges(await w.web())).topics;
    expect(after.jobs).not.toBe(before.jobs);
    expect(after.content).not.toBe(before.content);
  });

  it('an analytics sync updates admin freshness (stale → fresh) and the jobs marker', async () => {
    const ws = await createWorkspace('Analytics admin WS', { isDemo: false });
    const brand = await createBrand(ws, 'Brand A');
    const owner = (await testPool().query<{ id: string }>(`INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified) VALUES ('test',$1,$2,true) RETURNING id`, [randomUUID(), `an-${randomUUID().slice(0, 8)}@t.test`])).rows[0]!;
    await addMember(ws, owner.id, 'owner');
    const ig = await connection(ws, brand, 'instagram');
    await publish({ workspaceId: ws }, brand, ig, 'instagram', new Date(Date.now() - 30 * 3600_000));
    const ctx = await v2Ctx(owner.id, ws);
    const before = await adminAnalyticsOps(ctx);
    expect(before.accounts.find((a) => a.connection_id === ig)).toMatchObject({ dataset: 'live', stale: true });
    const m0 = (await adminChanges(ctx)).topics.jobs;
    await ensureSyncCursors({ workspaceId: ws });
    const json = (status: number, body: unknown): HttpResponse => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const deps: AnalyticsDeps = {
      getCredentials: async (id) => {
        const c = (await testPool().query(`SELECT * FROM connections WHERE id=$1`, [id])).rows[0];
        return { credentials: { kind: 'meta_page' as const, pageAccessToken: 'page-token' }, connection: { id: c.id, provider: c.provider, providerAccountId: c.provider_account_id, displayName: c.display_name, metadata: {}, isMock: c.is_mock } };
      },
      adapterContext: async () => ({ transport: { mode: 'live', send: async (_r: HttpRequest) => json(200, { data: [{ name: 'views', period: 'lifetime', values: [{ value: 10 }] }, { name: 'reach', period: 'lifetime', values: [{ value: 7 }] }, { name: 'likes', period: 'lifetime', values: [{ value: 1 }] }, { name: 'comments', period: 'lifetime', values: [{ value: 0 }] }] }) }, now: () => new Date(), config: { apiVersion: 'v26.0' } }) as AdapterContext,
    };
    const s = await runConnectionSync(ig, deps, { jobKey: randomUUID() });
    expect(s.status).toBe('succeeded');
    const after = await adminAnalyticsOps(ctx);
    expect(after.accounts.find((a) => a.connection_id === ig)).toMatchObject({ stale: false, last_run: { status: 'succeeded' } });
    expect((await adminChanges(ctx)).topics.jobs).not.toBe(m0);
    const card = (await adminOverview(ctx)).cards.find((c) => c.key === 'analytics')!;
    expect(card.value).toBe(0);
  });
});
