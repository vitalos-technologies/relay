// Workspace usage + entitlements view (Admin → Usage, the UI hook, Platform → Workspaces) and downgrade selections.
// Reads stored counters/ledger only — no provider, billing-provider or AI calls during a page request.
import { z } from 'zod';
import { AppError } from '@social-lite/core';
import { ALLOWANCES, type Allowance } from '@social-lite/core/contracts/v4-plans';
import {
  ALLOWANCE_LABEL, ALLOWANCE_METER, ENTITLEMENT_HOLD, SELECTABLE_ALLOWANCES, WARNING_PERCENT,
  type AllowanceState, type EntitlementOverrideDto, type EntitlementsDto, type HeldWorkSummary, type SelectableAllowance, type SelectionDto,
} from '@social-lite/core/contracts/v4-entitlements';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { authorizeCtx, requireAction } from '../tenancy.js';
import { BUDGET_METERS, customerCap, workspaceCap, type BudgetMeter } from '../product/budgets.js';
import { entitlementsCore, entitlementsCoreCached, meterRules, trialDaysLeft, type EntitlementsCore, type MeterKey } from './resolve.js';
import { activeSplit, gaugeItems } from './gauges.js';
import { AUTOMATION_HOLD_PREFIX, reevaluateHolds } from './holds.js';
import { memberHold } from './actions.js';

const allowed = (ctx: Ctx, perm: Parameters<typeof authorizeCtx>[1]) => {
  const r = authorizeCtx(ctx, perm);
  return r.allowed || r.reason === 'mfa_required' || r.reason === 'step_up_required';
};

async function allowanceStates(db: Queryable, core: EntitlementsCore): Promise<AllowanceState[]> {
  const ws = await one<{ limits: Record<string, unknown> }>(db, `SELECT limits FROM workspaces WHERE id=$1`, [core.workspaceId]);
  const meters = ALLOWANCES.map((a) => ALLOWANCE_METER[a]).filter((m): m is MeterKey => m !== 'gauge');
  const keys = meters.map((m) => meterRules(core, m, BUDGET_METERS[m].period).period);
  const counters = await many<{ meter: string; period: string; used: string; reserved: string }>(db,
    `SELECT meter, period, used, reserved FROM usage_counters WHERE workspace_id=$1 AND team_id IS NULL AND meter = ANY($2::text[]) AND period = ANY($3::text[])`,
    [core.workspaceId, meters, [...new Set(keys)]]);
  const out: AllowanceState[] = [];
  for (const a of ALLOWANCES) {
    const meter = ALLOWANCE_METER[a];
    const lim = core.limits[a];
    let used = 0; let reserved = 0; let custom: number | null = null; let hard: number | null; let kind: AllowanceState['period_kind'];
    if (meter === 'gauge') {
      used = (await gaugeItems(db, core.workspaceId, a as SelectableAllowance)).length;
      hard = lim.limit; kind = 'gauge';
    } else {
      const m = meter as BudgetMeter;
      const period = meterRules(core, m, BUDGET_METERS[m].period).period;
      const c = counters.find((x) => x.meter === m && x.period === period);
      used = Number(c?.used ?? 0); reserved = Number(c?.reserved ?? 0);
      custom = customerCap(ws.limits, m);
      hard = workspaceCap(ws.limits, m, lim.limit);
      kind = BUDGET_METERS[m].period === 'total' ? 'total' : core.period.kind === 'trial' ? 'trial' : 'period';
    }
    const warningAt = hard === null ? null : Math.ceil((hard * WARNING_PERCENT) / 100);
    const percent = hard === null ? null : hard === 0 ? (used + reserved > 0 ? 100 : 0) : Math.min(999, Math.round(((used + reserved) / hard) * 100));
    const status: AllowanceState['status'] = hard === null ? 'unmetered' : used > hard ? 'over_limit' : used + reserved >= hard ? 'exhausted' : warningAt !== null && used + reserved >= warningAt ? 'warning' : 'ok';
    out.push({
      key: a, label: ALLOWANCE_LABEL[a].label, unit: ALLOWANCE_LABEL[a].unit, period_kind: kind, included: lim.included, used, reserved, customer_cap: custom,
      hard_limit: hard, warning_at: warningAt, remaining: hard === null ? null : Math.max(0, hard - used - reserved), percent, status,
      source: lim.source === 'unmetered' && hard !== null ? 'plan' : lim.source, overage: 'none',
    });
  }
  return out;
}

