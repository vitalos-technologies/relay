// Service accounts + API keys through the real policy path: creation gating (owner/admin, MFA, step-up),
// key shown once / hash-only storage, immediate revocation/expiry, rotation, brand scoping, no publishing,
// and keys never written to logs or audit.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authorizeCtx, publishNow } from '@social-lite/services';
import {
  authenticateApiKey, createServiceAccount, disableServiceAccount, issueKey, listServiceAccounts, revokeKey, rotateKey, serviceAccountCtx,
} from '@social-lite/services/service-accounts';
import { createIntegrationDraft } from '@social-lite/services/integrations/drafts';
import { addMember, closeTestPool, createBrand, createUser, tenant, testPool, v2Ctx } from './helpers.js';

afterAll(closeTestPool);
beforeAll(() => { testPool(); });

async function setup() {
  const t = await tenant();
  const brandB = await createBrand(t.workspaceId, 'Brand B');
  const admin = await createUser(); await addMember(t.workspaceId, admin.id, 'admin');
  const editor = await createUser(); await addMember(t.workspaceId, editor.id, 'editor');
  return { t, brandB, admin, editor, owner: await v2Ctx(t.owner.id, t.workspaceId) };
}
const bearer = (k: string) => `Bearer ${k}`;

describe('service accounts', () => {
  it('only owner/admin with verified MFA and fresh authentication can create one', async () => {
    const { t, admin, editor } = await setup();
    const input = { name: 'CI bot', brand_id: t.brandId };
    await expect(createServiceAccount(await v2Ctx(editor.id, t.workspaceId), input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createServiceAccount(await v2Ctx(t.owner.id, t.workspaceId, { mfaVerified: false }), input)).rejects.toMatchObject({ code: 'mfa_required' });
    await expect(createServiceAccount(await v2Ctx(t.owner.id, t.workspaceId, { authTime: new Date(Date.now() - 600_000).toISOString() }), input)).rejects.toMatchObject({ code: 'step_up_required' });
    const created = await createServiceAccount(await v2Ctx(admin.id, t.workspaceId), input);
    expect(created.service_account).toMatchObject({ name: 'CI bot', status: 'active', owner: { user_id: admin.id }, grants: [{ role: 'integration', brand_id: t.brandId }] });
    // Service accounts never get human administrative roles (schema + validation).
    await expect(createServiceAccount(await v2Ctx(admin.id, t.workspaceId), { ...input, name: 'x', role: 'admin' })).rejects.toThrow();
    await expect(createServiceAccount(await v2Ctx(admin.id, t.workspaceId), { ...input, name: 'CI bot' })).rejects.toMatchObject({ code: 'conflict' });
    const pv = await testPool().query(`SELECT action FROM audit_events WHERE resource_id=$1`, [created.service_account.id]);
    expect(pv.rows.map((r) => r.action)).toEqual(['service_account.created']);
  });

  it('key is shown once, stored as sha256 only, and authenticates to a brand-scoped draft-only principal', async () => {
    const { t, brandB, owner } = await setup();
    const out = await createServiceAccount(owner, { name: 'Draft bot', brand_id: t.brandId });
    const key = out.key.secret;
    expect(key).toMatch(/^sl_live_[a-z0-9]{12}_[a-f0-9]{64}$/);
    expect(out.key.prefix).toBe(key.slice(0, 20));
    // Not retrievable again: list shows prefixes only; the database holds no plaintext.
    const list = await listServiceAccounts(owner);
    expect(JSON.stringify(list)).not.toContain(key.slice(21));
    const dump = await testPool().query(`SELECT row_to_json(k)::text AS j FROM api_key_hashes k WHERE service_account_id=$1`, [out.service_account.id]);
    expect(dump.rows[0].j).not.toContain(key.slice(21));
    const audits = await testPool().query(`SELECT diff::text AS d FROM audit_events WHERE resource_id=$1`, [out.service_account.id]);
    for (const a of audits.rows) expect(a.d).not.toContain(key.slice(21));

    const p = await authenticateApiKey(bearer(key));
    expect(p).toMatchObject({ serviceAccountId: out.service_account.id, workspaceId: t.workspaceId, prefix: out.key.prefix });
    expect(await authenticateApiKey(bearer(key.slice(0, -1) + (key.endsWith('0') ? '1' : '0')))).toBeNull();
    expect(await authenticateApiKey(bearer('sl_live_short_abc'))).toBeNull();
    expect(await authenticateApiKey(key)).toBeNull(); // missing scheme

    const ctx = await serviceAccountCtx(p!);
    const post = await createIntegrationDraft(ctx, p!.serviceAccountId, t.brandId, { title: 'From API', text: 'Hello' });
    const row = await testPool().query(`SELECT created_by, brand_id FROM posts WHERE id=$1`, [post.id]);
    expect(row.rows[0]).toEqual({ created_by: null, brand_id: t.brandId });
    // Another brand in the same workspace, and another workspace: denied.
    await expect(createIntegrationDraft(ctx, p!.serviceAccountId, brandB, { title: 'x', text: 'y' })).rejects.toMatchObject({ code: 'forbidden' });
    const other = await tenant();
    await expect(createIntegrationDraft(ctx, p!.serviceAccountId, other.brandId, { title: 'x', text: 'y' })).rejects.toMatchObject({ code: 'forbidden' });
    // Cannot publish / schedule / edit / read / manage anything.
    for (const perm of ['content.publish', 'content.schedule', 'content.edit', 'content.read', 'assets.upload', 'service_accounts.manage', 'members.invite'] as const) {
      expect(authorizeCtx(ctx, perm, { brandId: t.brandId }).allowed, perm).toBe(false);
    }
    // Even if a publish path were reachable with this principal, it fails closed and nothing is scheduled.
    await expect(publishNow(ctx, post.id, { expected_version: 1, connection_ids: ['00000000-0000-4000-8000-000000000001'] }, 'idem-sa-publish-1')).rejects.toBeTruthy();
    const sched = await testPool().query(`SELECT count(*)::int n FROM schedules WHERE post_id=$1`, [post.id]);
    expect(sched.rows[0].n).toBe(0);
  });

  it('machine-API drafts honour an Idempotency-Key per service account (M23)', async () => {
    const { t, owner } = await setup();
    const a = await createServiceAccount(owner, { name: 'Retry bot', brand_id: t.brandId });
    const b = await createServiceAccount(owner, { name: 'Other bot', brand_id: t.brandId });
    const pa = (await authenticateApiKey(bearer(a.key.secret)))!;
    const pb = (await authenticateApiKey(bearer(b.key.secret)))!;
    const ctxA = await serviceAccountCtx(pa);
    const input = { title: 'API draft', text: 'Retry me', tags: ['api'] };
    const count = async () => (await testPool().query(`SELECT count(*)::int n FROM posts WHERE brand_id=$1 AND source->>'service_account_id'=$2`, [t.brandId, pa.serviceAccountId])).rows[0].n;
    const first = await createIntegrationDraft(ctxA, pa.serviceAccountId, t.brandId, input, { idempotencyKey: 'retry-key-0001' });
    const again = await createIntegrationDraft(await serviceAccountCtx(pa), pa.serviceAccountId, t.brandId, input, { idempotencyKey: 'retry-key-0001' });
    expect(again).toMatchObject({ id: first.id, replayed: true });
    expect(await count()).toBe(1);
    // Same key, different body: conflict, nothing created.
    await expect(createIntegrationDraft(ctxA, pa.serviceAccountId, t.brandId, { ...input, text: 'Different' }, { idempotencyKey: 'retry-key-0001' }))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
    // Keys are per service account: another account reusing the string gets its own draft.
    const otherSa = await createIntegrationDraft(await serviceAccountCtx(pb), pb.serviceAccountId, t.brandId, input, { idempotencyKey: 'retry-key-0001' });
    expect(otherSa.id).not.toBe(first.id);
    // Too-short key: rejected; no key: not deduplicated (backward compatible).
    await expect(createIntegrationDraft(ctxA, pa.serviceAccountId, t.brandId, input, { idempotencyKey: 'short' })).rejects.toMatchObject({ code: 'validation_failed' });
    await createIntegrationDraft(ctxA, pa.serviceAccountId, t.brandId, input);
    expect(await count()).toBe(2);
    expect((await testPool().query(`SELECT count(*)::int n FROM audit_events WHERE action='post.created' AND resource_id=$1`, [first.id])).rows[0].n).toBe(1);
  });

  it('revoked, expired and rotated-out keys and disabled/expired accounts fail immediately', async () => {
    const { t, owner } = await setup();
    const out = await createServiceAccount(owner, { name: 'Lifecycle', brand_id: t.brandId });
    const saId = out.service_account.id;
    const k1 = out.key.secret;
    expect(await authenticateApiKey(bearer(k1))).not.toBeNull();

    // Rotate (step-up): old key stops working now, new one works, linkage kept for attribution.
    await expect(rotateKey(await v2Ctx(t.owner.id, t.workspaceId, { authTime: null }), saId, out.key.id)).rejects.toMatchObject({ code: 'step_up_required' });
    const rot = await rotateKey(owner, saId, out.key.id);
    expect(await authenticateApiKey(bearer(k1))).toBeNull();
    const k2 = rot.key.secret;
    expect(await authenticateApiKey(bearer(k2))).not.toBeNull();
    const link = await testPool().query(`SELECT rotated_from FROM api_key_hashes WHERE id=$1`, [rot.key.id]);
    expect(link.rows[0].rotated_from).toBe(out.key.id);

    // Revoke: immediate.
    await revokeKey(owner, saId, rot.key.id);
    expect(await authenticateApiKey(bearer(k2))).toBeNull();
    await expect(revokeKey(owner, saId, rot.key.id)).rejects.toMatchObject({ code: 'not_found' });

    // Expired key.
    const k3 = await issueKey(owner, saId, { label: 'short' });
    expect(await authenticateApiKey(bearer(k3.key.secret))).not.toBeNull();
    await testPool().query(`UPDATE api_key_hashes SET expires_at = now() - interval '1 second' WHERE id=$1`, [k3.key.id]);
    expect(await authenticateApiKey(bearer(k3.key.secret))).toBeNull();

    // Expired account (keys still unrevoked) — denied by authentication and by the policy.
    const k4 = await issueKey(owner, saId, {});
    await testPool().query(`UPDATE service_accounts SET expires_at = now() - interval '1 second' WHERE id=$1`, [saId]);
    expect(await authenticateApiKey(bearer(k4.key.secret))).toBeNull();
    await expect(serviceAccountCtx({ serviceAccountId: saId, workspaceId: t.workspaceId })).rejects.toMatchObject({ code: 'unauthenticated' });
    await testPool().query(`UPDATE service_accounts SET expires_at = NULL WHERE id=$1`, [saId]);
    expect(await authenticateApiKey(bearer(k4.key.secret))).not.toBeNull();

    // Disable: every key fails immediately.
    await disableServiceAccount(owner, saId);
    expect(await authenticateApiKey(bearer(k4.key.secret))).toBeNull();
    await expect(issueKey(owner, saId, {})).rejects.toMatchObject({ code: 'invalid_state' });
    const actions = await testPool().query(`SELECT action, diff FROM audit_events WHERE resource_id=$1 ORDER BY id`, [saId]);
    expect(actions.rows.map((r) => r.action)).toEqual(['service_account.created', 'service_account.key_rotated', 'service_account.key_revoked',
      'service_account.key_created', 'service_account.key_created', 'service_account.disabled']);
  });

  it('keys never appear in logs', async () => {
    const { t, owner } = await setup();
    const writes: string[] = [];
    const spies = [vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')].map((s) => s.mockImplementation((c: unknown) => { writes.push(String(c)); return true; }));
    const cons = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { writes.push(a.map(String).join(' ')); }));
    try {
      const out = await createServiceAccount(owner, { name: 'Logs', brand_id: t.brandId });
      await authenticateApiKey(bearer(out.key.secret));
      await authenticateApiKey(bearer(out.key.secret.replace(/.$/, 'x')));
      await revokeKey(owner, out.service_account.id, out.key.id);
      await authenticateApiKey(bearer(out.key.secret));
      expect(writes.join('\n')).not.toContain(out.key.secret.slice(21));
    } finally {
      for (const s of [...spies, ...cons]) s.mockRestore();
    }
  });
});
