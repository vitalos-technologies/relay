// Bounded automation policies (brief §17). A policy is the only thing that lets Relay act without a person in the loop,
// and it is bounded by: brands + channels, allowed actions, approved knowledge sources, eligible message categories for
// automatic replies, rate + spending limits, escalation triggers, an expiry (≤ 1 year) and review date, and emergency
// stops (per policy and workspace-wide). Managing policies needs automation.manage (a sensitive permission: MFA).
// The activating person becomes the policy OWNER; the policy's service actor can never do more than the owner's
// CURRENT permissions allow (re-loaded on every run), and loses everything when the owner loses access.
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import { ALWAYS_ESCALATE, MESSAGE_CATEGORIES, type MessageCategory } from '@social-lite/core/contracts/v35-ai';
import { AUTOMATION_ACTIONS, type AutomationActionType, type AutomationPolicyDto, type EscalationSettings } from '@social-lite/core/contracts/v35-automation';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { loadUserAuthz } from '../authz.js';
import { staffAllowed } from '../collab/access.js';
import { assertFeatureConfigurable } from '../entitlements/actions.js';
import { assertBrand, assertUuid, requireAction } from '../tenancy.js';

export interface PolicyRow {
  id: string; workspace_id: string; name: string; status: AutomationPolicyDto['status']; brand_ids: string[]; channel_ids: string[]; allowed_actions: AutomationActionType[];
  knowledge_source_ids: string[]; reply_categories: MessageCategory[]; max_actions_per_hour: number; max_auto_replies_per_day: number; monthly_token_budget: number;
  escalation: Partial<EscalationSettings>; expires_at: Date; review_by: Date | null; owner_id: string | null; activated_at: Date | null; stopped_at: Date | null; stop_reason: string | null;
  version: number; created_at: Date;
}

const MAX_DAYS = 366;
const REPLYABLE = MESSAGE_CATEGORIES.filter((c) => !ALWAYS_ESCALATE.includes(c) && c !== 'spam');

export const policySchema = z.object({
  name: z.string().trim().min(1).max(120),
  brand_ids: z.array(z.string().uuid()).min(1).max(50),
  channel_ids: z.array(z.string().uuid()).min(1).max(200),
  allowed_actions: z.array(z.enum(AUTOMATION_ACTIONS)).min(1),
  knowledge_source_ids: z.array(z.string().uuid()).max(50).optional(),
  reply_categories: z.array(z.enum(MESSAGE_CATEGORIES)).max(20).optional(),
  limits: z.object({
    max_actions_per_hour: z.number().int().min(1).max(10_000),
    max_auto_replies_per_day: z.number().int().min(0).max(10_000),
    monthly_token_budget: z.number().int().min(0).max(100_000_000),
  }).strict(),
  escalation: z.object({
    categories: z.array(z.enum(MESSAGE_CATEGORIES)).max(20).optional(),
    negative_sentiment: z.boolean().optional(),
    keywords: z.array(z.string().trim().min(2).max(60)).max(50).optional(),
    team_id: z.string().uuid().nullable().optional(),
    assignee_id: z.string().uuid().nullable().optional(),
  }).strict(),
  expires_at: z.string().datetime({ offset: true }),
  review_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
}).strict();
export type PolicyInput = z.infer<typeof policySchema>;

export function escalationOf(p: Pick<PolicyRow, 'escalation'>): EscalationSettings {
  const e = p.escalation ?? {};
  return {
    categories: [...new Set([...ALWAYS_ESCALATE, ...(e.categories ?? [])])] as MessageCategory[],
    negative_sentiment: e.negative_sentiment ?? true, keywords: e.keywords ?? [], team_id: e.team_id ?? null, assignee_id: e.assignee_id ?? null,
  };
}