export async function heldSummary(db: Queryable, core: EntitlementsCore): Promise<HeldWorkSummary> {
  const r = await one<{ posts: number; replies: number; jobs: number; runs: number }>(db,
    `SELECT (SELECT count(*)::int FROM deliveries WHERE workspace_id=$1 AND state='blocked' AND last_error_code=$2) posts,
            (SELECT count(*)::int FROM inbox_reply_attempts WHERE workspace_id=$1 AND state='queued' AND error_code=$2) replies,
            (SELECT count(*)::int FROM integration_sync_jobs WHERE workspace_id=$1 AND state IN ('queued','waiting_retry') AND last_error_code=$2) jobs,
            (SELECT count(*)::int FROM automation_runs WHERE workspace_id=$1 AND outcome='blocked' AND reason LIKE $3 AND created_at > now() - interval '24 hours') runs`,
    [core.workspaceId, ENTITLEMENT_HOLD, `${AUTOMATION_HOLD_PREFIX}%`]);
  const held = async (a: SelectableAllowance) => {
    const lim = core.limits[a].limit;
    if (lim === null) return 0;
    const s = await activeSplit(db, core.workspaceId, a, lim);
    return s.items.length - s.active.size;
  };
  return { scheduled_posts: r.posts, queued_replies: r.replies, sync_jobs: r.jobs, automation_runs_blocked_24h: r.runs,
    held_social_accounts: await held('social_accounts'), held_listening_searches: await held('listening_searches'),
    held_brands: await held('brands'), held_members: await held('members') };
}

export async function overrideDtos(db: Queryable, workspaceId: string, opts: { history?: boolean } = {}): Promise<EntitlementOverrideDto[]> {
  const rows = await many<{ id: string; kind: EntitlementOverrideDto['kind']; key: string; value: EntitlementOverrideDto['value']; reason: string; expires_at: Date | null; created_at: Date; email: string | null; revoked_at: Date | null }>(db,
    `SELECT o.id, o.kind, o.key, o.value, o.reason, o.expires_at, o.created_at, u.email, o.revoked_at
       FROM entitlement_overrides o LEFT JOIN users u ON u.id=o.created_by
      WHERE o.workspace_id=$1 AND ($2 OR (o.revoked_at IS NULL AND (o.expires_at IS NULL OR o.expires_at > now())))
      ORDER BY (o.revoked_at IS NULL AND (o.expires_at IS NULL OR o.expires_at > now())) DESC, o.created_at DESC LIMIT 50`, [workspaceId, !!opts.history]);
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id, kind: r.kind, key: r.key, value: r.value, reason: r.reason, expires_at: r.expires_at?.toISOString() ?? null, created_at: r.created_at.toISOString(),
    created_by_email: r.email, revoked_at: r.revoked_at?.toISOString() ?? null,
    status: r.revoked_at ? 'revoked' : r.expires_at && r.expires_at.getTime() <= now ? 'expired' : 'active',
  }));
}

