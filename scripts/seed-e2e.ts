// Ensure the Playwright workspace exists (SYNTHETIC, local/test only): "E2E Workspace" with the same demo users, brands,
// simulated destinations and sample media as Demo Workspace, so E2E fixtures never land in the demo workspace (V3 §2.7).
// Idempotent: does nothing when it already exists. Run: pnpm db:seed:e2e (Playwright's global setup runs it too).
import { closePool, getPool, maybeOne } from '@social-lite/db';
import { grantOperatorCli } from './platform-operator.js';
import { config } from '@social-lite/services';
import { ensureBucket } from '@social-lite/services/storage';
import { seedAgency } from './seed-agency.js';

const cfg = config();
if (cfg.APP_ENV === 'production') throw new Error('Refusing to seed E2E data in production');
if (!cfg.ENABLE_MOCK_PROVIDERS) throw new Error('E2E seeding needs ENABLE_MOCK_PROVIDERS=true (simulated destinations)');

async function main() {
  const db = getPool();
  const demo = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name='Demo Workspace' AND is_demo`);
  if (!demo) throw new Error('Demo Workspace not found: run pnpm db:seed first (sign-in must default to it)');
  await ensureOnboardingWorkspace();
  // V3.1 Admin: the demo owner is also a platform operator in development/E2E (never in production seeds).
  const op = await maybeOne<{ ok: boolean }>(db, `SELECT to_regclass('public.platform_operators') IS NOT NULL AS ok`);
  if (op?.ok && !(await maybeOne(db, `SELECT 1 FROM platform_operators o JOIN users u ON u.id=o.user_id WHERE u.email='owner@demo.social-lite.test' AND o.revoked_at IS NULL`))) {
    await grantOperatorCli('owner@demo.social-lite.test', 'operator', 'seed');
  }
  const existing = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name='E2E Workspace' AND is_demo`);
  if (existing) { console.log(JSON.stringify({ msg: 'E2E workspace already present', workspaceId: existing.id })); return; }
  await ensureBucket();
  const r = await seedAgency('E2E Workspace', { tipsignalBinding: false });
  console.log(JSON.stringify({ msg: 'E2E workspace seeded', workspaceId: r.wsId }));
}

/**
 * V3.1 §7: "E2E Onboarding" — a new, empty synthetic workspace (one brand, nothing connected, no posts) owned by the
 * demo owner, for the onboarding checklist test and screenshots. Created after Demo Workspace, so sign-in still
 * defaults to Demo. Idempotent.
 */
async function ensureOnboardingWorkspace() {
  const db = getPool();
  const have = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name='E2E Onboarding' AND is_demo`);
  if (have) return;
  const owner = await maybeOne<{ id: string }>(db, `SELECT id FROM users WHERE email='owner@demo.social-lite.test'`);
  if (!owner) throw new Error('owner@demo.social-lite.test not found: run pnpm db:seed first');
  const ws = await maybeOne<{ id: string }>(db, `INSERT INTO workspaces(name, is_demo) VALUES ('E2E Onboarding', true) RETURNING id`);
  await db.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws!.id, owner.id]);
  await db.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, granted_by, source)
    VALUES ($1,'user',$2,'owner','workspace',$2,'seed')`, [ws!.id, owner.id]);
  await db.query(`INSERT INTO brands(workspace_id, name, is_demo) VALUES ($1,'Northwind Bakery (demo)',true)`, [ws!.id]);
  console.log(JSON.stringify({ msg: 'E2E onboarding workspace seeded', workspaceId: ws!.id }));
}

main().then(() => closePool()).catch(async (err) => { console.error(err); await closePool(); process.exit(1); });