async function usage(db: Queryable, p: PolicyRow): Promise<AutomationPolicyDto['usage']> {
  const r = await one<{ actions: string; replies: string; tokens: string }>(db,
    `SELECT (SELECT count(*) FROM automation_runs ar, jsonb_array_elements(ar.actions) x WHERE ar.policy_id=$1 AND NOT ar.is_test AND ar.created_at > now() - interval '1 hour' AND x->>'status'='done') AS actions,
            (SELECT count(*) FROM automation_sends s WHERE s.policy_id=$1 AND s.created_at > now() - interval '24 hours') AS replies,
            (SELECT coalesce(sum(r.input_tokens + r.output_tokens), 0) FROM ai_runs r JOIN automation_runs ar ON ar.id = r.automation_run_id
              WHERE ar.policy_id=$1 AND r.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS tokens`, [p.id]);
  return { actions_last_hour: Number(r.actions), auto_replies_today: Number(r.replies), tokens_this_month: Number(r.tokens) };
}

export async function policyUsage(p: PolicyRow, db: Queryable = getPool()) { return usage(db, p); }

async function dto(db: Queryable, p: PolicyRow): Promise<AutomationPolicyDto> {
  const owner = p.owner_id ? await maybeOne<{ id: string; name: string | null; email: string }>(db, `SELECT id, name, email FROM users WHERE id=$1`, [p.owner_id]) : null;
  const expired = p.status === 'active' && p.expires_at.getTime() <= Date.now();
  return {
    id: p.id, name: p.name, status: expired ? 'expired' : p.status, brand_ids: p.brand_ids, channel_ids: p.channel_ids, allowed_actions: p.allowed_actions,
    knowledge_source_ids: p.knowledge_source_ids, reply_categories: p.reply_categories,
    limits: { max_actions_per_hour: p.max_actions_per_hour, max_auto_replies_per_day: p.max_auto_replies_per_day, monthly_token_budget: p.monthly_token_budget },
    escalation: escalationOf(p), expires_at: p.expires_at.toISOString(), review_by: p.review_by ? p.review_by.toISOString().slice(0, 10) : null,
    owner: owner ? { id: owner.id, name: owner.name ?? owner.email } : null, activated_at: p.activated_at?.toISOString() ?? null, stopped_at: p.stopped_at?.toISOString() ?? null,
    stop_reason: p.stop_reason, version: p.version, usage: await usage(db, p), created_at: p.created_at.toISOString(),
  };
}