function reasonsFor(core: EntitlementsCore, allowances: AllowanceState[], held: HeldWorkSummary): string[] {
  const out: string[] = [];
  if (core.accessReason) out.push(core.accessReason);
  if (core.accessOverridden) out.push('Relay has kept full access on while a billing issue is resolved.');
  const days = trialDaysLeft(core);
  if (days !== null) out.push(`Trial: ${days} day${days === 1 ? '' : 's'} left.`);
  if (held.scheduled_posts) out.push(`${held.scheduled_posts} scheduled post${held.scheduled_posts === 1 ? ' is' : 's are'} held.`);
  if (held.queued_replies) out.push(`${held.queued_replies} repl${held.queued_replies === 1 ? 'y is' : 'ies are'} held.`);
  if (held.held_social_accounts) out.push(`${held.held_social_accounts} social account${held.held_social_accounts === 1 ? ' is' : 's are'} over the plan limit.`);
  if (held.held_listening_searches) out.push(`${held.held_listening_searches} listening search${held.held_listening_searches === 1 ? ' is' : 'es are'} over the plan limit.`);
  if (held.held_brands) out.push(`${held.held_brands} brand${held.held_brands === 1 ? ' is' : 's are'} over the plan limit (posts paused, nothing deleted).`);
  if (held.held_members) out.push(`${held.held_members} ${held.held_members === 1 ? 'person has' : 'people have'} paused access (over the plan’s user limit).`);
  for (const a of allowances) if (a.status === 'exhausted' || a.status === 'over_limit') out.push(`${a.label}: limit reached.`);
  return out;
}

/** The full DTO. `detail` adds allowances, held work and overrides (billing/admin readers). */
export async function buildEntitlementsDto(db: Queryable, core: EntitlementsCore, opts: { detail: boolean; canManage: boolean; history?: boolean; userId?: string | null }): Promise<EntitlementsDto> {
  const b = core.billing;
  const allowances = opts.detail ? await allowanceStates(db, core) : [];
  const held = opts.detail ? await heldSummary(db, core) : { scheduled_posts: 0, queued_replies: 0, sync_jobs: 0, automation_runs_blocked_24h: 0, held_social_accounts: 0, held_listening_searches: 0, held_brands: 0, held_members: 0 };
  const memberHoldReason = opts.userId ? await memberHold(db, core.workspaceId, opts.userId, core) : null;
  return {
    workspace_id: core.workspaceId,
    plan: core.plan ? { id: core.plan.id, name: core.plan.name, public: core.plan.public } : null,
    status: b.status, access: core.access, access_reason: core.accessReason, member_hold: memberHoldReason, trial: b.trial, period: core.period,
    features: core.features, allowances, overrides: opts.detail ? await overrideDtos(db, core.workspaceId, { history: opts.history }) : [], held,
    reasons: opts.detail ? reasonsFor(core, allowances, held) : core.accessReason ? [core.accessReason] : [],
    can_manage: opts.canManage, as_of: new Date().toISOString(),
  };
}

/**
 * GET /api/entitlements. Every active member gets plan, features and access (the UI hook hides/upgrades controls);
 * usage detail needs billing.read or workspace.manage. Never grants anything: purely a read of server state.
 */
export async function workspaceEntitlements(ctx: Ctx, db: Queryable = getPool()): Promise<EntitlementsDto> {
  const detail = allowed(ctx, 'billing.read') || allowed(ctx, 'workspace.manage');
  const core = detail ? await entitlementsCore(db, ctx.access.workspaceId) : await entitlementsCoreCached(ctx.access.workspaceId, db);
  return buildEntitlementsDto(db, core, { detail, canManage: allowed(ctx, 'billing.manage'), userId: ctx.actor.userId });
}

// ------------------------------------------------------------------ downgrade selections
export async function listSelections(ctx: Ctx, db: Queryable = getPool()): Promise<{ items: SelectionDto[]; can_manage: boolean }> {
  if (!(allowed(ctx, 'billing.read') || allowed(ctx, 'workspace.manage'))) requireAction(ctx, 'billing.read');
  const core = await entitlementsCore(db, ctx.access.workspaceId);
  const items: SelectionDto[] = [];
  for (const a of SELECTABLE_ALLOWANCES) {
    const limit = core.limits[a].limit;
    const s = await activeSplit(db, ctx.access.workspaceId, a, limit);
    items.push({ allowance: a, limit, active_count: s.active.size, over_limit: limit !== null && s.items.length > limit,
      items: s.items.map((i) => ({ id: i.id, name: i.name, detail: i.detail, active: s.active.has(i.id), chosen: s.chosen.has(i.id) })) });
  }
  return { items, can_manage: allowed(ctx, 'billing.manage') };
}

