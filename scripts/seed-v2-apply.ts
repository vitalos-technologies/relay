// Apply the V2 tenancy fixtures to an EXISTING demo database (additive; run once): pnpm tsx scripts/seed-v2-apply.ts
import { closePool, getPool, maybeOne } from '@social-lite/db';
import { config } from '@social-lite/services';
import { seedV2OtherOrg, seedV2Tenancy } from './seed-v2-tenancy.js';

if (config().APP_ENV === 'production') throw new Error('Refusing to seed demo data in production');
const db = getPool();
async function main() {
  const ws = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name='Demo Workspace' AND is_demo`);
  if (!ws) throw new Error('Demo Workspace not found: run pnpm db:seed');
  if (await maybeOne(db, `SELECT 1 FROM teams WHERE workspace_id=$1`, [ws.id])) { console.log(JSON.stringify({ msg: 'V2 fixtures already present' })); return; }
  const a = await maybeOne<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND name LIKE 'Vitalos%'`, [ws.id]);
  const b = await maybeOne<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND name LIKE 'TipSignal%'`, [ws.id]);
  const owner = await maybeOne<{ id: string }>(db, `SELECT id FROM users WHERE email='owner@demo.social-lite.test'`);
  await seedV2Tenancy(db, { ws: ws.id, brandA: a!.id, brandB: b!.id, ownerId: owner!.id });
  const other = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name='Other Workspace' AND is_demo`);
  const outsider = await maybeOne<{ id: string }>(db, `SELECT id FROM users WHERE email='outsider@other.social-lite.test'`);
  if (other && outsider) await seedV2OtherOrg(db, { other: other.id, outsider: outsider.id, ownerId: owner!.id });
  console.log(JSON.stringify({ msg: 'V2 fixtures applied', workspaceId: ws.id }));
}
main().then(() => closePool()).catch(async (e) => { console.error(e); await closePool(); process.exit(1); });