/** Validate a policy against the workspace: brands visible, channels belong to them, knowledge approved for them. */
async function validate(ctx: Ctx, input: PolicyInput, db: Queryable): Promise<void> {
  for (const b of input.brand_ids) await assertBrand(ctx, b, db);
  const ch = await many<{ id: string; brand_id: string }>(db, `SELECT id, brand_id FROM inbox_channels WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND disconnected_at IS NULL`, [ctx.access.workspaceId, input.channel_ids]);
  if (ch.length !== new Set(input.channel_ids).size || ch.some((c) => !input.brand_ids.includes(c.brand_id))) {
    throw new AppError('validation_failed', 'Choose channels that belong to the selected brands.', { channel_ids: 'Channels must belong to the selected brands' });
  }
  const ks = input.knowledge_source_ids ?? [];
  if (ks.length) {
    const k = await many<{ id: string }>(db, `SELECT id FROM ai_knowledge_sources WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND brand_id = ANY($3::uuid[]) AND revoked_at IS NULL`, [ctx.access.workspaceId, ks, input.brand_ids]);
    if (k.length !== new Set(ks).size) throw new AppError('validation_failed', 'Use knowledge approved for the selected brands.', { knowledge_source_ids: 'Unknown or revoked source' });
  }
  const bad = (input.reply_categories ?? []).filter((c) => !REPLYABLE.includes(c));
  if (bad.length) throw new AppError('validation_failed', `Refunds, complaints and sensitive messages always go to a person.`, { reply_categories: `Not allowed: ${bad.join(', ')}` });
  const replies = input.allowed_actions.includes('reply_saved') || input.allowed_actions.includes('reply_ai');
  if (replies && input.limits.max_auto_replies_per_day < 1) throw new AppError('validation_failed', 'Set a daily limit for automatic replies.', { 'limits.max_auto_replies_per_day': 'At least 1' });
  if (replies && !(input.reply_categories ?? []).length) throw new AppError('validation_failed', 'Choose which message categories may get an automatic reply.', { reply_categories: 'Required for automatic replies' });
  if (input.allowed_actions.includes('reply_ai') && (!ks.length || input.limits.monthly_token_budget < 1)) {
    throw new AppError('validation_failed', 'AI replies need approved knowledge and a monthly token budget.', { knowledge_source_ids: 'Required for AI replies' });
  }
  const exp = Date.parse(input.expires_at);
  if (!(exp > Date.now() + 60_000) || exp > Date.now() + MAX_DAYS * 86_400_000) throw new AppError('validation_failed', 'The policy must expire within a year.', { expires_at: 'Within the next 12 months' });
  if (input.escalation.team_id && !(await maybeOne(db, `SELECT 1 FROM teams WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [input.escalation.team_id, ctx.access.workspaceId]))) throw notFound('Team');
  if (input.escalation.assignee_id) {
    const s = await loadUserAuthz(input.escalation.assignee_id, ctx.access.workspaceId, null, db);
    if (s.subject.status !== 'active' || !input.brand_ids.every((b) => staffAllowed(s, 'inbox.read', b))) throw new AppError('validation_failed', 'The escalation contact needs inbox access on every brand.', { 'escalation.assignee_id': 'No inbox access' });
  }
}

export async function loadPolicy(ctx: Ctx, id: string, db: Queryable = getPool(), lock = false): Promise<PolicyRow> {
  assertUuid(id, 'Policy');
  requireAction(ctx, 'automation.manage');
  const p = await maybeOne<PolicyRow>(db, `SELECT * FROM automation_policies WHERE id=$1 AND workspace_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  if (!p) throw notFound('Policy');
  return p;
}

export async function listPolicies(ctx: Ctx): Promise<{ items: AutomationPolicyDto[] }> {
  requireAction(ctx, 'automation.manage');
  const rows = await many<PolicyRow>(getPool(), `SELECT * FROM automation_policies WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100`, [ctx.access.workspaceId]);
  const out: AutomationPolicyDto[] = [];
  for (const r of rows) out.push(await dto(getPool(), r));
  return { items: out };
}

export async function getPolicy(ctx: Ctx, id: string): Promise<AutomationPolicyDto> {
  return dto(getPool(), await loadPolicy(ctx, id));
}

const cols = (i: PolicyInput) => [i.name, i.brand_ids, i.channel_ids, [...new Set(i.allowed_actions)], i.knowledge_source_ids ?? [], i.reply_categories ?? [], i.limits.max_actions_per_hour,
  i.limits.max_auto_replies_per_day, i.limits.monthly_token_budget, JSON.stringify(i.escalation), i.expires_at, i.review_by ?? null];

export async function createPolicy(ctx: Ctx, raw: unknown): Promise<AutomationPolicyDto> {
  requireAction(ctx, 'automation.manage');
  const input = policySchema.parse(raw);
  const p = await withTx(async (tx) => {
    await assertFeatureConfigurable(tx, ctx.access.workspaceId, 'automation'); // V4: automations are a plan feature
    await validate(ctx, input, tx);
    const r = await one<PolicyRow>(tx,
      `INSERT INTO automation_policies(workspace_id, name, brand_ids, channel_ids, allowed_actions, knowledge_source_ids, reply_categories, max_actions_per_hour, max_auto_replies_per_day,
         monthly_token_budget, escalation, expires_at, review_by, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [ctx.access.workspaceId, ...cols(input), ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'automation.policy_created', resourceType: 'automation_policy', resourceId: r.id,
      diff: { brands: input.brand_ids.length, channels: input.channel_ids.length, actions: input.allowed_actions, expires_at: input.expires_at }, correlationId: ctx.correlationId });
    return r;
  });
  return dto(getPool(), p);
}

/** Editing an ACTIVE policy pauses it: changed bounds take effect only after someone activates them again. */
export async function updatePolicy(ctx: Ctx, id: string, raw: unknown): Promise<AutomationPolicyDto> {
  const input = policySchema.parse(raw);
  const p = await withTx(async (tx) => {
    const cur = await loadPolicy(ctx, id, tx, true);
    await validate(ctx, input, tx);
    const r = await one<PolicyRow>(tx,
      `UPDATE automation_policies SET name=$2, brand_ids=$3, channel_ids=$4, allowed_actions=$5, knowledge_source_ids=$6, reply_categories=$7, max_actions_per_hour=$8,
         max_auto_replies_per_day=$9, monthly_token_budget=$10, escalation=$11, expires_at=$12, review_by=$13, version=version+1, updated_at=now(),
         status=CASE WHEN status='active' THEN 'paused' ELSE status END WHERE id=$1 RETURNING *`, [id, ...cols(input)]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'automation.policy_updated', resourceType: 'automation_policy', resourceId: id,
      diff: { version: r.version, paused: cur.status === 'active' }, correlationId: ctx.correlationId });
    return r;
  });
  return dto(getPool(), p);
}

const NEEDS: Partial<Record<AutomationActionType, string>> = {
  assign: 'inbox.assign', escalate: 'inbox.assign', set_priority: 'inbox.reply', add_labels: 'inbox.reply', add_note: 'inbox.read', create_case: 'cases.manage',
  notify: 'inbox.read', reply_saved: 'inbox.reply', reply_ai: 'inbox.reply', integration_job: 'integrations.read',
};

/** What the owner lacks for this policy's actions on its brands (empty ⇒ OK). */
export async function ownerGaps(db: Queryable, workspaceId: string, ownerId: string, p: Pick<PolicyRow, 'brand_ids' | 'allowed_actions'>): Promise<string[]> {
  const s = await loadUserAuthz(ownerId, workspaceId, null, db);
  if (s.subject.status !== 'active') return ['active membership'];
  const gaps = new Set<string>();
  for (const a of p.allowed_actions) {
    const perm = NEEDS[a];
    if (perm && !p.brand_ids.every((b) => staffAllowed(s, perm as never, b))) gaps.add(perm);
  }
  return [...gaps];
}

export async function setPolicyStatus(ctx: Ctx, id: string, to: 'active' | 'paused' | 'stopped', reason?: string | null): Promise<AutomationPolicyDto> {
  const p = await withTx(async (tx) => {
    const cur = await loadPolicy(ctx, id, tx, true);
    if (to === 'active') {
      await assertFeatureConfigurable(tx, ctx.access.workspaceId, 'automation'); // V4: pausing/stopping always allowed
      if (cur.expires_at.getTime() <= Date.now()) throw new AppError('invalid_state', 'This policy has expired. Set a new expiry date first.');
      const gaps = await ownerGaps(tx, ctx.access.workspaceId, ctx.actor.userId, cur);
      if (gaps.length) throw new AppError('forbidden', `You need ${gaps.join(', ')} on every brand in this policy to activate it.`);
    }
    const r = await one<PolicyRow>(tx,
      `UPDATE automation_policies SET status=$2, owner_id=CASE WHEN $2='active' THEN $3 ELSE owner_id END, activated_at=CASE WHEN $2='active' THEN now() ELSE activated_at END,
         activated_by=CASE WHEN $2='active' THEN $3 ELSE activated_by END, stopped_at=CASE WHEN $2='stopped' THEN now() WHEN $2='active' THEN NULL ELSE stopped_at END,
         stopped_by=CASE WHEN $2='stopped' THEN $3 ELSE stopped_by END, stop_reason=CASE WHEN $2='stopped' THEN $4 WHEN $2='active' THEN NULL ELSE stop_reason END,
         version=version+1, updated_at=now() WHERE id=$1 RETURNING *`, [id, to, ctx.actor.userId, reason?.slice(0, 300) ?? null]);
    if (to !== 'active') await cancelQueuedAutomatedReplies(tx, ctx.access.workspaceId, id);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: `automation.policy_${to === 'active' ? 'activated' : to}`, resourceType: 'automation_policy', resourceId: id,
      diff: { from: cur.status, to, reason: reason ?? null }, correlationId: ctx.correlationId });
    return r;
  });
  return dto(getPool(), p);
}

/** Queued (not yet dispatched) automated replies of a policy — or of the whole workspace — are cancelled. */
export async function cancelQueuedAutomatedReplies(db: Queryable, workspaceId: string, policyId: string | null): Promise<number> {
  const r = await db.query(
    `UPDATE inbox_reply_attempts a SET state='cancelled', error_code='automation_stopped', error_message='Automation was stopped before sending. Nothing was sent.', finished_at=now(), updated_at=now()
      WHERE a.workspace_id=$1 AND a.automated AND a.state='queued'
        AND EXISTS (SELECT 1 FROM automation_sends s WHERE s.workspace_id=a.workspace_id AND s.idempotency_key=a.idempotency_key AND ($2::uuid IS NULL OR s.policy_id=$2))`, [workspaceId, policyId]);
  return r.rowCount ?? 0;
}

// ------------------------------------------------------------------ workspace emergency stop
export async function emergencyStopState(workspaceId: string, db: Queryable = getPool()): Promise<{ active: boolean; at: string | null; by: string | null }> {
  const r = await maybeOne<{ emergency_stop: boolean; stopped_at: Date | null; name: string | null }>(db,
    `SELECT s.emergency_stop, s.stopped_at, coalesce(u.name, u.email) AS name FROM automation_settings s LEFT JOIN users u ON u.id=s.stopped_by WHERE s.workspace_id=$1`, [workspaceId]);
  return { active: !!r?.emergency_stop, at: r?.stopped_at?.toISOString() ?? null, by: r?.name ?? null };
}

export async function setEmergencyStop(ctx: Ctx, active: boolean): Promise<{ active: boolean; at: string | null; by: string | null; cancelled: number }> {
  requireAction(ctx, 'automation.manage');
  const cancelled = await withTx(async (tx) => {
    await tx.query(`INSERT INTO automation_settings(workspace_id, emergency_stop, stopped_at, stopped_by) VALUES ($1,$2,CASE WHEN $2 THEN now() END,CASE WHEN $2 THEN $3::uuid END)
                    ON CONFLICT (workspace_id) DO UPDATE SET emergency_stop=$2, stopped_at=CASE WHEN $2 THEN now() ELSE automation_settings.stopped_at END,
                    stopped_by=CASE WHEN $2 THEN $3::uuid ELSE automation_settings.stopped_by END, updated_at=now()`, [ctx.access.workspaceId, active, ctx.actor.userId]);
    const n = active ? await cancelQueuedAutomatedReplies(tx, ctx.access.workspaceId, null) : 0;
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: active ? 'automation.emergency_stop' : 'automation.emergency_stop_lifted', resourceType: 'workspace', resourceId: ctx.access.workspaceId,
      diff: { cancelled_replies: n }, correlationId: ctx.correlationId });
    return n;
  });
  return { ...(await emergencyStopState(ctx.access.workspaceId)), cancelled };
}

/** Is this policy allowed to act right now? (status, expiry, stops). Expired policies are marked expired. */
export async function policyActive(p: PolicyRow, db: Queryable = getPool()): Promise<{ ok: true } | { ok: false; reason: string }> {
  if ((await emergencyStopState(p.workspace_id, db)).active) return { ok: false, reason: 'Emergency stop is on.' };
  if (p.status !== 'active') return { ok: false, reason: `Policy is ${p.status}.` };
  if (p.expires_at.getTime() <= Date.now()) {
    await db.query(`UPDATE automation_policies SET status='expired', updated_at=now() WHERE id=$1 AND status='active'`, [p.id]);
    return { ok: false, reason: 'Policy expired.' };
  }
  if (!p.owner_id) return { ok: false, reason: 'Policy has no owner.' };
  return { ok: true };
}
