// V2 central policy through the real database path.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPost, requireAction, assertBrand } from '@social-lite/services';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';

afterAll(closeTestPool);

async function agency() {
  const ws = await createWorkspace('Agency');
  const brandA = await createBrand(ws, 'Brand A');
  const brandB = await createBrand(ws, 'Brand B');
  const owner = await createUser();
  await addMember(ws, owner.id, 'owner');
  return { ws, brandA, brandB, owner };
}

describe('V2 authorize()', () => {
  it('brand-scoped editor on A cannot act on B even when the action was declared without a brand', async () => {
    const t = await agency();
    const ed = await createUser();
    await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'editor')`, [t.ws, ed.id]);
    await grant(t.ws, ed.id, 'editor', t.brandA);
    await grant(t.ws, ed.id, 'viewer', t.brandB);
    const ctx = await v2Ctx(ed.id, t.ws);
    expect(ctx.access.brandIds?.sort()).toEqual([t.brandA, t.brandB].sort());
    await expect(createPost(ctx, t.brandB, { title: 'x' }, randomUUID())).rejects.toMatchObject({ code: 'forbidden' });
    const ok = await createPost(await v2Ctx(ed.id, t.ws), t.brandA, { title: 'ok' }, randomUUID());
    expect(ok.id).toBeTruthy();
    // order independence: touching B first, then declaring content.edit, still fails
    const ctx2 = await v2Ctx(ed.id, t.ws);
    await assertBrand(ctx2, t.brandB);
    expect(() => requireAction(ctx2, 'content.edit')).toThrow();
  });

  it('team grants combine; suspension and restrictions override allows; expiry is enforced at access time', async () => {
    const t = await agency();
    const u = await createUser();
    await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [t.ws, u.id]);
    const team = await testPool().query<{ id: string }>(`INSERT INTO teams(workspace_id, name) VALUES ($1,'Publishing') RETURNING id`, [t.ws]);
    await testPool().query(`INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1,$2,$3)`, [t.ws, team.rows[0]!.id, u.id]);
    await testPool().query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, team_id, role, scope_type, brand_id) VALUES ($1,'team',$2,'publisher','brand',$3)`, [t.ws, team.rows[0]!.id, t.brandA]);
    const ctx = await v2Ctx(u.id, t.ws);
    expect(() => requireAction(ctx, 'content.publish', { brandId: t.brandA })).not.toThrow();
    expect(() => requireAction(ctx, 'content.publish', { brandId: t.brandB })).toThrow();
    // MFA gate for publisher on sensitive action
    const noMfa = await v2Ctx(u.id, t.ws, { mfaVerified: false });
    expect(() => requireAction(noMfa, 'content.publish', { brandId: t.brandA })).toThrow(expect.objectContaining({ code: 'mfa_required' }));
    // restriction overrides team allow
    await testPool().query(`INSERT INTO access_restrictions(workspace_id, user_id, brand_id, actions) VALUES ($1,$2,$3,ARRAY['content.publish'])`, [t.ws, u.id, t.brandA]);
    const restricted = await v2Ctx(u.id, t.ws);
    expect(() => requireAction(restricted, 'content.publish', { brandId: t.brandA })).toThrow(expect.objectContaining({ code: 'forbidden' }));
    // suspension denies everything
    await testPool().query(`UPDATE memberships SET status='suspended' WHERE workspace_id=$1 AND user_id=$2`, [t.ws, u.id]);
    await expect(v2Ctx(u.id, t.ws)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('expired guest grant gives nothing; step-up freshness enforced', async () => {
    const t = await agency();
    const g = await createUser();
    await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [t.ws, g.id]);
    await grant(t.ws, g.id, 'guest', t.brandA, new Date(Date.now() - 1000));
    const ctx = await v2Ctx(g.id, t.ws);
    expect(ctx.access.brandIds).toEqual([]);
    const stale = await v2Ctx(t.owner.id, t.ws, { authTime: new Date(Date.now() - 3600_000).toISOString() });
    expect(() => requireAction(stale, 'workspace.transfer_owner', { stepUp: true })).toThrow(expect.objectContaining({ code: 'step_up_required' }));
    const fresh = await v2Ctx(t.owner.id, t.ws);
    expect(() => requireAction(fresh, 'workspace.transfer_owner', { stepUp: true })).not.toThrow();
  });

  it('admin lacks ownership transfer and security policy', async () => {
    const t = await agency();
    const a = await createUser();
    await addMember(t.ws, a.id, 'admin');
    const ctx = await v2Ctx(a.id, t.ws);
    expect(() => requireAction(ctx, 'workspace.transfer_owner')).toThrow();
    expect(() => requireAction(ctx, 'security.manage')).toThrow();
    expect(() => requireAction(ctx, 'members.manage')).not.toThrow();
  });
});
