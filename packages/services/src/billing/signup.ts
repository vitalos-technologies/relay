// Selected-plan signup handoff (V5 §8): marketing "Start free trial" → /signup?plan=standard|professional → sign in /
// register with the identity provider → create the workspace → the workspace's one 14-day no-card trial starts on the
// selected plan (server-side, in the same transaction). The plan name from the URL only chooses WHICH public plan to trial;
// it never grants anything by itself (unknown plans are refused; the trial is the catalogue's bounded trial).
import { z } from 'zod';
import { PUBLIC_PLAN_IDS, publicCatalogue } from '@social-lite/core/contracts/v4-plans';
import { getPool, many, type Queryable } from '@social-lite/db';
import type { Actor } from '../context.js';
import type { SessionRecord } from '../auth/session.js';
import { canCreateWorkspace, createWorkspace } from '../workspaces.js';

const schema = z.object({
  name: z.string().max(200),
  timezone: z.string().max(64),
  brand_name: z.string().max(200).optional(),
  plan: z.enum(PUBLIC_PLAN_IDS),
}).strict();

export async function signupWorkspace(session: SessionRecord, actor: Actor, raw: unknown, correlationId?: string) {
  const input = schema.parse(raw);
  const { plan, ...ws } = input;
  return createWorkspace(session, actor, ws, correlationId, { plan, source: 'signup' });
}

export async function signupContext(actor: Actor, db: Queryable = getPool()) {
  const workspaces = await many<{ id: string; name: string; status: string | null }>(db,
    `SELECT w.id, w.name, b.status FROM memberships m JOIN workspaces w ON w.id=m.workspace_id LEFT JOIN workspace_billing b ON b.workspace_id=w.id
      WHERE m.user_id=$1 AND m.status='active' AND m.removed_at IS NULL AND w.state='active' ORDER BY w.name LIMIT 20`, [actor.userId]);
  return { can_create_workspace: await canCreateWorkspace(actor.userId, db), workspaces: workspaces.map((w) => ({ ...w, status: w.status ?? 'legacy' })), catalogue: publicCatalogue() };
}
