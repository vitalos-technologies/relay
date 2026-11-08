// V2 adversarial cases (spec §12) for paths that exist independently of the parallel streams.
// All contexts go through the REAL policy path (v2Ctx → loadAccess → authorize).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorize, createPost, getPostDetail, listPosts, publishNow, retryDelivery, type AuthzState } from '@social-lite/services';
import { history, historyCsv, planner } from '@social-lite/services/readmodels';
import { getAsset, listAssets } from '@social-lite/services/media/index';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';
import { seedConnections, seedReadyImage } from './engine-helpers.js';

afterAll(closeTestPool);

let f: {
  ws: string; ws2: string; brandA: string; brandB: string; brandOther: string;
  owner: string; editorA: string; viewerA: string; outsider: string;
  postB: string; assetB: string; deliveryB: string; postOther: string;
};

beforeAll(async () => {
  testPool();
  const ws = await createWorkspace('Agency');
  const ws2 = await createWorkspace('Other org');
  const brandA = await createBrand(ws, 'Brand A');
  const brandB = await createBrand(ws, 'Brand B');
  const brandOther = await createBrand(ws2, 'Other');
  const owner = (await createUser()).id; await addMember(ws, owner, 'owner');
  const outsider = (await createUser()).id; await addMember(ws2, outsider, 'owner');
  const editorA = (await createUser()).id;
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'editor')`, [ws, editorA]);
  await grant(ws, editorA, 'editor', brandA);
  const viewerA = (await createUser()).id;
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, viewerA]);
  await grant(ws, viewerA, 'viewer', brandA);
  const conns = await seedConnections(ws, brandB);
  const assetB = await seedReadyImage(ws, brandB);
  const ownerCtx = await v2Ctx(owner, ws);
  const p = await createPost(ownerCtx, brandB, { title: 'B secret', draft: { baseText: 'Brand B unreleased', baseLink: null, baseAssetIds: [], variants: [{ connectionId: conns.facebook, inheritText: true, inheritMedia: true }] } }, randomUUID());
  const r = await publishNow(await v2Ctx(owner, ws), p.id, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID());
  const deliveryB = (r.body as { deliveries: Array<{ id: string }> }).deliveries[0]!.id;
  await testPool().query(`UPDATE deliveries SET state='failed' WHERE id=$1`, [deliveryB]);
  const otherConns = await seedConnections(ws2, brandOther);
  const po = await createPost(await v2Ctx(outsider, ws2), brandOther, { draft: { baseText: 'other org', baseLink: null, baseAssetIds: [], variants: [{ connectionId: otherConns.telegram, inheritText: true, inheritMedia: true }] } }, randomUUID());
  f = { ws, ws2, brandA, brandB, brandOther, owner, editorA, viewerA, outsider, postB: p.id, assetB, deliveryB, postOther: po.id };
});

describe('§12.1 ID substitution across brands and workspaces', () => {
  it('posts: brand-A members cannot read, list or edit Brand B; other workspaces see nothing', async () => {
    await expect(getPostDetail(await v2Ctx(f.editorA, f.ws), f.postB)).rejects.toMatchObject({ code: 'not_found' });
    await expect(listPosts(await v2Ctx(f.viewerA, f.ws), f.brandB, {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(createPost(await v2Ctx(f.editorA, f.ws), f.brandB, { title: 'x' }, randomUUID())).rejects.toMatchObject({ code: expect.stringMatching(/not_found|forbidden/) });
    await expect(getPostDetail(await v2Ctx(f.outsider, f.ws2), f.postB)).rejects.toMatchObject({ code: 'not_found' });
    await expect(getPostDetail(await v2Ctx(f.owner, f.ws), f.postOther)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('media: assets of Brand B are invisible to Brand A members and other workspaces', async () => {
    await expect(getAsset(await v2Ctx(f.editorA, f.ws), f.assetB)).rejects.toMatchObject({ code: 'not_found' });
    await expect(listAssets(await v2Ctx(f.editorA, f.ws), f.brandB)).rejects.toMatchObject({ code: 'not_found' });
    await expect(getAsset(await v2Ctx(f.outsider, f.ws2), f.assetB)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('history/planner/search: filtering by another brand returns nothing; exports need exports.create', async () => {
    const viewer = await v2Ctx(f.viewerA, f.ws);
    expect((await history(viewer, { brand_id: f.brandB })).items).toEqual([]);
    expect((await history(viewer, {})).items.every((r) => r.brand_id === f.brandA)).toBe(true);
    const now = Date.now();
    expect((await planner(viewer, { from: new Date(now - 86_400_000).toISOString(), to: new Date(now + 86_400_000).toISOString(), brand_id: f.brandB })).items).toEqual([]);
    await expect(historyCsv(viewer, {})).rejects.toMatchObject({ code: 'forbidden' });
    const csv = await historyCsv(await v2Ctx(f.owner, f.ws), {});
    expect(csv).toContain('B secret');
    expect(await historyCsv(await v2Ctx(f.outsider, f.ws2), {})).not.toContain('B secret');
  });

  it('jobs: retrying another brand’s or workspace’s delivery is not found', async () => {
    await expect(retryDelivery(await v2Ctx(f.editorA, f.ws), f.deliveryB, {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(retryDelivery(await v2Ctx(f.outsider, f.ws2), f.deliveryB, {})).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('§12.22 authorization fails closed', () => {
  it('malformed policy state denies instead of falling back to an owner role', () => {
    const broken = { subject: { kind: 'user', status: 'active', grants: [{ role: 'nonexistent', scopeType: 'workspace', brandId: null, connectionId: null, expiresAt: null, via: 'direct', grantId: 'g' }], restrictions: [], assurance: { mfaVerified: true, authTime: new Date().toISOString() } },
      policy: { mfa_required_for: [], mfa_required_all: false, step_up_seconds: 300 }, policyVersion: 1, required: new Set(), touchedBrands: new Set() } as unknown as AuthzState;
    const d = authorize(broken, 'content.publish', { brandId: 'b' });
    expect(d.allowed).toBe(false);
  });

  it('a workspace that is not active yields no access at all', async () => {
    await testPool().query(`UPDATE workspaces SET state='suspended' WHERE id=$1`, [f.ws2]);
    await expect(v2Ctx(f.outsider, f.ws2)).rejects.toMatchObject({ code: 'forbidden' });
    await testPool().query(`UPDATE workspaces SET state='active' WHERE id=$1`, [f.ws2]);
  });
});
