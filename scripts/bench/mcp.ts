// MCP tool latency (brief §17), measured through the real /mcp Streamable HTTP handler in-process (official SDK client
// → handleMcpHttp → JWT verification → consent/scope checks → shared services → audit). Two numbers per tool:
//  - client_ms: what an MCP client waits for (JSON-RPC over the in-process transport, no network);
//  - server_ms: the tool's own latency as recorded in mcp_audit.latency_ms (authority + service + audit write).
// No tool measured here calls a provider or other external service in-request (provider_ms is 0 by construction:
// analytics_overview reads stored facts; heavy work is async jobs). Test-only JWT keys; throwaway database only.
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { Pool } from '@social-lite/db';
import { setMcpAuthTestOverrides } from '@social-lite/services/mcp/auth';
import { closeAllMcpSessions, handleMcpHttp } from '@social-lite/services/mcp/server';
import { consentClient } from '@social-lite/services/mcp/registry';
import { Client, StreamableHTTPClientTransport } from '@social-lite/services/mcp/sdk-client';
import { BENCH_ISSUER, type GeneratedWorkspace } from './generate.js';
import { ctxFor } from './scenarios.js';
import { summarize, type Summary } from './stats.js';

const RESOURCE = 'http://localhost:3000/mcp';
const SCOPES = 'social.read drafts.write reviews.submit publishing.schedule publishing.publish analytics.read reports.export';

export interface McpToolResult { tool: string; client_ms: Summary; server_ms: Summary; provider_ms: 0; errors: number }

export async function mcpScenario(pool: Pool, w: GeneratedWorkspace, samples: number, withAnalytics: boolean): Promise<McpToolResult[]> {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  setMcpAuthTestOverrides({ issuer: BENCH_ISSUER, keys: async (kid) => (kid === 'bench' ? keys.publicKey : null) });
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = { iss: BENCH_ISSUER, aud: RESOURCE, azp: 'bench-client', sub: w.ownerSub, iat: now, exp: now + 3600, typ: 'Bearer', scope: SCOPES, acr: 'mfa', amr: ['pwd', 'otp'], auth_time: now };
  const data = `${enc({ alg: 'RS256', typ: 'JWT', kid: 'bench' })}.${enc(body)}`;
  const token = `${data}.${sign('sha256', Buffer.from(data), keys.privateKey).toString('base64url')}`;
  const client = new Client({ name: 'relay-bench', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: (u: string | URL, init?: RequestInit) => handleMcpHttp(new Request(u, init)),
  }));
  try {
    await client.callTool({ name: 'list_workspaces', arguments: {} }); // first contact → pending registration
    const row = (await pool.query<{ id: string }>(`SELECT id FROM mcp_clients WHERE owner_user_id=$1 AND client_id='bench-client' AND status='pending'`, [w.ownerId])).rows[0];
    if (!row) throw new Error('MCP client registration missing');
    await consentClient(await ctxFor(pool, w.ownerId, w.workspaceId), row.id, { scopes: SCOPES.split(' '), brand_ids: null });
    const posts = (await pool.query<{ id: string }>(`SELECT id FROM posts WHERE workspace_id=$1 AND brand_id=$2 ORDER BY md5(id::text) LIMIT 20`, [w.workspaceId, w.brandIds[0]])).rows.map((r) => r.id);
    const ws = w.workspaceId; const brand = w.brandIds[0]!;
    const from = new Date(Date.now() - 86_400_000).toISOString(); const to = new Date(Date.now() + 6 * 86_400_000).toISOString();
    const tools: Array<[string, (i: number) => Record<string, unknown>]> = [
      ['list_workspaces', () => ({})],
      ['list_brands', () => ({ workspace_id: ws })],
      ['search_content', () => ({ workspace_id: ws, brand_id: brand, query: 'launch', limit: 20 })],
      ['get_post', (i) => ({ workspace_id: ws, post_id: posts[i % posts.length] })],
      ['get_delivery_status', (i) => ({ workspace_id: ws, post_id: posts[i % posts.length] })],
      ['list_calendar', () => ({ workspace_id: ws, from, to })],
    ];
    if (withAnalytics) tools.push(['analytics_overview', () => ({ workspace_id: ws })]);
    const out: McpToolResult[] = [];
    for (const [tool, args] of tools) {
      // The per-principal limiter (120 burst, 2/s) is part of the measured path; refill it between tools so the
      // bench measures latency, not throttling (throwaway database only).
      await pool.query(`UPDATE rate_limit_buckets SET tokens = 1000 WHERE key LIKE 'mcp%'`);
      for (let i = 0; i < 3; i++) await client.callTool({ name: tool, arguments: args(i) });
      const since = new Date();
      const client_ms: number[] = [];
      await pool.query(`UPDATE rate_limit_buckets SET tokens = 1000 WHERE key LIKE 'mcp%'`);
      let errors = 0;
      for (let i = 0; i < samples; i++) {
        const t = performance.now();
        const r = (await client.callTool({ name: tool, arguments: args(i) })) as { isError?: boolean };
        client_ms.push(performance.now() - t);
        if (r.isError) errors++;
      }
      const audit = (await pool.query<{ latency_ms: number }>(`SELECT latency_ms FROM mcp_audit WHERE actor_user_id=$1 AND tool=$2 AND created_at >= $3 ORDER BY created_at`, [w.ownerId, tool, since])).rows;
      out.push({ tool, client_ms: summarize(client_ms), server_ms: summarize(audit.map((a) => Number(a.latency_ms))), provider_ms: 0, errors });
    }
    return out;
  } finally {
    await client.close().catch(() => undefined);
    await closeAllMcpSessions();
    setMcpAuthTestOverrides(null);
    void randomUUID;
  }
}
