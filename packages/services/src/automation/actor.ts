// The automation SERVICE ACTOR. It acts through the normal domain services with a context derived from the policy
// owner's CURRENT access (re-loaded for every run — revocation, removal or a lost grant stops the policy), narrowed to
// the policy's brands. Audit rows name the owner as actor and carry the automation session id; events carry
// origin {kind:'automation'} (loop prevention) and reply attempts are marked automated.
import { randomUUID } from 'node:crypto';
import { AppError } from '@social-lite/core';
import { getPool, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { loadAccess } from '../tenancy.js';
import { policyActive, type PolicyRow } from './policies.js';

export async function policyCtx(p: PolicyRow, runId: string, db: Queryable = getPool()): Promise<Ctx> {
  const active = await policyActive(p, db);
  if (!active.ok) throw new AppError('invalid_state', active.reason);
  const access = await loadAccess(p.owner_id!, p.workspace_id, db);
  if (!access) throw new AppError('forbidden', 'The policy owner no longer has access to this workspace.');
  const u = await maybeOne<{ email: string }>(db, `SELECT email FROM users WHERE id=$1 AND disabled_at IS NULL`, [p.owner_id]);
  if (!u) throw new AppError('forbidden', 'The policy owner is disabled.');
  const brandIds = access.brandIds === null ? [...p.brand_ids] : access.brandIds.filter((b) => p.brand_ids.includes(b));
  return {
    actor: { userId: p.owner_id!, email: u.email, name: 'Relay automation', sessionId: `automation:${p.id}:${runId}` },
    access: { ...access, brandIds },
    correlationId: randomUUID(),
  };
}
