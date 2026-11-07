// V1.1 settings: TipSignal binding (Integrations tab) and workspace usage limits (Budgets tab).
// Owner-only mutations, owner/admin reads; every mutation is audited. Secrets are never returned
// (signing secret status is is_set/source only).
import { AppError, notFound, type Role } from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertUuid, requireAction } from '../tenancy.js';
import { settingSource } from '../settings.js';
import { period } from '../engine/budget.js';

// ------------------------------------------------------------------ TipSignal binding
const ACTING_ROLES: Role[] = ['owner', 'admin', 'editor'];

export const tipsignalBindingSchema = z.object({ brand_id: z.string().uuid(), acting_user_id: z.string().uuid() });

interface BindingRow { id: string; workspace_id: string; brand_id: string; acting_user_id: string; created_at: Date }

async function bindingView(ctx: Ctx) {
  const db = getPool();
  const b = await maybeOne<BindingRow & { brand_name: string; email: string; name: string | null }>(db,
    `SELECT ib.*, b.name AS brand_name, u.email, u.name FROM integration_bindings ib JOIN brands b ON b.id=ib.brand_id JOIN users u ON u.id=ib.acting_user_id
      WHERE ib.kind='tipsignal' AND ib.workspace_id=$1`, [ctx.access.workspaceId]);
  const elsewhere = b ? false : !!(await maybeOne(db, `SELECT 1 FROM integration_bindings WHERE kind='tipsignal' AND workspace_id<>$1`, [ctx.access.workspaceId]));
  const source = await settingSource('TIPSIGNAL_SIGNING_SECRET');
  const brands = await many<{ id: string; name: string }>(db, `SELECT id, name FROM brands WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY name`, [ctx.access.workspaceId]);
  const members = await many<{ user_id: string; email: string; name: string | null; role: Role; brand_ids: string[] | null }>(db,
    `SELECT m.user_id, u.email, u.name, m.role,
            CASE WHEN m.brand_restricted AND m.role NOT IN ('owner','admin')
                 THEN (SELECT coalesce(array_agg(g.brand_id::text), '{}') FROM membership_brand_grants g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id) END AS brand_ids
       FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 AND m.removed_at IS NULL AND u.disabled_at IS NULL AND m.role = ANY($2::member_role[]) ORDER BY u.email`,
    [ctx.access.workspaceId, ACTING_ROLES]);
  return {
    binding: b ? { brand_id: b.brand_id, brand_name: b.brand_name, acting_user_id: b.acting_user_id, acting_email: b.email, acting_name: b.name, created_at: b.created_at.toISOString() } : null,
    bound_elsewhere: elsewhere,
    signing_secret: { is_set: source !== null, source },
    endpoint: '/api/integrations/tipsignal/events',
    brands,
    members: members.map((m) => ({ user_id: m.user_id, email: m.email, name: m.name, role: m.role, brand_ids: m.brand_ids })),
  };
}

export async function getTipsignalBinding(ctx: Ctx) {
  requireAction(ctx, 'setup.manage');
  return bindingView(ctx);
}

