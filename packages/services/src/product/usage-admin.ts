// Settings → Budgets: workspace caps (workspaces.limits) and team caps (usage_budgets) with the
// current period's usage and open reservations. Reads: workspace.manage (owner/admin). Changes:
// security.manage (owner) — audited. Dispatch concurrency is an operator setting, not tenant-editable
// (a tenant raising its own concurrency would defeat cross-workspace fairness).
import { AppError, notFound } from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertUuid, authorizeCtx, requireAction } from '../tenancy.js';
import { BUDGET_METERS, BUDGET_METER_KEYS, periodFor, workspaceCap, type BudgetMeter } from './budgets.js';

export const LIMIT_METERS = {
  x_monthly_writes: { meter: 'x.write', label: 'X posts / month' },
  x_monthly_reads: { meter: 'x.read', label: 'X reads / month' },
  ai_monthly_tokens: { meter: 'ai.tokens', label: 'AI tokens / month' },
  storage_bytes: { meter: 'storage.bytes', label: 'Media storage (bytes)' },
  monthly_exports: { meter: 'exports.count', label: 'Exports / month' },
} as const satisfies Record<string, { meter: BudgetMeter; label: string }>;
export type LimitKey = keyof typeof LIMIT_METERS;
const LIMIT_KEYS = Object.keys(LIMIT_METERS) as LimitKey[];

const capValue = z.number().int().min(0).max(1_000_000_000_000_000).nullable();
export const limitsPatchSchema = z.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, capValue.optional()])) as Record<LimitKey, z.ZodOptional<typeof capValue>>).strict();
export const teamBudgetPatchSchema = z.object(Object.fromEntries(BUDGET_METER_KEYS.map((m) => [m, capValue.optional()])) as Record<BudgetMeter, z.ZodOptional<typeof capValue>>).strict();

interface CounterRow { team_id: string | null; meter: string; period: string; used: string; reserved: string }

async function counters(db: Queryable, workspaceId: string): Promise<CounterRow[]> {
  const periods = [...new Set(BUDGET_METER_KEYS.map((m) => periodFor(m)))];
  return many<CounterRow>(db, `SELECT team_id, meter, period, used, reserved FROM usage_counters WHERE workspace_id=$1 AND period = ANY($2::text[])`, [workspaceId, periods]);
}

const pct = (used: number, cap: number | null) => (cap ? Math.min(999, Math.round((used / cap) * 100)) : cap === 0 ? 100 : null);

export async function limitsView(ctx: Ctx, db: Queryable = getPool()) {
  const ws = await one<{ limits: Record<string, unknown> }>(db, `SELECT limits FROM workspaces WHERE id=$1`, [ctx.access.workspaceId]);
  const rows = await counters(db, ctx.access.workspaceId);
  const find = (teamId: string | null, meter: BudgetMeter) => rows.find((r) => r.team_id === teamId && r.meter === meter && r.period === periodFor(meter));
  const teams = await many<{ id: string; name: string }>(db, `SELECT id, name FROM teams WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY name`, [ctx.access.workspaceId]);
  const budgets = await many<{ team_id: string; meter: BudgetMeter; cap: string }>(db, `SELECT team_id, meter, cap FROM usage_budgets WHERE workspace_id=$1`, [ctx.access.workspaceId]);
  return {
    period: periodFor('ai.tokens'),
    can_edit: authorizeCtx(ctx, 'security.manage').allowed,
    items: LIMIT_KEYS.map((key) => {
      const meter = LIMIT_METERS[key].meter;
      const explicit = ws.limits?.[key];
      const cap = typeof explicit === 'number' && Number.isFinite(explicit) ? explicit : null;
      const effective = workspaceCap(ws.limits, meter);
      const c = find(null, meter);
      const used = Number(c?.used ?? 0);
      return { key, meter, label: LIMIT_METERS[key].label, unit: BUDGET_METERS[meter].unit, period: periodFor(meter), cap, effective_cap: effective,
        used, reserved: Number(c?.reserved ?? 0), percent: pct(used, effective) };
    }),
    teams: teams.map((t) => ({
      id: t.id, name: t.name,
      meters: BUDGET_METER_KEYS.map((meter) => {
        const b = budgets.find((x) => x.team_id === t.id && x.meter === meter);
        const c = find(t.id, meter);
        const cap = b ? Number(b.cap) : null;
        const used = Number(c?.used ?? 0);
        return { meter, label: BUDGET_METERS[meter].label, unit: BUDGET_METERS[meter].unit, cap, used, reserved: Number(c?.reserved ?? 0), percent: pct(used, cap) };
      }),
    })),
  };
}

