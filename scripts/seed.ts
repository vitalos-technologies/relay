// Seed SYNTHETIC demo data for local development/review. Never runs in production.
//  - Demo workspace with two clearly labelled demo brands and simulated (mock_) destinations
//  - Pre-provisioned users matching the local Keycloak identities (bound on first verified login)
//  - A real image uploaded through the same upload-intent → validation pipeline
//  - Sample drafts, a scheduled post and recent simulated results
// A second "Other Workspace" exists only to demonstrate tenant isolation.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { closePool, getPool, maybeOne, one } from '@social-lite/db';
import { toLocalInput, type Provider, type Role } from '@social-lite/core';
import { config, createPost, publishNow, schedulePost, type Ctx } from '@social-lite/services';
import { connectMock } from '@social-lite/services/connections/index';
import { completeUpload, createUploadIntent } from '@social-lite/services/media/index';
import { ensureBucket } from '@social-lite/services/storage';
import { seedV2OtherOrg, seedV2Tenancy } from './seed-v2-tenancy.js';

const cfg = config();
if (cfg.APP_ENV === 'production') throw new Error('Refusing to seed demo data in production');
if (!cfg.ENABLE_MOCK_PROVIDERS) throw new Error('Seeding needs ENABLE_MOCK_PROVIDERS=true (simulated destinations)');

const db = getPool();
const USERS: Array<{ email: string; name: string; role: Role }> = [
  { email: 'owner@demo.social-lite.test', name: 'Olivia Owner (demo)', role: 'owner' },
  { email: 'admin@demo.social-lite.test', name: 'Adam Admin (demo)', role: 'admin' },
  { email: 'editor@demo.social-lite.test', name: 'Eden Editor (demo)', role: 'editor' },
  { email: 'approver@demo.social-lite.test', name: 'April Approver (demo)', role: 'approver' },
  { email: 'viewer@demo.social-lite.test', name: 'Vic Viewer (demo)', role: 'viewer' },
];

