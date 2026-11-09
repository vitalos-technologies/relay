// Tenant and role boundaries (spec §6) against real PostgreSQL.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  credentialAad, decryptSecret, encryptSecret, loadAccess, type EncryptedBlob,
} from '@social-lite/services';
import { createBrand as createBrandSvc, getBrand, listBrands, setBrandPaused, updateBrand } from '../../packages/services/src/brands.js';
import { createUploadIntent, listAssets } from '../../packages/services/src/media/assets.js';
import { updateMember } from '../../packages/services/src/members.js';
import { acceptOwnershipTransfer, proposeOwnershipTransfer, removeMember } from '../../packages/services/src/lifecycle.js';
import { archiveTemplate, createTemplate, listTemplates, updateTemplate } from '../../packages/services/src/templates.js';
import { listAudit } from '../../packages/services/src/audit-read.js';
import {
  canCreateWorkspace, createWorkspace as createWorkspaceSvc, sessionInfo, setWorkspacePaused, switchWorkspace, updateWorkspace,
} from '../../packages/services/src/workspaces.js';
import { createSession } from '../../packages/services/src/auth/session.js';
import { addMember, closeTestPool, createBrand, createUser, ctxFor, grant, tenant, testPool, v2Ctx } from './helpers.js';

const NF = { code: 'not_found' };
const FORBIDDEN = { code: 'forbidden' };

let A: Awaited<ReturnType<typeof tenant>>;
let B: Awaited<ReturnType<typeof tenant>>;

beforeAll(async () => {
  testPool();
  A = await tenant();
  B = await tenant();
});
afterAll(closeTestPool);

describe('cross-tenant isolation', () => {
  it('a user of workspace A has no access to workspace B', async () => {
    expect(await loadAccess(A.owner.id, B.workspaceId, testPool())).toBeNull();
    expect(await loadAccess(A.owner.id, A.workspaceId, testPool())).toMatchObject({ role: 'owner', brandIds: null });
  });

  it("cannot read or modify B's brands", async () => {
    await expect(getBrand(A.ownerCtx, B.brandId)).rejects.toMatchObject(NF);
    await expect(updateBrand(A.ownerCtx, B.brandId, { name: 'pwned' })).rejects.toMatchObject(NF);
    await expect(setBrandPaused(A.ownerCtx, B.brandId, { paused: true })).rejects.toMatchObject(NF);
    expect((await listBrands(A.ownerCtx)).map((b) => b.id)).not.toContain(B.brandId);
    await expect(getBrand(A.ownerCtx, 'not-a-uuid')).rejects.toMatchObject(NF);
  });

  it("cannot read B's assets or templates", async () => {
    await expect(listAssets(A.ownerCtx, B.brandId)).rejects.toMatchObject(NF);
    const tpl = await createTemplate(B.ownerCtx, B.brandId, { name: 'B template', body: 'secret text' });
    await expect(listTemplates(A.ownerCtx, B.brandId)).rejects.toMatchObject(NF);
    await expect(updateTemplate(A.ownerCtx, tpl.id, { body: 'x' })).rejects.toMatchObject(NF);
    await expect(archiveTemplate(A.ownerCtx, tpl.id)).rejects.toMatchObject(NF);
    await expect(createTemplate(A.ownerCtx, B.brandId, { name: 'x', body: 'y' })).rejects.toMatchObject(NF);
  });

  it("cannot use B's credentials: blobs are bound to their workspace", async () => {
    const db = testPool();
    const blob = encryptSecret({ access_token: 'b-token' }, credentialAad(B.workspaceId));
    const cred = (await db.query<{ id: string }>(
      `INSERT INTO credentials(workspace_id, encrypted_blob, key_version) VALUES ($1,$2,$3) RETURNING id`,
      [B.workspaceId, JSON.stringify(blob), blob.kid])).rows[0]!.id;
    // A connection in A cannot point at B's credential (composite FK).
    await expect(db.query(
      `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, credential_id) VALUES ($1,$2,'telegram','-1001','x',$3)`,
      [A.workspaceId, A.brandId, cred])).rejects.toThrow(/foreign key/);
    // And decrypting B's blob in A's context fails.
    const stored = (await db.query<{ encrypted_blob: EncryptedBlob }>(`SELECT encrypted_blob FROM credentials WHERE id=$1`, [cred])).rows[0]!.encrypted_blob;
    expect(() => decryptSecret(stored, credentialAad(A.workspaceId))).toThrow();
    expect(decryptSecret(stored, credentialAad(B.workspaceId))).toEqual({ access_token: 'b-token' });
  });

  it("audit log is workspace-scoped", async () => {
    await updateWorkspace(B.ownerCtx, { name: 'B renamed' });
    const items = (await listAudit(A.ownerCtx)).items;
    expect(items.every((e) => e.action !== 'workspace.updated' || e.resource_id === A.workspaceId)).toBe(true);
    expect((await listAudit(B.ownerCtx)).items.some((e) => e.action === 'workspace.updated' && e.resource_id === B.workspaceId)).toBe(true);
  });

  it('cannot switch the session to a workspace without membership', async () => {
    const { session } = await createSession(testPool(), A.owner.id, {});
    const actor = { userId: A.owner.id, email: A.owner.email, name: null, sessionId: session.id };
    await expect(switchWorkspace(session, actor, B.workspaceId)).rejects.toMatchObject(NF);
  });
});

