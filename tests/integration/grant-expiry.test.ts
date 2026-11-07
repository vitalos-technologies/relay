// G7: expired grants are revoked by a sweep (they were already ignored at access time): audited, policy version
// moves on, legacy membership summary refreshed. Live grants are untouched.
import { afterAll, describe, expect, it } from 'vitest';
import { sweepExpiredGrants } from '../../packages/services/src/grant-expiry.js';
import { addMember, closeTestPool, createUser, grant, tenant, testPool } from './helpers.js';

afterAll(closeTestPool);

describe('expired grant sweep', () => {
  it('revokes only expired grants, audits each and bumps the policy version', async () => {
    const t = await tenant();
    const guest = await createUser();
    await addMember(t.workspaceId, guest.id, 'viewer', [t.brandId]);
    const expired = await grant(t.workspaceId, guest.id, 'guest', t.brandId, new Date(Date.now() + 3600_000));
    const live = await grant(t.workspaceId, guest.id, 'analyst', t.brandId, new Date(Date.now() + 86_400_000));
    await testPool().query(`UPDATE scoped_role_grants SET expires_at=now() - interval '1 minute' WHERE id=$1`, [expired]);
    const ver = async () => (await testPool().query<{ v: number }>(`SELECT policy_version::int v FROM workspaces WHERE id=$1`, [t.workspaceId])).rows[0]!.v;
    const before = await ver();

    expect(await sweepExpiredGrants(testPool())).toBeGreaterThanOrEqual(1);
    const rows = (await testPool().query<{ id: string; revoked: boolean }>(`SELECT id, revoked_at IS NOT NULL revoked FROM scoped_role_grants WHERE id = ANY($1::uuid[])`, [[expired, live]])).rows;
    expect(rows.find((r) => r.id === expired)!.revoked).toBe(true);
    expect(rows.find((r) => r.id === live)!.revoked).toBe(false);
    expect(await ver()).toBeGreaterThan(before);
    const a = await testPool().query(`SELECT actor_service, diff->>'role' role FROM audit_events WHERE resource_id=$1 AND action='grant.expired'`, [expired]);
    expect(a.rows).toEqual([{ actor_service: 'system', role: 'guest' }]);
    // idempotent: nothing left for this grant
    await sweepExpiredGrants(testPool());
    expect((await testPool().query(`SELECT count(*)::int n FROM audit_events WHERE resource_id=$1 AND action='grant.expired'`, [expired])).rows[0].n).toBe(1);
  });
});