export async function getWorkspaceLimits(ctx: Ctx) {
  requireAction(ctx, 'workspace.manage');
  return limitsView(ctx);
}

/** Owner only. null removes a cap (unmetered). Takes effect on the next reservation; never retroactive. */
export async function updateWorkspaceLimits(ctx: Ctx, raw: unknown) {
  requireAction(ctx, 'security.manage', 'Only the workspace owner can change budgets');
  const patch = limitsPatchSchema.parse(raw);
  assertUuid(ctx.access.workspaceId, 'Workspace');
  await withTx(async (tx) => {
    const ws = await one<{ limits: Record<string, unknown> }>(tx, `SELECT limits FROM workspaces WHERE id=$1 FOR UPDATE`, [ctx.access.workspaceId]);
    const before: Record<string, unknown> = {};
    const next: Record<string, unknown> = { ...(ws.limits ?? {}) };
    for (const k of LIMIT_KEYS) {
      if (!(k in patch)) continue;
      before[k] = ws.limits?.[k] ?? null;
      const v = patch[k];
      if (v === null || v === undefined) delete next[k]; else next[k] = v;
    }
    await tx.query(`UPDATE workspaces SET limits=$2 WHERE id=$1`, [ctx.access.workspaceId, JSON.stringify(next)]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'workspace.limits_updated', resourceType: 'workspace', resourceId: ctx.access.workspaceId,
      // Array form: limit names (e.g. ai_monthly_tokens) are values, so the secret-key redactor keeps them.
      diff: { changes: LIMIT_KEYS.filter((k) => k in patch).map((k) => ({ limit: k, before: before[k] ?? null, after: patch[k] ?? null })) }, correlationId: ctx.correlationId });
  });
  return limitsView(ctx);
}

/** Owner only: set/remove a team's caps. Team must belong to the caller's workspace (else 404). */
export async function updateTeamBudgets(ctx: Ctx, teamId: string, raw: unknown) {
  requireAction(ctx, 'security.manage', 'Only the workspace owner can change budgets');
  assertUuid(teamId, 'Team');
  const patch = teamBudgetPatchSchema.parse(raw);
  await withTx(async (tx) => {
    const team = await maybeOne<{ id: string; name: string }>(tx, `SELECT id, name FROM teams WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL FOR UPDATE`, [teamId, ctx.access.workspaceId]);
    if (!team) throw notFound('Team');
    const changes: Array<{ meter: string; before: number | null; after: number | null }> = [];
    for (const meter of BUDGET_METER_KEYS) {
      if (!(meter in patch)) continue;
      const prev = await maybeOne<{ cap: string }>(tx, `SELECT cap FROM usage_budgets WHERE team_id=$1 AND meter=$2`, [teamId, meter]);
      const v = patch[meter] ?? null;
      if (v === null) await tx.query(`DELETE FROM usage_budgets WHERE team_id=$1 AND meter=$2`, [teamId, meter]);
      else await tx.query(
        `INSERT INTO usage_budgets(workspace_id, team_id, meter, cap, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (team_id, meter) DO UPDATE SET cap=EXCLUDED.cap, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [ctx.access.workspaceId, teamId, meter, v, ctx.actor.userId]);
      changes.push({ meter, before: prev ? Number(prev.cap) : null, after: v });
    }
    if (!changes.length) throw new AppError('validation_failed', 'Nothing to change');
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'budget.team_updated', resourceType: 'team', resourceId: teamId,
      diff: { team: team.name, changes }, correlationId: ctx.correlationId });
  });
  return limitsView(ctx);
}
