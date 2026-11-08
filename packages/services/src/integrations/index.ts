// V1.1 settings: TipSignal binding (Integrations tab) and workspace usage limits (Budgets tab).
// Owner-only mutations, owner/admin reads; every mutation is audited. Secrets are never returned
// (signing secret status is is_set/source only).
import { AppError, notFound } from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { requireAction } from '../tenancy.js';
import { bumpPolicyVersion } from '../authz.js';
import { settingSource } from '../settings.js';

// ------------------------------------------------------------------ TipSignal binding
// V2: the binding names a SERVICE ACCOUNT (purpose 'tipsignal') holding an `integration` grant
// (content.create_draft only) on the bound brand. The binding owner is the account's named owner.
export const tipsignalBindingSchema = z.object({ brand_id: z.string().uuid(), owner_user_id: z.string().uuid().nullish() });

interface BindingRow { id: string; workspace_id: string; brand_id: string; service_account_id: string; created_at: Date }

async function bindingView(ctx: Ctx) {
  const db = getPool();
  const b = await maybeOne<BindingRow & { brand_name: string; sa_name: string; owner_user_id: string; owner_email: string; owner_name: string | null; last_used_at: Date | null; disabled_at: Date | null }>(db,
    `SELECT ib.*, b.name AS brand_name, sa.name AS sa_name, sa.owner_user_id, u.email AS owner_email, u.name AS owner_name, sa.last_used_at, sa.disabled_at
       FROM integration_bindings ib JOIN brands b ON b.id=ib.brand_id
       JOIN service_accounts sa ON sa.id=ib.service_account_id AND sa.workspace_id=ib.workspace_id
       JOIN users u ON u.id=sa.owner_user_id
      WHERE ib.kind='tipsignal' AND ib.workspace_id=$1`, [ctx.access.workspaceId]);
  const elsewhere = b ? false : !!(await maybeOne(db, `SELECT 1 FROM integration_bindings WHERE kind='tipsignal' AND workspace_id<>$1`, [ctx.access.workspaceId]));
  const source = await settingSource('TIPSIGNAL_SIGNING_SECRET');
  const brands = await many<{ id: string; name: string }>(db, `SELECT id, name FROM brands WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY name`, [ctx.access.workspaceId]);
  const grants = b ? await many<{ role: string; brand_id: string }>(db,
    `SELECT role, brand_id FROM scoped_role_grants WHERE workspace_id=$1 AND service_account_id=$2 AND revoked_at IS NULL`, [ctx.access.workspaceId, b.service_account_id]) : [];
  return {
    binding: b ? {
      brand_id: b.brand_id, brand_name: b.brand_name, created_at: b.created_at.toISOString(),
      service_account: { id: b.service_account_id, name: b.sa_name, owner_user_id: b.owner_user_id, owner_email: b.owner_email, owner_name: b.owner_name,
        last_used_at: b.last_used_at?.toISOString() ?? null, active: !b.disabled_at, permissions: grants.map((g) => g.role === 'integration' ? 'Create drafts' : g.role) },
    } : null,
    bound_elsewhere: elsewhere,
    signing_secret: { is_set: source !== null, source },
    endpoint: '/api/integrations/tipsignal/events',
    brands,
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
    const prior = await maybeOne<BindingRow>(tx, `SELECT * FROM integration_bindings WHERE kind='tipsignal' FOR UPDATE`);
    if (prior && prior.workspace_id !== ctx.access.workspaceId) throw new AppError('conflict', 'TipSignal is already bound to another workspace on this installation.');
    const ownerId = input.owner_user_id ?? (prior ? (await one<{ owner_user_id: string }>(tx, `SELECT owner_user_id FROM service_accounts WHERE id=$1`, [prior.service_account_id])).owner_user_id : ctx.actor.userId);
    const owner = await maybeOne(tx, `SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL`,
      [ctx.access.workspaceId, ownerId]);
    if (!owner) throw notFound('Member');
    let saId = prior?.service_account_id;
    if (saId) {
      await tx.query(`UPDATE service_accounts SET owner_user_id=$2, disabled_at=NULL, disabled_by=NULL WHERE id=$1`, [saId, ownerId]);
      await tx.query(`UPDATE scoped_role_grants SET revoked_at=now(), revoked_by=$2 WHERE service_account_id=$1 AND revoked_at IS NULL`, [saId, ctx.actor.userId]);
    } else {
      saId = (await one<{ id: string }>(tx,
        `INSERT INTO service_accounts(workspace_id, name, owner_user_id, purpose, created_by, description)
         VALUES ($1, 'TipSignal', $2, 'tipsignal', $3, 'Creates drafts from signed TipSignal events') RETURNING id`, [ctx.access.workspaceId, ownerId, ctx.actor.userId])).id;
    }
    await tx.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, service_account_id, role, scope_type, brand_id, granted_by, source)
                    VALUES ($1,'service_account',$2,'integration','brand',$3,$4,'manual')`, [ctx.access.workspaceId, saId, input.brand_id, ctx.actor.userId]);
    if (prior) {
      await tx.query(`UPDATE integration_bindings SET brand_id=$2, service_account_id=$3, acting_user_id=NULL WHERE id=$1`, [prior.id, input.brand_id, saId]);
    } else {
      const ins = await maybeOne(tx, `INSERT INTO integration_bindings(kind, workspace_id, brand_id, service_account_id) VALUES ('tipsignal',$1,$2,$3) ON CONFLICT (kind) DO NOTHING RETURNING id`,
        [ctx.access.workspaceId, input.brand_id, saId]);
      if (!ins) throw new AppError('conflict', 'TipSignal is already bound to another workspace on this installation.');
    }
    const policyVersion = await bumpPolicyVersion(tx, ctx.access.workspaceId);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: input.brand_id, actorUserId: ctx.actor.userId, action: prior ? 'integration.tipsignal.rebound' : 'integration.tipsignal.bound',
      resourceType: 'integration_binding', resourceId: 'tipsignal',
      diff: { before: prior ? { brand_id: prior.brand_id } : null, after: { brand_id: input.brand_id, service_account_id: saId, owner_user_id: ownerId, grant: 'integration' }, policy_version: policyVersion }, correlationId: ctx.correlationId });
  });
  return bindingView(ctx);
}

export async function deleteTipsignalBinding(ctx: Ctx) {
  requireAction(ctx, 'setup.manage');
  await withTx(async (tx) => {
    const prior = await maybeOne<BindingRow>(tx, `DELETE FROM integration_bindings WHERE kind='tipsignal' AND workspace_id=$1 RETURNING *`, [ctx.access.workspaceId]);
    if (!prior) throw notFound('Binding');
    // The service account stops working immediately (disabled + grants revoked); history keeps its attribution.
    await tx.query(`UPDATE service_accounts SET disabled_at=now(), disabled_by=$2 WHERE id=$1`, [prior.service_account_id, ctx.actor.userId]);
    await tx.query(`UPDATE scoped_role_grants SET revoked_at=now(), revoked_by=$2 WHERE service_account_id=$1 AND revoked_at IS NULL`, [prior.service_account_id, ctx.actor.userId]);
    const policyVersion = await bumpPolicyVersion(tx, ctx.access.workspaceId);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: prior.brand_id, actorUserId: ctx.actor.userId, action: 'integration.tipsignal.unbound',
      resourceType: 'integration_binding', resourceId: 'tipsignal', diff: { brand_id: prior.brand_id, service_account_id: prior.service_account_id, policy_version: policyVersion }, correlationId: ctx.correlationId });
  });
  return bindingView(ctx);
}

// ------------------------------------------------------------------ workspace limits (budgets)
// V2: moved to product/usage-admin.ts (workspace + team budgets on the shared reservation mechanism).
export { LIMIT_METERS, limitsPatchSchema, getWorkspaceLimits, updateWorkspaceLimits, updateTeamBudgets, type LimitKey } from '../product/usage-admin.js';
