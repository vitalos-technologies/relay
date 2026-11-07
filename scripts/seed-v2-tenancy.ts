// V2 tenancy fixtures (stream B) for the demo seed — spec §2 example + §12 fixtures. Synthetic, local only.
// Users match the local Keycloak realm (infra/keycloak/social-lite-realm.json; password socialite-demo).
//
// Demo Workspace (agency)
//   owner@     owner (workspace)                     admin@      admin (workspace)
//   editor@    Editorial team (editor on Vitalos) + TipSignal desk (editor on TipSignal)
//   teammanager@ Editorial team manager (ceiling: editor on Vitalos)
//   publisher@ Publishing team (publisher on Vitalos)
//   approver@  approver on Vitalos + TipSignal      analyst@    analyst on Vitalos      viewer@  viewer (workspace)
//   guest@     guest reviewer on Vitalos, expires in 14 days
//   expired-guest@ guest on Vitalos, expired yesterday (no access)
//   Teams: Editorial + Publishing share Vitalos (Brand A); TipSignal desk has TipSignal (Brand B) only.
// Other Workspace (separate organisation, seedV2OtherOrg): owner@other owner, outsider@other editor.
import type { Pool } from '@social-lite/db';
import { one } from '@social-lite/db';
import { syncLegacyMembership } from '@social-lite/services/grants';

type Grant = { role: string; brand?: string; expires?: Date };

export async function seedV2Tenancy(db: Pool, p: { ws: string; brandA: string; brandB: string; ownerId: string }): Promise<Record<string, string>> {
  const user = async (email: string, name: string) => (await one<{ id: string }>(db,
    `INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified, name) VALUES ('pending', $1, $2, false, $3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [`pending:${email}`, email, name])).id;
  const id = async (email: string) => (await one<{ id: string }>(db, `SELECT id FROM users WHERE email=$1`, [email])).id;
  const people: Record<string, string> = {
    owner: await id('owner@demo.social-lite.test'),
    admin: await id('admin@demo.social-lite.test'),
    editor: await id('editor@demo.social-lite.test'),
    approver: await id('approver@demo.social-lite.test'),
    viewer: await id('viewer@demo.social-lite.test'),
    publisher: await user('publisher@demo.social-lite.test', 'Pia Publisher (demo)'),
    analyst: await user('analyst@demo.social-lite.test', 'Ana Analyst (demo)'),
    teammanager: await user('teammanager@demo.social-lite.test', 'Tom Team-Manager (demo)'),
    guest: await user('guest@demo.social-lite.test', 'Gale Guest Reviewer (demo)'),
    expiredGuest: await user('expired-guest@demo.social-lite.test', 'Ezra Expired Guest (demo)'),
    otherOwner: await user('owner@other.social-lite.test', 'Ola Other-Owner (demo)'),
  };
  const member = async (ws: string, u: string) => db.query(
    `INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer') ON CONFLICT (workspace_id, user_id) DO NOTHING`, [ws, u]);
  const grant = async (ws: string, u: string, g: Grant) => db.query(
    `INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, brand_id, expires_at, granted_by, source)
     VALUES ($1,'user',$2,$3,$4,$5,$6,$7,'seed') ON CONFLICT DO NOTHING`,
    [ws, u, g.role, g.brand ? 'brand' : 'workspace', g.brand ?? null, g.expires ?? null, p.ownerId]);
  const day = 86400_000;
  const direct: Record<string, Grant[]> = {
    owner: [{ role: 'owner' }],
    admin: [{ role: 'admin' }],
    approver: [{ role: 'approver', brand: p.brandA }, { role: 'approver', brand: p.brandB }],
    analyst: [{ role: 'analyst', brand: p.brandA }],
    viewer: [{ role: 'viewer' }],
    guest: [{ role: 'guest', brand: p.brandA, expires: new Date(Date.now() + 14 * day) }],
    expiredGuest: [{ role: 'guest', brand: p.brandA, expires: new Date(Date.now() - day) }],
    teammanager: [{ role: 'team_manager' }],
  };
  for (const [k, u] of Object.entries(people)) {
    if (k === 'otherOwner') continue;
    await member(p.ws, u);
    for (const g of direct[k] ?? []) await grant(p.ws, u, g);
  }
  const team = async (name: string, description: string, grants: Grant[], members: Array<[string, boolean]>, ceiling?: { roles: string[]; brands: string[] }) => {
    const t = await one<{ id: string }>(db, `INSERT INTO teams(workspace_id, name, description, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [p.ws, name, description, p.ownerId]);
    for (const g of grants) {
      await db.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, team_id, role, scope_type, brand_id, granted_by, source) VALUES ($1,'team',$2,$3,'brand',$4,$5,'seed')`,
        [p.ws, t.id, g.role, g.brand, p.ownerId]);
    }
    for (const [u, mgr] of members) {
      await db.query(`INSERT INTO team_memberships(workspace_id, team_id, user_id, is_manager, added_by) VALUES ($1,$2,$3,$4,$5)`, [p.ws, t.id, u, mgr, p.ownerId]);
    }
    if (ceiling) {
      await db.query(`INSERT INTO delegation_limits(workspace_id, team_id, grantable_roles, brand_ids, updated_by) VALUES ($1,$2,$3,$4::uuid[],$5)`,
        [p.ws, t.id, ceiling.roles, ceiling.brands, p.ownerId]);
    }
    return t.id;
  };
  await team('Editorial', 'Writes and edits Vitalos content', [{ role: 'editor', brand: p.brandA }],
    [[people.editor!, false], [people.teammanager!, true]], { roles: ['editor'], brands: [p.brandA] });
  await team('Publishing', 'Schedules and publishes Vitalos', [{ role: 'publisher', brand: p.brandA }], [[people.publisher!, false]]);
  await team('TipSignal desk', 'TipSignal only', [{ role: 'editor', brand: p.brandB }], [[people.editor!, false]]);
  for (const u of Object.values(people)) {
    if (u !== people.otherOwner) await syncLegacyMembership(db, p.ws, u);
  }

  await db.query(`UPDATE workspaces SET policy_version = policy_version + 1 WHERE id=$1`, [p.ws]);
  return people;
}

/** Separate organisation: owner@other is the owner (MFA in Keycloak), outsider@other an editor. */
export async function seedV2OtherOrg(db: Pool, p: { other: string; outsider: string; ownerId: string }): Promise<void> {
  const otherOwner = (await one<{ id: string }>(db, `SELECT id FROM users WHERE email='owner@other.social-lite.test'`)).id;
  await db.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer') ON CONFLICT (workspace_id, user_id) DO NOTHING`, [p.other, otherOwner]);
  await db.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, source) VALUES ($1,'user',$2,'owner','workspace','seed') ON CONFLICT DO NOTHING`, [p.other, otherOwner]);
  await db.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, source) VALUES ($1,'user',$2,'editor','workspace','seed') ON CONFLICT DO NOTHING`, [p.other, p.outsider]);
  await syncLegacyMembership(db, p.other, otherOwner);
  await syncLegacyMembership(db, p.other, p.outsider);
  await db.query(`UPDATE workspaces SET policy_version = policy_version + 1 WHERE id=$1`, [p.other]);
}
