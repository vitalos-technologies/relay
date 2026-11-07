// MCP audit: one row per tool/resource/prompt call. Ids only — never arguments, post/source text, prompts or tokens.
import { getPool, type Queryable } from '@social-lite/db';
import { log } from '../log.js';

export interface McpAuditEntry {
  workspaceId: string | null;
  clientRowId: string | null;
  actorUserId: string | null;
  actorServiceAccountId: string | null;
  clientId: string | null;
  tool: string;
  resourceIds: Record<string, string>;
  result: 'ok' | 'error' | 'denied' | 'cancelled';
  errorCode: string | null;
  correlationId: string;
  latencyMs: number;
}

const UUIDISH = /^[0-9a-f-]{36}$/i;

/** Keep only id-shaped values (defence against accidentally logging text). */
export function safeIds(ids: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ids)) {
    if (typeof v === 'string' && UUIDISH.test(v)) out[k.slice(0, 40)] = v;
    else if (Array.isArray(v)) {
      const ok = v.filter((x): x is string => typeof x === 'string' && UUIDISH.test(x)).slice(0, 20);
      if (ok.length) out[k.slice(0, 40)] = ok.join(',');
    }
  }
  return out;
}

export async function writeMcpAudit(e: McpAuditEntry, db: Queryable = getPool()): Promise<void> {
  try {
    await db.query(
      `INSERT INTO mcp_audit(workspace_id, client_row_id, actor_user_id, actor_service_account_id, client_id, tool, resource_ids, result, error_code, correlation_id, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [e.workspaceId, e.clientRowId, e.actorUserId, e.actorServiceAccountId, e.clientId?.slice(0, 300) ?? null, e.tool.slice(0, 120),
        JSON.stringify(e.resourceIds), e.result, e.errorCode?.slice(0, 60) ?? null, e.correlationId.slice(0, 64), Math.max(0, Math.round(e.latencyMs))]);
  } catch (err) {
    // Audit must not turn a completed action into an error for the client; it is logged for operators.
    log.error('mcp_audit_failed', { err: err as Error, tool: e.tool, correlationId: e.correlationId });
  }
}

/** Record activity on the registration (throttled to one write per minute). */
export async function touchClient(clientRowId: string, tool: string, db: Queryable = getPool()): Promise<void> {
  await db.query(`UPDATE mcp_clients SET last_activity_at=now(), last_tool=$2 WHERE id=$1 AND (last_activity_at IS NULL OR last_activity_at < now() - interval '1 minute' OR last_tool IS DISTINCT FROM $2)`,
    [clientRowId, tool.slice(0, 120)]).catch(() => undefined);
}
