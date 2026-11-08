// SYNTHETIC "Relay Showcase" workspace for the marketing hero screenshot (V5 MKT; DEV/LOCAL ONLY — refuses production).
// A fictional bakery brand run by a fictional person, healthy simulated destinations, a believable week (scheduled posts
// with images over the next days, items in review, a few published), synthetic analytics (labelled "Demo data" in the
// app), a couple of simulated inbox conversations, and zero failed/expired deliveries. Uses the real services (same
// authorization, audit and outbox as the product). Idempotent: does nothing when the workspace already exists.
//   set -a; . ./.env; set +a; npx tsx scripts/seed-marketing-showcase.ts
// Also (dev only) turns the support widget on in Platform → Marketing so screenshots/E2E show it; production keeps the
// default (off) until an operator enables it.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { closePool, getPool, maybeOne, one } from '@social-lite/db';
import { toLocalInput, type Provider } from '@social-lite/core';
import { MARKETING_CONFIG_KEY } from '@social-lite/core/contracts/v5-marketing';
import { config, createPost, loadAccess, publishNow, schedulePost, submitForReview, type Ctx } from '@social-lite/services';
import { connectMock } from '@social-lite/services/connections/index';
import { completeUpload, createUploadIntent } from '@social-lite/services/media/index';
import { seedAnalyticsDemo } from '@social-lite/services/analytics/demo';
import { updateOnboarding } from '@social-lite/services/gov/onboarding';
import { enableChannel, simulateInbound } from '@social-lite/services/inbox/index';

const cfg = config();
if (cfg.APP_ENV === 'production') throw new Error('Refusing to seed showcase data in production');
if (!cfg.ENABLE_MOCK_PROVIDERS) throw new Error('Showcase seeding needs ENABLE_MOCK_PROVIDERS=true (simulated destinations)');

export const SHOWCASE_WORKSPACE = 'Relay Showcase';
export const SHOWCASE_OWNER = { email: 'ava.moreno@showcase.social-lite.test', name: 'Ava Moreno' };
const TZ = 'Europe/London';
const db = getPool();

async function ctxFor(userId: string, workspaceId: string): Promise<Ctx> {
  const access = await loadAccess(userId, workspaceId, db, { mfaVerified: true, authTime: new Date().toISOString() });
  if (!access) throw new Error('showcase owner has no access');
  return { actor: { userId, email: SHOWCASE_OWNER.email, name: SHOWCASE_OWNER.name, sessionId: randomUUID() }, access, correlationId: `showcase-${randomUUID()}` };
}