async function user(email: string, name: string): Promise<string> {
  const r = await one<{ id: string }>(db,
    `INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified, name) VALUES ('pending', $1, $2, false, $3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [`pending:${email}`, email, name]);
  return r.id;
}

function ctx(userId: string, workspaceId: string, role: Role): Ctx {
  return { actor: { userId, email: 'seed', name: 'seed', sessionId: randomUUID() }, access: { workspaceId, role, brandIds: null, isDemo: true }, correlationId: `seed-${randomUUID()}` };
}

async function demoImage(title: string, accent: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#15171A"/><stop offset="1" stop-color="#0D0E10"/></linearGradient></defs>
    <rect width="1080" height="1350" fill="url(#g)"/>
    <rect x="80" y="80" width="12" height="160" fill="${accent}"/>
    <text x="120" y="150" font-family="Helvetica, Arial, sans-serif" font-size="44" fill="#9AA1A9">DEMO • SYNTHETIC CONTENT</text>
    <text x="120" y="230" font-family="Helvetica, Arial, sans-serif" font-size="72" font-weight="700" fill="#EDEEF0">${title}</text>
    <circle cx="820" cy="980" r="220" fill="none" stroke="${accent}" stroke-width="10"/>
    <text x="120" y="1250" font-family="Helvetica, Arial, sans-serif" font-size="36" fill="#9AA1A9">Social Lite sample asset</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function upload(c: Ctx, brandId: string, name: string, bytes: Buffer): Promise<string> {
  const intent = await createUploadIntent(c, { brand_id: brandId, filename: name, content_type: 'image/png', bytes: bytes.length });
  const form = new FormData();
  for (const [k, v] of Object.entries(intent.upload.fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name);
  const res = await fetch(intent.upload.url, { method: 'POST', body: form });
  if (!res.ok && res.status !== 204) throw new Error(`upload failed: HTTP ${res.status}`);
  const asset = await completeUpload(c, intent.asset_id);
  if (asset.status !== 'ready') throw new Error(`seed image was ${asset.status}: ${asset.rejection_reason}`);
  return asset.id;
}

async function main() {
  const existing = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name='Demo Workspace' AND is_demo`);
  if (existing && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ msg: 'demo data already present; use pnpm db:reset for a clean slate', workspaceId: existing.id }));
    return;
  }
  await ensureBucket();
  const ids: Record<string, string> = {};
  for (const u of USERS) ids[u.role] = await user(u.email, u.name);
  await user('invitee@demo.social-lite.test', 'Ivy Invitee (demo)'); // no membership: used for the invitation flow
  const outsider = await user('outsider@other.social-lite.test', 'Otto Outsider (demo)');

  const ws = await one<{ id: string }>(db, `INSERT INTO workspaces(name, is_demo, limits) VALUES ('Demo Workspace', true, '{"x_monthly_writes": 100, "x_monthly_reads": 300}') RETURNING id`);
  for (const u of USERS) await db.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,$3)`, [ws.id, ids[u.role], u.role]);
  const brandA = await one<{ id: string }>(db, `INSERT INTO brands(workspace_id, name, is_demo, voice) VALUES ($1,'Vitalos (demo)',true,$2) RETURNING id`,
    [ws.id, JSON.stringify({ tone: 'Calm, practical, evidence-led', hashtags: ['#Vitalos'], default_cta: 'Learn more' })]);
  const brandB = await one<{ id: string }>(db, `INSERT INTO brands(workspace_id, name, is_demo, approval_required) VALUES ($1,'TipSignal (demo)',true,true) RETURNING id`, [ws.id]);
  // V2 (stream B): scoped grants, teams, guests, team manager — before any work is scheduled.
  await seedV2Tenancy(db, { ws: ws.id, brandA: brandA.id, brandB: brandB.id, ownerId: ids.owner! });

  const owner = ctx(ids.owner!, ws.id, 'owner');
  const conns: Record<string, Record<Provider, string>> = {};
  for (const [brand, label] of [[brandA.id, 'Vitalos'], [brandB.id, 'TipSignal']] as const) {
    conns[brand] = {} as Record<Provider, string>;
    for (const p of ['instagram', 'facebook', 'telegram', 'x'] as Provider[]) {
      const c = await connectMock(owner, brand, { provider: p, display_name: `${label} ${p === 'x' ? 'X' : p[0]!.toUpperCase() + p.slice(1)} (simulated)`, scenario: 'success' });
      conns[brand]![p] = c.id;
    }
  }
  const imgA = await upload(owner, brandA.id, 'vitalos-sample.png', await demoImage('Spring wellness check-in', '#C8F25A'));
  const imgB = await upload(owner, brandB.id, 'tipsignal-sample.png', await demoImage('Weekend fixtures preview', '#7CC4FF'));

  const all = (brand: string) => Object.values(conns[brand]!);
  const draft = (text: string, img: string | null, brand: string) => ({ baseText: text, baseLink: null, baseAssetIds: img ? [img] : [],
    variants: all(brand).map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) });

  // 1) Draft (not scheduled)
  await createPost(owner, brandA.id, { title: 'Draft: hydration tips', draft: draft('Five small habits for better hydration this week. 💧', imgA, brandA.id) }, randomUUID());
  // 2) Scheduled tomorrow 09:00 Europe/London
  const tomorrow = new Date(Date.now() + 24 * 3600_000);
  const local = toLocalInput(tomorrow, 'Europe/London').slice(0, 10) + 'T09:00';
  const p2 = await createPost(owner, brandA.id, { title: 'Scheduled: spring check-in', draft: draft('Spring check-in: book your review this month. #Vitalos', imgA, brandA.id) }, randomUUID());
  await schedulePost(owner, p2.id, { expected_version: 1, connection_ids: all(brandA.id), input_local_time: local, timezone: 'Europe/London' }, randomUUID());
  // 3) Published now (simulated) — the worker delivers it
  const p3 = await createPost(owner, brandA.id, { title: 'Published: welcome post', draft: draft('Welcome to the new Vitalos channel. Simulated demo post.', imgA, brandA.id) }, randomUUID());
  await publishNow(owner, p3.id, { expected_version: 1, connection_ids: all(brandA.id) }, randomUUID());
  // 4) A partial-failure example: X destination simulates a permanent rejection
  //    A separate simulated destination always rejects posts, so this example is reproducible without affecting others.
  const rejecting = await connectMock(owner, brandA.id, { provider: 'x', display_name: 'Vitalos X — rejects posts (simulated)', scenario: 'fail_permanent' });
  const p4ids = [conns[brandA.id]!.instagram, conns[brandA.id]!.facebook, conns[brandA.id]!.telegram, rejecting.id];
  const p4 = await createPost(owner, brandA.id, { title: 'Partial: event reminder', draft: { ...draft('Reminder: open evening on Thursday.', imgA, brandA.id),
    variants: p4ids.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) } }, randomUUID());
  await publishNow(owner, p4.id, { expected_version: 1, connection_ids: p4ids }, randomUUID());
  // 5) TipSignal brand requires approval: a draft awaiting review is created by the editor in the UI flow; here a draft only.
  await createPost(ctx(ids.editor!, ws.id, 'editor'), brandB.id, { title: 'Draft: weekend preview', draft: draft('Weekend preview: fixtures and form guide. Probabilities are not promises.', imgB, brandB.id) }, randomUUID());

  // TipSignal (demo) receives signed source events as drafts (V1.1). V2: drafts are created by a service account
  // holding only an `integration` grant (content.create_draft) on the TipSignal brand; the owner is its named owner.
  const tipsignalSa = await one<{ id: string }>(db, `INSERT INTO service_accounts(workspace_id, name, owner_user_id, purpose, created_by, description)
    VALUES ($1,'TipSignal',$2,'tipsignal',$2,'Creates drafts from signed TipSignal events') RETURNING id`, [ws.id, ids.owner]);
  await db.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, service_account_id, role, scope_type, brand_id, granted_by, source)
    VALUES ($1,'service_account',$2,'integration','brand',$3,$4,'seed')`, [ws.id, tipsignalSa.id, brandB.id, ids.owner]);
  await db.query(`INSERT INTO integration_bindings(kind, workspace_id, brand_id, service_account_id) VALUES ('tipsignal',$1,$2,$3) ON CONFLICT (kind) DO NOTHING`, [ws.id, brandB.id, tipsignalSa.id]);

  // Isolation demo tenant
  const other = await one<{ id: string }>(db, `INSERT INTO workspaces(name, is_demo) VALUES ('Other Workspace', true) RETURNING id`);
  await db.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [other.id, outsider]);
  await db.query(`INSERT INTO brands(workspace_id, name, is_demo) VALUES ($1,'Other Brand (demo)',true)`, [other.id]);

  await seedV2OtherOrg(db, { other: other.id, outsider, ownerId: ids.owner! });

  console.log(JSON.stringify({ msg: 'seeded', workspaceId: ws.id, brands: [brandA.id, brandB.id], note: 'Start the worker to deliver the simulated publish-now posts.' }));
}

main().then(() => closePool()).catch(async (err) => { console.error(err); await closePool(); process.exit(1); });
