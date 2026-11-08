// V1.1 settings: TipSignal binding (owner) and workspace budgets (owner/admin read, owner edit). Audited; cross-tenant 404.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteTipsignalBinding, getTipsignalBinding, getWorkspaceLimits, setTipsignalBinding, updateWorkspaceLimits,
} from '@social-lite/services/integrations/index';
import { checkAndConsumeBudget } from '@social-lite/services';
import { withTx } from '@social-lite/db';
import { addMember, closeTestPool, createBrand, createUser, ctxFor, tenant, testPool, v2Ctx } from './helpers.js';

afterAll(async () => {
  await testPool().query(`DELETE FROM integration_bindings WHERE kind='tipsignal'`);
  await closeTestPool();
});
beforeEach(async () => { await testPool().query(`DELETE FROM integration_bindings WHERE kind='tipsignal'`); });

async function withMembers() {
  const t = await tenant();
  const admin = await createUser(); await addMember(t.workspaceId, admin.id, 'admin');
  const editor = await createUser(); await addMember(t.workspaceId, editor.id, 'editor');
  const viewer = await createUser(); await addMember(t.workspaceId, viewer.id, 'viewer');
  return { t, admin, editor, viewer, adminCtx: ctxFor(admin.id, t.workspaceId, 'admin'), editorCtx: ctxFor(editor.id, t.workspaceId, 'editor') };
}