export async function setTipsignalBinding(ctx: Ctx, raw: unknown) {
  requireAction(ctx, 'setup.manage');
  const input = tipsignalBindingSchema.parse(raw);
  await withTx(async (tx) => {
    const brand = await maybeOne<{ id: string; archived_at: Date | null }>(tx, `SELECT id, archived_at FROM brands WHERE id=$1 AND workspace_id=$2`, [input.brand_id, ctx.access.workspaceId]);
    if (!brand || brand.archived_at) throw notFound('Brand');
    const m = await maybeOne<{ role: Role; brand_restricted: boolean }>(tx,
      `SELECT m.role, m.brand_restricted FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.removed_at IS NULL AND u.disabled_at IS NULL`, [ctx.access.workspaceId, input.acting_user_id]);
    if (!m) throw notFound('Member');
    if (!ACTING_ROLES.includes(m.role)) throw new AppError('validation_failed', 'The acting member must be able to edit drafts', { acting_user_id: 'Choose an owner, admin or editor' });
    if (m.brand_restricted && m.role !== 'owner' && m.role !== 'admin') {
      const g = await maybeOne(tx, `SELECT 1 FROM membership_brand_grants WHERE workspace_id=$1 AND user_id=$2 AND brand_id=$3`, [ctx.access.workspaceId, input.acting_user_id, input.brand_id]);
      if (!g) throw new AppError('validation_failed', 'The acting member has no access to that brand', { acting_user_id: 'Grant this member the brand first' });
    }
    const prior = await maybeOne<BindingRow>(tx, `SELECT * FROM integration_bindings WHERE kind='tipsignal' FOR UPDATE`);
    if (prior && prior.workspace_id !== ctx.access.workspaceId) throw new AppError('conflict', 'TipSignal is already bound to another workspace on this installation.');
    if (prior) {
      await tx.query(`UPDATE integration_bindings SET brand_id=$2, acting_user_id=$3 WHERE id=$1`, [prior.id, input.brand_id, input.acting_user_id]);
    } else {
      const ins = await maybeOne(tx, `INSERT INTO integration_bindings(kind, workspace_id, brand_id, acting_user_id) VALUES ('tipsignal',$1,$2,$3) ON CONFLICT (kind) DO NOTHING RETURNING id`,
        [ctx.access.workspaceId, input.brand_id, input.acting_user_id]);
      if (!ins) throw new AppError('conflict', 'TipSignal is already bound to another workspace on this installation.');
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: input.brand_id, actorUserId: ctx.actor.userId, action: prior ? 'integration.tipsignal.rebound' : 'integration.tipsignal.bound',
      resourceType: 'integration_binding', resourceId: 'tipsignal',
      diff: { before: prior ? { brand_id: prior.brand_id, acting_user_id: prior.acting_user_id } : null, after: input }, correlationId: ctx.correlationId });
  });
  return bindingView(ctx);
}

export async function deleteTipsignalBinding(ctx: Ctx) {
  requireAction(ctx, 'setup.manage');
  await withTx(async (tx) => {
    const prior = await maybeOne<BindingRow>(tx, `DELETE FROM integration_bindings WHERE kind='tipsignal' AND workspace_id=$1 RETURNING *`, [ctx.access.workspaceId]);
    if (!prior) throw notFound('Binding');
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: prior.brand_id, actorUserId: ctx.actor.userId, action: 'integration.tipsignal.unbound',
      resourceType: 'integration_binding', resourceId: 'tipsignal', diff: { brand_id: prior.brand_id, acting_user_id: prior.acting_user_id }, correlationId: ctx.correlationId });
  });
  return bindingView(ctx);
}

// ------------------------------------------------------------------ workspace limits (budgets)
export const LIMIT_METERS = {
  x_monthly_writes: { meter: 'x.write', label: 'X posts / month' },
  x_monthly_reads: { meter: 'x.read', label: 'X reads / month' },
  ai_monthly_tokens: { meter: 'ai.tokens', label: 'AI tokens / month' },
} as const;
export type LimitKey = keyof typeof LIMIT_METERS;
const LIMIT_KEYS = Object.keys(LIMIT_METERS) as LimitKey[];

const capValue = z.number().int().min(0).max(1_000_000_000).nullable();
export const limitsPatchSchema = z.object({ x_monthly_writes: capValue.optional(), x_monthly_reads: capValue.optional(), ai_monthly_tokens: capValue.optional() }).strict();

async function limitsView(ctx: Ctx, db = getPool()) {
  const ws = await one<{ limits: Record<string, unknown> }>(db, `SELECT limits FROM workspaces WHERE id=$1`, [ctx.access.workspaceId]);
  const p = period();
  const usage = await many<{ meter: string; used: string }>(db, `SELECT meter, used FROM usage_counters WHERE workspace_id=$1 AND period=$2`, [ctx.access.workspaceId, p]);
  return {
    period: p,
    can_edit: ctx.access.role === 'owner',
    items: LIMIT_KEYS.map((key) => {
      const cap = ws.limits?.[key];
      const n = typeof cap === 'number' && Number.isFinite(cap) ? cap : null;
      const used = Number(usage.find((u) => u.meter === LIMIT_METERS[key].meter)?.used ?? 0);
      return { key, meter: LIMIT_METERS[key].meter, label: LIMIT_METERS[key].label, cap: n, used, percent: n ? Math.min(999, Math.round((used / n) * 100)) : null };
    }),
  };
}

export async function getWorkspaceLimits(ctx: Ctx) {
  requireAction(ctx, 'workspace.settings');
  return limitsView(ctx);
}

/** Owner only. null removes a cap (unmetered). Takes effect on the next metered call; never retroactive. */
export async function updateWorkspaceLimits(ctx: Ctx, raw: unknown) {
  requireAction(ctx, 'setup.manage', 'Only the workspace owner can change budgets');
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