/** Soft "photo-like" abstract artwork (no text, no real products or people). */
async function artwork(seed: number, a: string, b: string, c: string): Promise<Buffer> {
  const circles = Array.from({ length: 5 }, (_, i) => {
    const x = 180 + ((seed * 97 + i * 211) % 720), y = 220 + ((seed * 53 + i * 173) % 860), r = 90 + ((seed + i * 37) % 140);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${i % 2 ? b : c}" opacity="${0.35 + (i % 3) * 0.15}"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="28"/></filter></defs>
    <rect width="1080" height="1350" fill="url(#g)"/><g filter="url(#blur)">${circles}</g>
    <rect x="140" y="900" width="800" height="260" rx="130" fill="#ffffff" opacity="0.18"/>
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
  if (asset.status !== 'ready') throw new Error(`showcase image was ${asset.status}: ${asset.rejection_reason}`);
  return asset.id;
}

const dayLocal = (offsetDays: number, hhmm: string) => `${toLocalInput(new Date(Date.now() + offsetDays * 86_400_000), TZ).slice(0, 10)}T${hhmm}`;

async function enableWidgetInDev() {
  // Dev convenience only (APP_ENV checked above): show the support widget so local screenshots/E2E include it.
  const cur = await maybeOne<{ value: Record<string, unknown> }>(db, `SELECT value FROM system_flags WHERE key=$1`, [MARKETING_CONFIG_KEY]);
  if (cur?.value?.widget_enabled === true) return;
  await db.query(`INSERT INTO system_flags(key, value, updated_by) VALUES ($1, $2::jsonb, 'seed:dev')
                  ON CONFLICT (key) DO UPDATE SET value = system_flags.value || EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [MARKETING_CONFIG_KEY, JSON.stringify({ widget_enabled: true, widget_staffed: false })]);
}

const SYNTH_PROVIDERS: Provider[] = ['instagram', 'facebook', 'linkedin', 'threads'];
const LABEL: Partial<Record<Provider, string>> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', threads: 'Threads' };

/** Delete synthetic analytics fixtures (and their synthetic posts) of one brand — same steps as the demo's own recreate. */
async function dropSynthetic(workspaceId: string, brandId: string) {
  const ids = (await db.query<{ id: string }>(`SELECT id FROM connections WHERE workspace_id=$1 AND brand_id=$2 AND is_synthetic`, [workspaceId, brandId])).rows.map((r) => r.id);
  if (!ids.length) return;
  const postIds = (await db.query<{ post_id: string }>(`SELECT DISTINCT post_id FROM deliveries WHERE workspace_id=$1 AND connection_id = ANY($2::uuid[])`, [workspaceId, ids])).rows.map((r) => r.post_id);
  await db.query(`DELETE FROM metric_snapshots WHERE connection_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM metric_fetch_state WHERE delivery_id IN (SELECT id FROM deliveries WHERE connection_id = ANY($1::uuid[]))`, [ids]);
  await db.query(`DELETE FROM deliveries WHERE workspace_id=$1 AND connection_id = ANY($2::uuid[])`, [workspaceId, ids]);
  await db.query(`DELETE FROM posts WHERE workspace_id=$1 AND id = ANY($2::uuid[])`, [workspaceId, postIds]);
  await db.query(`DELETE FROM connections WHERE id = ANY($1::uuid[])`, [ids]);
}

/**
 * Synthetic analytics ("Demo data" in the app) on the bakery brand, for the same networks as its simulated destinations.
 * The analytics demo creates its own paused, synthetic accounts named after a generic demo café; in this showcase they are
 * renamed to the brand's accounts and un-paused so Channel health reads healthy. They stay flagged synthetic (the app keeps
 * labelling their numbers as demo data) and nothing is ever scheduled to them.
 */
async function showcaseAnalytics(workspaceId: string) {
  const stray = await maybeOne<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND name LIKE 'Relay Coffee%'`, [workspaceId]);
  if (stray) {
    await dropSynthetic(workspaceId, stray.id);
    await db.query(`DELETE FROM campaigns WHERE brand_id=$1`, [stray.id]).catch(() => undefined);
    await db.query(`DELETE FROM brands WHERE id=$1`, [stray.id]).catch(async () => { await db.query(`UPDATE brands SET archived_at=now() WHERE id=$1`, [stray.id]); });
  }
  const r = await seedAnalyticsDemo({ workspaceId, brandName: 'Lumen Lane Bakery', providers: SYNTH_PROVIDERS, days: 60 });
  for (const p of SYNTH_PROVIDERS) {
    await db.query(`UPDATE connections SET display_name=$3, username='lumenlane', paused=false WHERE workspace_id=$1 AND brand_id=$2 AND is_synthetic AND provider=$4`,
      [workspaceId, r.brandId, `Lumen Lane ${LABEL[p]} · insights`, p]);
  }
  await db.query(`UPDATE campaigns SET name = replace(name, ' (demo)', '') WHERE brand_id=$1 AND name LIKE '% (demo)'`, [r.brandId]).catch(() => undefined);
  return { posts: r.posts, points: r.points, connections: r.connectionIds.length, synthetic: r.synthetic };
}

/**
 * A failed earlier run may have left "Relay Showcase (…)" behind (renamed + suspended by hand): purge it — every row of that
 * synthetic workspace, in dependency order (repeated passes inside one transaction), then the workspace. Local only.
 */
async function removePartialSeeds() {
  const rows = (await db.query<{ id: string }>(`SELECT id FROM workspaces WHERE name LIKE 'Relay Showcase (%' AND is_demo AND state='suspended'`)).rows;
  if (!rows.length) return;
  const tables = (await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.columns WHERE column_name='workspace_id' AND table_schema='public' AND table_name<>'workspaces'`)).rows.map((r) => r.table_name);
  for (const w of rows) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      let done = false;
      for (let pass = 0; pass < 12 && !done; pass++) {
        for (const t of tables) {
          await client.query('SAVEPOINT s');
          try { await client.query(`DELETE FROM "${t}" WHERE workspace_id=$1`, [w.id]); await client.query('RELEASE SAVEPOINT s'); } catch { await client.query('ROLLBACK TO SAVEPOINT s'); }
        }
        await client.query('SAVEPOINT w');
        try { await client.query(`DELETE FROM workspaces WHERE id=$1`, [w.id]); done = true; } catch { await client.query('ROLLBACK TO SAVEPOINT w'); }
      }
      await client.query(done ? 'COMMIT' : 'ROLLBACK');
      console.log(JSON.stringify({ msg: done ? 'removed partial showcase workspace' : 'partial showcase workspace left suspended', workspaceId: w.id }));
    } finally { client.release(); }
  }
}

async function main() {
  await enableWidgetInDev();
  await removePartialSeeds();
  const existing = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name=$1 AND is_demo AND state='active'`, [SHOWCASE_WORKSPACE]);
  if (existing) {
    const analytics = await showcaseAnalytics(existing.id);
    console.log(JSON.stringify({ msg: 'showcase workspace already present; analytics made on-brand', workspaceId: existing.id, analytics }));
    return;
  }

  const owner = await one<{ id: string }>(db,
    `INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified, name) VALUES ('pending', $1, $2, false, $3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [`pending:${SHOWCASE_OWNER.email}`, SHOWCASE_OWNER.email, SHOWCASE_OWNER.name]);
  const ws = await one<{ id: string }>(db, `INSERT INTO workspaces(name, is_demo, timezone) VALUES ($1, true, $2) RETURNING id`, [SHOWCASE_WORKSPACE, TZ]);
  await db.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws.id, owner.id]);
  await db.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, granted_by, source)
                  VALUES ($1,'user',$2,'owner','workspace',$2,'seed')`, [ws.id, owner.id]);
  const bakery = await one<{ id: string }>(db, `INSERT INTO brands(workspace_id, name, is_demo, timezone, voice) VALUES ($1,'Lumen Lane Bakery',true,$2,$3) RETURNING id`,
    [ws.id, TZ, JSON.stringify({ tone: 'Warm, local, a little playful', hashtags: ['#LumenLane'], default_cta: 'Book a table' })]);
  const events = await one<{ id: string }>(db, `INSERT INTO brands(workspace_id, name, is_demo, timezone, approval_required) VALUES ($1,'Lumen Lane Events',true,$2,true) RETURNING id`, [ws.id, TZ]);
  const c = await ctxFor(owner.id, ws.id);

  const name: Partial<Record<Provider, string>> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', threads: 'Threads', bluesky: 'Bluesky' };
  const conns: Record<string, string[]> = {};
  const byProvider: Record<string, Partial<Record<Provider, string>>> = {};
  for (const [brand, label, providers] of [[bakery.id, 'Lumen Lane', ['instagram', 'facebook', 'linkedin', 'threads']], [events.id, 'Lumen Lane Events', ['instagram', 'facebook', 'bluesky']]] as const) {
    conns[brand] = []; byProvider[brand] = {};
    for (const p of providers as readonly Provider[]) {
      const conn = await connectMock(c, brand, { provider: p, display_name: `${label} ${name[p]}`, scenario: 'success' });
      conns[brand]!.push(conn.id); byProvider[brand]![p] = conn.id;
    }
  }

  const palettes: Array<[string, string, string]> = [['#fbcfe8', '#c084fc', '#fde68a'], ['#fde68a', '#fb923c', '#f9a8d4'], ['#a5f3fc', '#818cf8', '#f0abfc'], ['#bbf7d0', '#34d399', '#fef08a'], ['#fecaca', '#f472b6', '#c4b5fd'], ['#ddd6fe', '#a78bfa', '#fbcfe8']];
  const imgs: string[] = [];
  for (let i = 0; i < palettes.length; i++) imgs.push(await upload(c, i < 4 ? bakery.id : events.id, `lumen-lane-${i + 1}.png`, await artwork(i + 3, ...palettes[i]!)));

  const draft = (text: string, img: string, ids: string[]) => ({ baseText: text, baseLink: null, baseAssetIds: [img], variants: ids.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) });
  const schedule = async (brand: string, title: string, text: string, img: string, ids: string[], when: string, review = false) => {
    const p = await createPost(c, brand, { title, draft: draft(text, img, ids) }, randomUUID());
    const req = { expected_version: 1, connection_ids: ids, input_local_time: when, timezone: TZ };
    await (review ? submitForReview(c, p.id, req, randomUUID()) : schedulePost(c, p.id, req, randomUUID()));
  };
  const bake = conns[bakery.id]!;
  const ig = byProvider[bakery.id]!;
  // The week ahead (bakery brand: no approval step).
  await schedule(bakery.id, 'Spring menu launch', 'Five new bakes land on Wednesday — come taste spring. 🌸 #LumenLane', imgs[0]!, bake, dayLocal(1, '09:30'));
  await schedule(bakery.id, 'Behind the scenes: 5am bake', 'Ever wondered what 5am smells like? Our bakers show you. #LumenLane', imgs[1]!, [ig.instagram!, ig.threads!], dayLocal(1, '12:00'));
  await schedule(bakery.id, 'Meet the team: Priya', 'Meet Priya, our pastry lead and the reason our croissants have 81 layers.', imgs[2]!, [ig.instagram!, ig.facebook!, ig.linkedin!], dayLocal(2, '10:00'));
  await schedule(bakery.id, 'Weekend brunch is back', 'Brunch returns this Saturday from 9 till 2. Book a table from the link in our profile.', imgs[3]!, bake, dayLocal(3, '08:45'));
  await schedule(bakery.id, 'Customer story: the Okafor family', 'Three generations, one Sunday ritual. Thank you for sharing your story with us.', imgs[2]!, [ig.facebook!, ig.linkedin!], dayLocal(4, '16:15'));
  // In review (events brand requires approval; the author cannot approve their own post, so these wait for a decision).
  await schedule(events.id, 'Supper club: spring tasting', 'Join our spring supper club — six courses, one long table. Tickets on sale now.', imgs[4]!, conns[events.id]!, dayLocal(2, '18:00'), true);
  await schedule(events.id, 'Sourdough workshop', 'Learn to bake sourdough with our head baker. Small groups, flour included.', imgs[5]!, conns[events.id]!, dayLocal(5, '11:00'), true);
  // Published (simulated destinations; the worker delivers them).
  for (const [title, text, img] of [
    ['Fresh this morning', 'Cardamom buns are out of the oven. First tray goes fast. #LumenLane', imgs[1]!],
    ['Thank you, neighbours', 'Thank you for a wonderful first year on Lumen Lane. Cake is on us this Friday.', imgs[0]!],
  ] as const) {
    const p = await createPost(c, bakery.id, { title, draft: draft(text, img, [ig.instagram!, ig.facebook!]) }, randomUUID());
    await publishNow(c, p.id, { expected_version: 1, connection_ids: [ig.instagram!, ig.facebook!] }, randomUUID());
  }

  // Synthetic analytics (shown as "Demo data" in the app) + a couple of simulated inbox conversations.
  const analytics = await showcaseAnalytics(ws.id);
  const ch = await enableChannel(c, { connection_id: ig.facebook! });
  await simulateInbound(c, ch.id, { kind: 'dm', name: 'Maya Fernandes', text: 'Hi! Is the brunch menu vegan-friendly?', minutes_ago: 18 });
  await simulateInbound(c, ch.id, { kind: 'comment', name: 'Tom Okafor', text: 'Booked for Saturday — can’t wait!', minutes_ago: 9 });
  // The owner has finished onboarding in this story: hide the checklist card.
  await updateOnboarding(c, { dismissed: true }).catch(() => undefined);

  console.log(JSON.stringify({ msg: 'showcase workspace seeded (synthetic)', workspaceId: ws.id, owner: SHOWCASE_OWNER.email, analytics }));
}

main().then(() => closePool()).catch(async (err) => { console.error(err); await closePool(); process.exit(1); });
