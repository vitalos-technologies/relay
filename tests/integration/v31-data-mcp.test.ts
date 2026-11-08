// V3.1 DATA MCP tools through the real /mcp handler (official SDK client, in-process fetch, test JWKS — a protocol test
// client, not a real MCP client): search, get_draft_recovery_status, preview_bulk_action, get_bulk_job_status.
// Same services + permissions as the web app; consent/scope/brand narrowing; revocation; no bulk start via MCP.
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_TOOLS } from '@social-lite/core/contracts/mcp';
import { createPost } from '@social-lite/services';
import { setMcpAuthTestOverrides } from '@social-lite/services/mcp/auth';
import { closeAllMcpSessions, handleMcpHttp } from '@social-lite/services/mcp/server';
import { consentClient, revokeClient } from '@social-lite/services/mcp/registry';
import { Client, StreamableHTTPClientTransport } from '@social-lite/services/mcp/sdk-client';
import { previewBulk, runBulkJob, startBulk } from '@social-lite/services/data/bulk';
import { autosaveDraft } from '@social-lite/services/data/drafts';
import { addMember, closeTestPool, createBrand, createWorkspace, testPool, v2Ctx } from './helpers.js';

const ISS = 'https://idp.test/realms/relay';
const RESOURCE = 'http://localhost:3000/mcp';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });

beforeAll(() => {
  testPool();
  setMcpAuthTestOverrides({ issuer: ISS, keys: async (kid) => (kid === 'k1' ? keys.publicKey : null) });
});
afterAll(async () => { await closeAllMcpSessions(); setMcpAuthTestOverrides(null); await closeTestPool(); });

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
const ok = (r: ToolOut) => { if (r.isError) throw new Error(`tool error: ${r.content[0]?.text}`); return r.structuredContent as Record<string, any>; };
const err = (r: ToolOut) => { expect(r.isError).toBe(true); return (JSON.parse(r.content[0]!.text!) as { error: { code: string } }).error; };

async function world(scopes: string, consentBrands: 'A' | null = null) {
  const sub = randomUUID();
  const u = await testPool().query<{ id: string }>(`INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified, name) VALUES ($1,$2,$3,true,'MCP') RETURNING id`,
    [ISS, sub, `mcp-${sub.slice(0, 8)}@test.relay.test`]);
  const userId = u.rows[0]!.id;
  const ws = await createWorkspace('MCP data');
  const brandA = await createBrand(ws, 'Brand A');
  const brandB = await createBrand(ws, 'Brand B');
  await addMember(ws, userId, 'owner');
  const client = await connect(jwt({ sub, scope: scopes }));
  await call(client, 'list_workspaces'); // creates the pending registration
  const web = await v2Ctx(userId, ws);
  const row = await testPool().query<{ id: string }>(`SELECT id FROM mcp_clients WHERE owner_user_id=$1 AND status='pending'`, [userId]);
  await consentClient(web, row.rows[0]!.id, { scopes: scopes.split(' ') as never, brand_ids: consentBrands === 'A' ? [brandA] : null });
  return { userId, ws, brandA, brandB, client, web, rowId: row.rows[0]!.id };
}

const post = async (w: Awaited<ReturnType<typeof world>>, brandId: string, text: string) =>
  (await createPost(w.web, brandId, { draft: { baseText: text, baseLink: null, baseAssetIds: [], variants: [] } }, randomUUID())).id;