export const selectionSchema = z.object({
  allowance: z.enum(SELECTABLE_ALLOWANCES),
  resource_ids: z.array(z.string().uuid()).max(500),
}).strict();

/**
 * Choose which accounts/searches stay active under a lowered limit (billing.manage, step-up per policy). Nothing is
 * deleted or disconnected; held resources resume as soon as they are chosen again or the limit allows them.
 */
export async function setSelection(ctx: Ctx, raw: unknown): Promise<{ items: SelectionDto[]; can_manage: boolean }> {
  requireAction(ctx, 'billing.manage', { message: 'Only people who manage billing can choose what stays active.' });
  const input = selectionSchema.parse(raw);
  const ids = [...new Set(input.resource_ids)];
  await withTx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`entitlement:${ctx.access.workspaceId}:${input.allowance}`]);
    const core = await entitlementsCore(tx, ctx.access.workspaceId);
    const limit = core.limits[input.allowance].limit;
    const items = await gaugeItems(tx, ctx.access.workspaceId, input.allowance);
    const unknown = ids.filter((id) => !items.some((i) => i.id === id));
    if (unknown.length) throw new AppError('validation_failed', 'Some items are not active in this workspace.', { resource_ids: 'Choose from the list' });
    if (limit !== null && ids.length > limit) throw new AppError('validation_failed', `Choose at most ${limit}.`, { resource_ids: `At most ${limit}` });
    const before = await many<{ resource_id: string }>(tx, `SELECT resource_id FROM entitlement_selections WHERE workspace_id=$1 AND allowance=$2`, [ctx.access.workspaceId, input.allowance]);
    await tx.query(`DELETE FROM entitlement_selections WHERE workspace_id=$1 AND allowance=$2`, [ctx.access.workspaceId, input.allowance]);
    if (ids.length) {
      await tx.query(`INSERT INTO entitlement_selections(workspace_id, allowance, resource_id, chosen_by) SELECT $1, $2, x, $3 FROM unnest($4::uuid[]) x`,
        [ctx.access.workspaceId, input.allowance, ctx.actor.userId, ids]);
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'entitlements.selection_updated', resourceType: 'workspace', resourceId: ctx.access.workspaceId,
      diff: { allowance: input.allowance, limit, chosen: ids, previous: before.map((b) => b.resource_id) }, correlationId: ctx.correlationId });
    // Newly active searches re-match stored items; deliveries to newly active/held accounts are released/held now.
    if (input.allowance === 'listening_searches' && ids.length) {
      await tx.query(`UPDATE listening_searches SET rematch_state='pending', updated_at=now() WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND NOT (id = ANY($3::uuid[]))`,
        [ctx.access.workspaceId, ids, before.map((b) => b.resource_id)]);
    }
    await reevaluateHolds(ctx.access.workspaceId, { reason: 'selection', db: tx });
  });
  return listSelections(ctx);
}

/** Who may see the usage page at all (Admin → Usage nav + page guard). */
export function canReadUsage(ctx: Ctx): boolean {
  return allowed(ctx, 'billing.read') || allowed(ctx, 'workspace.manage');
}

export async function allowanceState(db: Queryable, workspaceId: string, allowance: Allowance): Promise<AllowanceState | undefined> {
  return (await allowanceStates(db, await entitlementsCore(db, workspaceId))).find((a) => a.key === allowance);
}

export async function lastAccessChange(db: Queryable, workspaceId: string): Promise<{ access: string; changed_at: string } | null> {
  const r = await maybeOne<{ access: string; changed_at: Date }>(db, `SELECT access, changed_at FROM workspace_entitlement_state WHERE workspace_id=$1`, [workspaceId]);
  return r ? { access: r.access, changed_at: r.changed_at.toISOString() } : null;
}