describe('TipSignal binding (V2: service-account principal)', () => {
  it('owner binds/unbinds; non-owners denied; secret status only; binding = integration grant on one brand; audited', async () => {
    const { t, editor, adminCtx, editorCtx } = await withMembers();
    const owner = await v2Ctx(t.owner.id, t.workspaceId);
    await expect(getTipsignalBinding(adminCtx)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setTipsignalBinding(adminCtx, { brand_id: t.brandId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setTipsignalBinding(editorCtx, { brand_id: t.brandId })).rejects.toMatchObject({ code: 'forbidden' });
    // Owner without verified MFA: security.manage is sensitive.
    await expect(setTipsignalBinding(await v2Ctx(t.owner.id, t.workspaceId, { mfaVerified: false }), { brand_id: t.brandId })).rejects.toMatchObject({ code: 'mfa_required' });
    const empty = await getTipsignalBinding(owner);
    expect(empty.binding).toBeNull();
    expect(Object.keys(empty.signing_secret).sort()).toEqual(['is_set', 'source']);
    expect(JSON.stringify(empty)).not.toMatch(/value_secret|ciphertext/);
    const bound = await setTipsignalBinding(owner, { brand_id: t.brandId });
    expect(bound.binding).toMatchObject({ brand_id: t.brandId, service_account: { name: 'TipSignal', owner_user_id: t.owner.id, active: true, permissions: ['Create drafts'] } });
    const saId = bound.binding!.service_account.id;
    const grants = await testPool().query(`SELECT role, scope_type, brand_id FROM scoped_role_grants WHERE service_account_id=$1 AND revoked_at IS NULL`, [saId]);
    expect(grants.rows).toEqual([{ role: 'integration', scope_type: 'brand', brand_id: t.brandId }]);
    const brand2 = await createBrand(t.workspaceId, 'Second');
    const rebound = await setTipsignalBinding(owner, { brand_id: brand2, owner_user_id: editor.id });
    expect(rebound.binding).toMatchObject({ brand_id: brand2, service_account: { id: saId, owner_user_id: editor.id } });
    const g2 = await testPool().query(`SELECT brand_id FROM scoped_role_grants WHERE service_account_id=$1 AND revoked_at IS NULL`, [saId]);
    expect(g2.rows).toEqual([{ brand_id: brand2 }]); // the old brand grant is revoked
    const un = await deleteTipsignalBinding(owner);
    expect(un.binding).toBeNull();
    const sa = await testPool().query(`SELECT disabled_at FROM service_accounts WHERE id=$1`, [saId]);
    expect(sa.rows[0].disabled_at).not.toBeNull();
    await expect(deleteTipsignalBinding(owner)).rejects.toMatchObject({ code: 'not_found' });
    const a = await testPool().query(`SELECT action FROM audit_events WHERE workspace_id=$1 AND resource_type='integration_binding' ORDER BY id`, [t.workspaceId]);
    expect(a.rows.map((r) => r.action)).toEqual(['integration.tipsignal.bound', 'integration.tipsignal.rebound', 'integration.tipsignal.unbound']);
  });

  it('cross-tenant brand/owner is 404; a binding owned by another workspace is a conflict and stays invisible', async () => {
    const a = await withMembers();
    const b = await withMembers();
    const aOwner = await v2Ctx(a.t.owner.id, a.t.workspaceId);
    const bOwner = await v2Ctx(b.t.owner.id, b.t.workspaceId);
    await expect(setTipsignalBinding(aOwner, { brand_id: b.t.brandId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(setTipsignalBinding(aOwner, { brand_id: a.t.brandId, owner_user_id: b.editor.id })).rejects.toMatchObject({ code: 'not_found' });
    await setTipsignalBinding(aOwner, { brand_id: a.t.brandId });
    const view = await getTipsignalBinding(bOwner);
    expect(view.binding).toBeNull();
    expect(view.bound_elsewhere).toBe(true);
    expect(JSON.stringify(view)).not.toContain(a.t.brandId);
    await expect(setTipsignalBinding(bOwner, { brand_id: b.t.brandId })).rejects.toMatchObject({ code: 'conflict' });
    await expect(deleteTipsignalBinding(bOwner)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('workspace budgets', () => {
  it('owner/admin read caps with current-period usage; only the owner edits; audited; enforced by the engine budget', async () => {
    const { t, adminCtx, editorCtx } = await withMembers();
    await expect(getWorkspaceLimits(editorCtx)).rejects.toMatchObject({ code: 'forbidden' });
    const initial = await getWorkspaceLimits(adminCtx);
    expect(initial.can_edit).toBe(false);
    // V2 (stream D): storage and export budgets join the V1.1 meters.
    expect(initial.items.map((i) => [i.key, i.cap, i.used])).toEqual([['x_monthly_writes', null, 0], ['x_monthly_reads', null, 0], ['ai_monthly_tokens', null, 0],
      ['storage_bytes', null, 0], ['monthly_exports', null, 0]]);
    await expect(updateWorkspaceLimits(adminCtx, { x_monthly_reads: 10 })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateWorkspaceLimits(t.ownerCtx, { x_monthly_reads: -1 })).rejects.toThrow();
    await expect(updateWorkspaceLimits(t.ownerCtx, { unknown_key: 1 })).rejects.toThrow();
    const v = await updateWorkspaceLimits(t.ownerCtx, { x_monthly_reads: 2, ai_monthly_tokens: 50000 });
    expect(v.items.find((i) => i.key === 'x_monthly_reads')).toMatchObject({ cap: 2, used: 0, percent: 0 });
    await withTx((tx) => checkAndConsumeBudget(tx, t.workspaceId, 'x.read', 1));
    const after = await getWorkspaceLimits(t.ownerCtx);
    expect(after.items.find((i) => i.key === 'x_monthly_reads')).toMatchObject({ cap: 2, used: 1, percent: 50 });
    await withTx((tx) => checkAndConsumeBudget(tx, t.workspaceId, 'x.read', 1));
    expect((await withTx((tx) => checkAndConsumeBudget(tx, t.workspaceId, 'x.read', 1))).ok).toBe(false);
    const cleared = await updateWorkspaceLimits(t.ownerCtx, { x_monthly_reads: null });
    expect(cleared.items.find((i) => i.key === 'x_monthly_reads')?.cap).toBeNull();
    const ws = await testPool().query(`SELECT limits FROM workspaces WHERE id=$1`, [t.workspaceId]);
    expect(ws.rows[0].limits).toEqual({ ai_monthly_tokens: 50000 });
    const a = await testPool().query(`SELECT diff FROM audit_events WHERE workspace_id=$1 AND action='workspace.limits_updated' ORDER BY id`, [t.workspaceId]);
    expect(a.rows.map((r) => r.diff.changes)).toEqual([
      [{ limit: 'x_monthly_reads', before: null, after: 2 }, { limit: 'ai_monthly_tokens', before: null, after: 50000 }],
      [{ limit: 'x_monthly_reads', before: 2, after: null }],
    ]);
    // Another tenant's owner sees only its own workspace.
    const other = await tenant();
    expect((await getWorkspaceLimits(other.ownerCtx)).items.every((i) => i.cap === null && i.used === 0)).toBe(true);
  });
});
