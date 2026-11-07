// Ensure the Playwright workspace exists (SYNTHETIC, local/test only): "E2E Workspace" with the same demo users, brands,
// simulated destinations and sample media as Demo Workspace, so E2E fixtures never land in the demo workspace (V3 §2.7).
// Idempotent: does nothing when it already exists. Run: pnpm db:seed:e2e (Playwright's global setup runs it too).
import { closePool, getPool, maybeOne } from '@social-lite/db';
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
  const existing = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name='E2E Workspace' AND is_demo`);
  if (existing) { console.log(JSON.stringify({ msg: 'E2E workspace already present', workspaceId: existing.id })); return; }
  await ensureBucket();
  const r = await seedAgency('E2E Workspace', { tipsignalBinding: false });
  console.log(JSON.stringify({ msg: 'E2E workspace seeded', workspaceId: r.wsId }));
}

main().then(() => closePool()).catch(async (err) => { console.error(err); await closePool(); process.exit(1); });