describe('brand restrictions', () => {
  it('a brand-restricted member sees only granted brands', async () => {
    const second = await createBrand(A.workspaceId, 'Second brand');
    const editor = await createUser();
    await addMember(A.workspaceId, editor.id, 'editor', [A.brandId]);
    const access = (await loadAccess(editor.id, A.workspaceId, testPool()))!;
    expect(access.brandIds).toEqual([A.brandId]);
    const ctx = ctxFor(editor.id, A.workspaceId, 'editor', access.brandIds);
    expect((await listBrands(ctx)).map((b) => b.id)).toEqual([A.brandId]);
    await expect(getBrand(ctx, second)).rejects.toMatchObject(NF);
    await expect(listAssets(ctx, second)).rejects.toMatchObject(NF);
    await expect(listTemplates(ctx, second)).rejects.toMatchObject(NF);
    await expect(createUploadIntent(ctx, { brand_id: second, filename: 'a.png', content_type: 'image/png', bytes: 10 })).rejects.toMatchObject(NF);
    expect(await listTemplates(ctx, A.brandId)).toBeInstanceOf(Array);

    const { session } = await createSession(testPool(), editor.id, { workspaceId: A.workspaceId });
    const info = await sessionInfo(session, { userId: editor.id, email: editor.email, name: null, sessionId: session.id });
    expect(info.brands.map((b) => b.id)).toEqual([A.brandId]);
    expect(info.workspace).toMatchObject({ id: A.workspaceId, role: 'editor' });
    expect(info.permissions['drafts.edit']).toBe(true);
    expect(info.permissions['members.invite']).toBe(false);
  });
});