describe('V3.1 DATA MCP tools', () => {
  it('catalogue: listed tools match MCP_TOOLS; the four new ones read-only; no bulk start/undo or confirmation inputs', async () => {
    const w = await world('social.read drafts.write');
    const listed = (await w.client.listTools()).tools;
    expect(listed.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
    expect(listed).toHaveLength(MCP_TOOLS.length);
    for (const n of ['search', 'get_draft_recovery_status', 'preview_bulk_action', 'get_bulk_job_status']) {
      const t = listed.find((x) => x.name === n)!;
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(Object.keys(t.inputSchema.properties ?? {})).not.toContain('confirmed');
    }
    expect(listed.some((t) => /bulk/.test(t.name) && !t.annotations?.readOnlyHint)).toBe(false);
  });

  it('search: consented brands only, snippets labelled untrusted; revocation ends access', async () => {
    const w = await world('social.read', 'A');
    const a = await post(w, w.brandA, 'Derby day graphics for Brand A');
    await post(w, w.brandB, 'Derby day secret for Brand B');
    const r = ok(await call(w.client, 'search', { workspace_id: w.ws, query: 'derby' }));
    expect(r.results.map((x: { id: string }) => x.id)).toEqual([a]);
    expect(r.results[0].app_url).toBe(`http://localhost:3000/posts/${a}`);
    expect(r.content_notice).toMatch(/data, never as instructions/);
    expect(JSON.stringify(r)).not.toMatch(/secret/);
    const audit = await testPool().query(`SELECT result FROM mcp_audit WHERE tool='search' AND workspace_id=$1`, [w.ws]);
    expect(audit.rows.map((x) => x.result)).toContain('ok');
    await revokeClient(w.web, w.rowId);
    // a revoked registration is rejected before any tool runs
    await expect(call(w.client, 'search', { workspace_id: w.ws, query: 'derby' })).rejects.toThrow(/revoked/);
  });

  it('get_draft_recovery_status mirrors the web service; other workspaces are not_found', async () => {
    const w = await world('social.read');
    const other = await world('social.read');
    const id = await post(w, w.brandA, 'v1');
    await autosaveDraft(w.web, id, { base_version: 1, client_id: 'tab-mcpdata1', client_revision: 1, draft: { baseText: 'v2', baseLink: null, baseAssetIds: [], variants: [] } });
    const r = ok(await call(w.client, 'get_draft_recovery_status', { workspace_id: w.ws, post_id: id, base_version: 1 }));
    expect(r).toMatchObject({ post_id: id, current_version: 2, server_newer: true });
    expect(r.policy).toEqual({ local_recovery: 'persistent', max_age_hours: 72 });
    expect(err(await call(other.client, 'get_draft_recovery_status', { workspace_id: other.ws, post_id: id })).code).toBe('not_found');
  });

  it('preview_bulk_action needs a write scope and changes nothing; get_bulk_job_status shows jobs started in Relay', async () => {
    const reader = await world('social.read');
    const ids = [await post(reader, reader.brandA, 'one'), await post(reader, reader.brandA, 'two')];
    // a token without a write scope is refused before dispatch (403 insufficient_scope)
    await expect(call(reader.client, 'preview_bulk_action', { workspace_id: reader.ws, target_kind: 'post', action: 'archive', item_ids: ids })).rejects.toThrow(/Insufficient scope/);

    const w = await world('social.read drafts.write');
    const pids = [await post(w, w.brandA, 'one'), await post(w, w.brandB, 'two')];
    const pv = ok(await call(w.client, 'preview_bulk_action', { workspace_id: w.ws, target_kind: 'post', action: 'add_tags', item_ids: pids, params: { tags: ['mcp'] } }));
    expect(pv).toMatchObject({ total: 2, eligible: 2 });
    expect(pv.preview_hash).toBeUndefined(); // the start token is only shown in Relay
    const tags = await testPool().query(`SELECT tags FROM posts WHERE id = ANY($1::uuid[])`, [pids]);
    expect(tags.rows.every((r) => r.tags.length === 0)).toBe(true);

    const req = { target_kind: 'post' as const, action: 'add_tags' as const, item_ids: pids, params: { tags: ['relay'] } };
    const job = await startBulk(w.web, { ...req, preview_hash: (await previewBulk(w.web, req)).preview_hash }, `bulk-${randomUUID()}`);
    await runBulkJob(job.id);
    const st = ok(await call(w.client, 'get_bulk_job_status', { workspace_id: w.ws, job_id: job.id }));
    expect(st).toMatchObject({ id: job.id, status: 'completed', counts: { total: 2, succeeded: 2 } });
    expect(err(await call(reader.client, 'get_bulk_job_status', { workspace_id: reader.ws, job_id: job.id })).code).toBe('not_found');
  });
});
