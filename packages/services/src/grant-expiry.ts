// G7: expired grants are already ignored at access time (authz.ts filters expires_at). This sweep makes the expiry
// explicit: the grant is revoked, the legacy membership summary is refreshed, queued publications whose authority
// relied on it are revalidated (held), the policy version moves on, and each expiry is audited.
import { getPool, many, withTx, type Pool } from '@social-lite/db';
import { audit } from './audit.js';
import { commitPolicyChange } from './grants.js';

const BATCH = 500;

export async function sweepExpiredGrants(db: Pool = getPool()): Promise<number> {
  return withTx(async (tx) => {
    const rows = await many<{ id: string; workspace_id: string; principal_type: string; user_id: string | null; team_id: string | null; service_account_id: string | null; role: string; scope_type: string; brand_id: string | null; expires_at: Date }>(tx,
      `UPDATE scoped_role_grants SET revoked_at=now()
        WHERE id IN (SELECT id FROM scoped_role_grants WHERE revoked_at IS NULL AND expires_at <= now()
                      ORDER BY expires_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING id, workspace_id, principal_type, user_id, team_id, service_account_id, role, scope_type, brand_id, expires_at`);
    const byWs = new Map<string, typeof rows>();
    for (const r of rows) byWs.set(r.workspace_id, [...(byWs.get(r.workspace_id) ?? []), r]);
    for (const [ws, list] of byWs) {
      const teamIds = list.map((r) => r.team_id).filter((x): x is string => !!x);
      const viaTeams = teamIds.length
        ? (await many<{ user_id: string }>(tx, `SELECT user_id FROM team_memberships WHERE workspace_id=$1 AND team_id = ANY($2::uuid[])`, [ws, teamIds])).map((m) => m.user_id)
        : [];
      await commitPolicyChange(tx, ws, [...list.map((r) => r.user_id).filter((x): x is string => !!x), ...viaTeams]);
      for (const r of list) {
        await audit(tx, { workspaceId: ws, brandId: r.brand_id, actorService: 'system', action: 'grant.expired', resourceType: 'grant', resourceId: r.id,
          diff: { principal_type: r.principal_type, user_id: r.user_id, team_id: r.team_id, service_account_id: r.service_account_id, role: r.role, scope_type: r.scope_type, expires_at: r.expires_at.toISOString() } });
      }
    }
    return rows.length;
  }, db);
}