describe('roles', () => {
  it('viewers cannot create brands, templates, uploads or change settings', async () => {
    const viewer = await createUser();
    await addMember(A.workspaceId, viewer.id, 'viewer');
    const ctx = ctxFor(viewer.id, A.workspaceId, 'viewer');
    await expect(createBrandSvc(ctx, { name: 'New' })).rejects.toMatchObject(FORBIDDEN);
    await expect(createTemplate(ctx, A.brandId, { name: 'n', body: 'b' })).rejects.toMatchObject(FORBIDDEN);
    await expect(createUploadIntent(ctx, { brand_id: A.brandId, filename: 'a.png', content_type: 'image/png', bytes: 10 })).rejects.toMatchObject(FORBIDDEN);
    await expect(updateWorkspace(ctx, { name: 'x' })).rejects.toMatchObject(FORBIDDEN);
    await expect(setWorkspacePaused(ctx, { paused: true })).rejects.toMatchObject(FORBIDDEN);
    await expect(listAudit(ctx)).rejects.toMatchObject(FORBIDDEN);
    // Viewers can still read.
    expect((await listBrands(ctx)).length).toBeGreaterThan(0);
  });

  it('admins cannot demote or remove an owner; ownership moves only by transfer; the last owner is protected (V2)', async () => {
    const t = await tenant();
    const admin = await createUser();
    const editor = await createUser();
    await addMember(t.workspaceId, admin.id, 'admin');
    await addMember(t.workspaceId, editor.id, 'editor');
    const adminCtx = () => v2Ctx(admin.id, t.workspaceId);
    await expect(updateMember(await adminCtx(), t.owner.id, { role: 'viewer' })).rejects.toMatchObject(FORBIDDEN);
    await expect(removeMember(await adminCtx(), t.owner.id)).rejects.toMatchObject(FORBIDDEN);
    // Ownership is never granted by a role change (only the two-step transfer flow).
    await expect(updateMember(await adminCtx(), editor.id, { role: 'owner' })).rejects.toMatchObject({ code: 'validation_failed' });
    // Admin may change non-owners.
    expect((await updateMember(await adminCtx(), editor.id, { role: 'approver' })).role).toBe('approver');
    // The sole owner cannot leave / be removed.
    await expect(removeMember(await v2Ctx(t.owner.id, t.workspaceId), t.owner.id)).rejects.toMatchObject({ code: 'invalid_state' });
    // Transfer: owner proposes (fresh auth), the admin accepts; the previous owner stays as admin.
    const tr = await proposeOwnershipTransfer(await v2Ctx(t.owner.id, t.workspaceId), { to_user_id: admin.id });
    await acceptOwnershipTransfer(await adminCtx(), tr.id);
    expect(await loadAccess(admin.id, t.workspaceId, testPool())).toMatchObject({ role: 'owner' });
    expect(await loadAccess(t.owner.id, t.workspaceId, testPool())).toMatchObject({ role: 'admin' });
  });

  it('emergency pause by an approver pauses waiting deliveries in the same transaction; only publishing.resume resumes them', async () => {
    const db = testPool();
    const t = await tenant();
    const approver = await createUser();
    const publisher = await createUser();
    await addMember(t.workspaceId, approver.id, 'approver');
    await addMember(t.workspaceId, publisher.id, 'viewer');
    await grant(t.workspaceId, publisher.id, 'publisher');
    const ctx = ctxFor(approver.id, t.workspaceId, 'approver');
    const pubCtx = await v2Ctx(publisher.id, t.workspaceId);
    const deliveryId = await seedDelivery(t.workspaceId, t.brandId);

    const paused = await setWorkspacePaused(ctx, { paused: true, reason: 'Incident' });
    expect(paused).toMatchObject({ publishing_paused: true, paused_reason: 'Incident', affected: { paused: 1 } });
    expect((await db.query(`SELECT state FROM deliveries WHERE id=$1`, [deliveryId])).rows[0].state).toBe('paused');

    // H5: the Approver preset holds publishing.pause but not publishing.resume (legacy and V2 contexts).
    await expect(setWorkspacePaused(ctx, { paused: false })).rejects.toMatchObject(FORBIDDEN);
    await expect(setWorkspacePaused(await v2Ctx(approver.id, t.workspaceId), { paused: false })).rejects.toMatchObject(FORBIDDEN);
    expect((await db.query(`SELECT publishing_paused FROM workspaces WHERE id=$1`, [t.workspaceId])).rows[0].publishing_paused).toBe(true);

    const resumed = await setWorkspacePaused(pubCtx, { paused: false });
    expect(resumed).toMatchObject({ publishing_paused: false, paused_reason: null, affected: { resumed: 1, expired: 0 } });
    expect((await db.query(`SELECT state FROM deliveries WHERE id=$1`, [deliveryId])).rows[0].state).toBe('scheduled');

    // Brand pause uses the same hooks and the same split.
    const b = await setBrandPaused(ctx, t.brandId, { paused: true });
    expect(b.affected).toEqual({ paused: 1 });
    await expect(setBrandPaused(ctx, t.brandId, { paused: false })).rejects.toMatchObject(FORBIDDEN);
    await expect(setBrandPaused(await v2Ctx(approver.id, t.workspaceId), t.brandId, { paused: false })).rejects.toMatchObject(FORBIDDEN);
    await setBrandPaused(await v2Ctx(publisher.id, t.workspaceId), t.brandId, { paused: false });
    expect((await db.query(`SELECT state FROM deliveries WHERE id=$1`, [deliveryId])).rows[0].state).toBe('scheduled');
    const actions = (await listAudit(t.ownerCtx, { resource_type: 'workspace' })).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['workspace.paused', 'workspace.resumed']));
  });
});

