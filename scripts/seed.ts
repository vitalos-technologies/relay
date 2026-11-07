// Seed SYNTHETIC demo data for local development/review. Never runs in production.
//  - Demo workspace with two clearly labelled demo brands and simulated (mock_) destinations
//  - Pre-provisioned users matching the local Keycloak identities (bound on first verified login)
//  - A real image uploaded through the same upload-intent → validation pipeline
//  - Sample drafts, a scheduled post and recent simulated results
// A second "Other Workspace" exists only to demonstrate tenant isolation.
import { closePool, getPool, maybeOne, one } from '@social-lite/db';
import { config } from '@social-lite/services';
import { ensureBucket } from '@social-lite/services/storage';
import { seedV2OtherOrg } from './seed-v2-tenancy.js';
import { seedAgency, user } from './seed-agency.js';

const cfg = config();
if (cfg.APP_ENV === 'production') throw new Error('Refusing to seed demo data in production');
if (!cfg.ENABLE_MOCK_PROVIDERS) throw new Error('Seeding needs ENABLE_MOCK_PROVIDERS=true (simulated destinations)');

const db = getPool();

async function main() {
  const existing = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name='Demo Workspace' AND is_demo`);
  if (existing && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ msg: 'demo data already present; use pnpm db:reset for a clean slate', workspaceId: existing.id }));
    return;
  }
  await ensureBucket();
  await user('invitee@demo.social-lite.test', 'Ivy Invitee (demo)'); // no membership: used for the invitation flow
  const outsider = await user('outsider@other.social-lite.test', 'Otto Outsider (demo)');

  const { wsId, ids, brands } = await seedAgency('Demo Workspace', { tipsignalBinding: true });

  // Isolation demo tenant
  const other = await one<{ id: string }>(db, `INSERT INTO workspaces(name, is_demo) VALUES ('Other Workspace', true) RETURNING id`);
  await db.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [other.id, outsider]);
  await db.query(`INSERT INTO brands(workspace_id, name, is_demo) VALUES ($1,'Other Brand (demo)',true)`, [other.id]);

  await seedV2OtherOrg(db, { other: other.id, outsider, ownerId: ids.owner! });

  // E2E fixtures get their own workspace (created after the demo one, so sign-in still lands in Demo Workspace).
  const e2e = await seedAgency('E2E Workspace', { tipsignalBinding: false });

  console.log(JSON.stringify({ msg: 'seeded', workspaceId: wsId, e2eWorkspaceId: e2e.wsId, brands, note: 'Start the worker to deliver the simulated publish-now posts.' }));
}

main().then(() => closePool()).catch(async (err) => { console.error(err); await closePool(); process.exit(1); });
