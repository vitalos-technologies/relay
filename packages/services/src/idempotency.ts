// API idempotency keys (unique per workspace/action). Same key + same payload => original
// response; same key + different payload => conflict.
import { createHash } from 'node:crypto';
import { AppError } from '@social-lite/core';
import { maybeOne, type Queryable } from '@social-lite/db';

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export function requestHash(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

export interface IdemRecord { status: number; body: unknown }

/**
 * Reserve an idempotency key inside the caller's transaction. Returns the stored response
 * if the same request already completed. A concurrent duplicate blocks on the row lock
 * until the first transaction commits, then observes the stored response.
 */
export async function beginIdempotent(db: Queryable, p: { workspaceId: string; userId: string; action: string; key: string | null; body: unknown }): Promise<IdemRecord | null> {
  if (!p.key || p.key.length < 8 || p.key.length > 200) {
    throw new AppError('validation_failed', 'An Idempotency-Key header (8-200 characters) is required for this request');
  }
  const hash = requestHash(p.body);
  await db.query(
    `INSERT INTO idempotency_keys(workspace_id, user_id, action, key, request_hash) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workspace_id, action, key) DO NOTHING`, [p.workspaceId, p.userId, p.action, p.key, hash]);
  const row = await maybeOne<{ request_hash: string; response_status: number | null; response_body: unknown }>(db,
    `SELECT request_hash, response_status, response_body FROM idempotency_keys
      WHERE workspace_id=$1 AND action=$2 AND key=$3 FOR UPDATE`, [p.workspaceId, p.action, p.key]);
  if (!row) throw new AppError('internal', 'Idempotency reservation failed');
  if (row.request_hash !== hash) throw new AppError('idempotency_conflict', 'This Idempotency-Key was already used with a different request');
  if (row.response_status !== null) return { status: row.response_status, body: row.response_body };
  return null;
}

export async function completeIdempotent(db: Queryable, p: { workspaceId: string; action: string; key: string; status: number; body: unknown }): Promise<void> {
  await db.query(`UPDATE idempotency_keys SET response_status=$4, response_body=$5 WHERE workspace_id=$1 AND action=$2 AND key=$3`,
    [p.workspaceId, p.action, p.key, p.status, JSON.stringify(p.body)]);
}