describe('first-run workspace creation', () => {
  it('lets a user without memberships create a workspace with an owner membership and first brand', async () => {
    const u = await createUser();
    expect(await canCreateWorkspace(u.id)).toBe(true);
    const { session } = await createSession(testPool(), u.id, {});
    expect(session.activeWorkspaceId).toBeNull();
    const actor = { userId: u.id, email: u.email, name: null, sessionId: session.id };
    const before = await sessionInfo(session, actor);
    expect(before).toMatchObject({ workspace: null, can_create_workspace: true });
    expect(Object.values(before.permissions).every((v) => v === false)).toBe(true);

    await expect(createWorkspaceSvc(session, actor, { name: 'Acme', timezone: 'Not/AZone' })).rejects.toMatchObject({ code: 'validation_failed' });
    const r = await createWorkspaceSvc(session, actor, { name: 'Acme', timezone: 'America/New_York' });
    expect(r.workspace).toMatchObject({ name: 'Acme', timezone: 'America/New_York', is_demo: false });
    expect(r.brand).toMatchObject({ name: 'Acme', timezone: 'America/New_York' });
    expect(await loadAccess(u.id, r.workspace.id, testPool())).toMatchObject({ role: 'owner' });
    const after = await sessionInfo({ ...session, activeWorkspaceId: r.workspace.id }, actor);
    expect(after.workspace).toMatchObject({ id: r.workspace.id, role: 'owner' });
    expect(after.permissions['setup.manage']).toBe(true);
    // Users who already belong to a workspace cannot self-create more.
    await expect(createWorkspaceSvc(session, actor, { name: 'Second', timezone: 'UTC' })).rejects.toMatchObject(FORBIDDEN);
  });
});

async function seedDelivery(workspaceId: string, brandId: string): Promise<string> {
  const db = testPool();
  const conn = (await db.query<{ id: string }>(
    `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, is_mock, status)
     VALUES ($1,$2,'telegram',$3,'Mock',true,'ready') RETURNING id`, [workspaceId, brandId, `mock_${randomUUID()}`])).rows[0]!.id;
  const post = (await db.query<{ id: string }>(`INSERT INTO posts(workspace_id, brand_id) VALUES ($1,$2) RETURNING id`, [workspaceId, brandId])).rows[0]!.id;
  const rev = (await db.query<{ id: string }>(
    `INSERT INTO post_revisions(workspace_id, post_id, revision_number, base_text, content_hash) VALUES ($1,$2,1,'hi','h') RETURNING id`, [workspaceId, post])).rows[0]!.id;
  const variant = (await db.query<{ id: string }>(
    `INSERT INTO variants(workspace_id, revision_id, connection_id, format) VALUES ($1,$2,$3,'text') RETURNING id`, [workspaceId, rev, conn])).rows[0]!.id;
  const due = new Date(Date.now() + 3600_000);
  const pb = new Date(due.getTime() + 900_000);
  const schedule = (await db.query<{ id: string }>(
    `INSERT INTO schedules(workspace_id, brand_id, post_id, revision_id, generation, due_at, input_timezone, input_local_time, publish_before, fingerprint)
     VALUES ($1,$2,$3,$4,1,$5,'UTC','2026-01-01T00:00',$6,'fp') RETURNING id`, [workspaceId, brandId, post, rev, due, pb])).rows[0]!.id;
  return (await db.query<{ id: string }>(
    `INSERT INTO deliveries(workspace_id, brand_id, post_id, schedule_id, generation, revision_id, variant_id, connection_id, provider, is_mock, due_at, publish_before, next_attempt_at)
     VALUES ($1,$2,$3,$4,1,$5,$6,$7,'telegram',true,$8,$9,$8) RETURNING id`, [workspaceId, brandId, post, schedule, rev, variant, conn, due, pb])).rows[0]!.id;
}
