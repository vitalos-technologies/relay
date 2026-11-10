// SYNTHETIC "Relay Showcase" workspace for the marketing hero screenshot (V5 MKT; DEV/LOCAL ONLY — refuses production).
// A fictional bakery brand run by a fictional person, healthy simulated destinations, a believable week (scheduled posts
// with images over the next days, items in review, a few published), synthetic analytics (labelled "Demo data" in the
// app), simulated inbox conversations, one completed AI workspace task, and zero failed/expired deliveries. Uses the real services (same
// authorization, audit and outbox as the product).
// REFRESH, not create-once: every run brings the showcase (and ONLY the showcase) to a healthy "this week" relative to now —
// the previous run's story posts are cancelled (cancelSchedule) and removed, simulated destinations are restored to ready /
// unpaused / scenario "success" (reconnectConnection, setConnectionPaused, setMockScenario), stale notifications are
// cleared, then the week is re-created and the result is checked (exit 1 if anything would show as an issue).
// Why: posts made on an earlier day keep their dates (yesterday's "tomorrow" is today's "published"/"expired"), and the
// worker's 6-hourly health sweep flips a simulated LinkedIn member destination to "reconnect required" (the LinkedIn
// adapter compares urn:li:person:<userinfo sub> with the account id, which for a simulated destination is "mock_linkedin_…"),
// which then blocks/expires its deliveries. Run the capture right after this script (it stays healthy for ≥ 6 h).
//   set -a; . ./.env; set +a; npx tsx scripts/seed-marketing-showcase.ts
// Also (dev only) turns the support widget on in Platform → Marketing so screenshots/E2E show it; production keeps the
// default (off) until an operator enables it.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { closePool, getPool, maybeOne, one, withTx } from '@social-lite/db';
import { toLocalInput, type Provider } from '@social-lite/core';
import { MARKETING_CONFIG_KEY } from '@social-lite/core/contracts/v5-marketing';
import { cancelSchedule, config, createPost, loadAccess, publishNow, schedulePost, submitForReview, type Ctx } from '@social-lite/services';
import { connectMock, reconnectConnection, setConnectionPaused, setMockScenario } from '@social-lite/services/connections/index';
import { completeUpload, createUploadIntent } from '@social-lite/services/media/index';
import { seedAnalyticsDemo } from '@social-lite/services/analytics/demo';
import { updateOnboarding } from '@social-lite/services/gov/onboarding';
import { enableChannel, simulateInbound } from '@social-lite/services/inbox/index';
import { createWorkflowRun, executeWorkflowRun } from '@social-lite/services/ai-workflows/index';

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

const PROVIDER_NAME: Partial<Record<Provider, string>> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', threads: 'Threads', bluesky: 'Bluesky' };
const BAKERY = 'Lumen Lane Bakery';
const EVENTS = 'Lumen Lane Events';
const DESTINATIONS: Array<{ brand: string; label: string; providers: Provider[] }> = [
  { brand: BAKERY, label: 'Lumen Lane', providers: ['instagram', 'facebook', 'linkedin', 'threads'] },
  { brand: EVENTS, label: 'Lumen Lane Events', providers: ['instagram', 'facebook', 'bluesky'] },
];
const PALETTES: Array<[string, string, string]> = [['#fbcfe8', '#c084fc', '#fde68a'], ['#fde68a', '#fb923c', '#f9a8d4'], ['#a5f3fc', '#818cf8', '#f0abfc'], ['#bbf7d0', '#34d399', '#fef08a'], ['#fecaca', '#f472b6', '#c4b5fd'], ['#ddd6fe', '#a78bfa', '#fbcfe8']];
const ATTENTION_STATES = ['blocked', 'unknown', 'failed', 'expired', 'handoff'];

/** Workspace, owner, membership and the two brands — created when missing, reused otherwise. */
async function ensureWorkspace(): Promise<{ wsId: string; ownerId: string; brands: Record<string, string> }> {
  const owner = await one<{ id: string }>(db,
    `INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified, name) VALUES ('pending', $1, $2, false, $3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [`pending:${SHOWCASE_OWNER.email}`, SHOWCASE_OWNER.email, SHOWCASE_OWNER.name]);
  let ws = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name=$1 AND is_demo AND state='active'`, [SHOWCASE_WORKSPACE]);
  if (!ws) {
    ws = await one<{ id: string }>(db, `INSERT INTO workspaces(name, is_demo, timezone) VALUES ($1, true, $2) RETURNING id`, [SHOWCASE_WORKSPACE, TZ]);
    await db.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws.id, owner.id]);
    await db.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, granted_by, source)
                    VALUES ($1,'user',$2,'owner','workspace',$2,'seed')`, [ws.id, owner.id]);
  }
  const brands: Record<string, string> = {};
  for (const [name, extra] of [[BAKERY, false], [EVENTS, true]] as const) {
    const found = await maybeOne<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND name=$2 ORDER BY created_at LIMIT 1`, [ws.id, name]);
    brands[name] = found?.id ?? (name === BAKERY
      ? (await one<{ id: string }>(db, `INSERT INTO brands(workspace_id, name, is_demo, timezone, voice) VALUES ($1,$2,true,$3,$4) RETURNING id`,
        [ws.id, name, TZ, JSON.stringify({ tone: 'Warm, local, a little playful', hashtags: ['#LumenLane'], default_cta: 'Book a table' })])).id
      : (await one<{ id: string }>(db, `INSERT INTO brands(workspace_id, name, is_demo, timezone, approval_required) VALUES ($1,$2,true,$3,$4) RETURNING id`,
        [ws.id, name, TZ, extra])).id);
  }
  return { wsId: ws.id, ownerId: owner.id, brands };
}

/**
 * Nothing held: no publishing pause on the workspace or its brands, and billing access "full". The showcase never had a
 * subscription (no workspace_billing row = legacy, full access); a local billing/entitlement row that restricts it is removed
 * so it reads as legacy again. Showcase workspace only.
 */
async function ensureNothingHeld(wsId: string) {
  await db.query(`UPDATE workspaces SET publishing_paused=false, paused_reason=NULL, paused_by=NULL, paused_at=NULL WHERE id=$1 AND publishing_paused`, [wsId]);
  await db.query(`UPDATE brands SET publishing_paused=false WHERE workspace_id=$1 AND publishing_paused`, [wsId]);
  const held = await maybeOne<{ access_level: string }>(db, `SELECT access_level FROM workspace_billing WHERE workspace_id=$1 AND access_level <> 'full'`, [wsId]);
  if (held) await db.query(`DELETE FROM workspace_billing WHERE workspace_id=$1`, [wsId]);
  await db.query(`DELETE FROM workspace_entitlement_state WHERE workspace_id=$1 AND access <> 'full'`, [wsId]);
}

/**
 * Remove the previous run's story (every non-synthetic post of the showcase: scheduled, in review, published, blocked,
 * expired). Live schedules are cancelled through the product service first (stops the publisher and invalidates pending
 * approvals); then the posts are deleted with their schedules/deliveries — the product never deletes a published post (Trash
 * refuses, Archive keeps it in the planner), so a showcase refresh must. Plus the showcase's notifications about them.
 */
async function clearStory(c: Ctx, wsId: string): Promise<number> {
  const story = (await db.query<{ id: string }>(
    `SELECT p.id FROM posts p WHERE p.workspace_id=$1
        AND NOT EXISTS (SELECT 1 FROM deliveries d JOIN connections c ON c.id=d.connection_id WHERE d.post_id=p.id AND c.is_synthetic)`, [wsId])).rows.map((r) => r.id);
  if (!story.length) return 0;
  const live = (await db.query<{ id: string }>(`SELECT id FROM schedules WHERE workspace_id=$1 AND post_id = ANY($2::uuid[]) AND status IN ('active','pending_approval')`, [wsId, story])).rows;
  for (const s of live) await cancelSchedule(c, s.id).catch((err) => console.warn(JSON.stringify({ msg: 'cancel failed (deleted anyway)', scheduleId: s.id, err: String(err) })));
  await withTx(async (tx) => {
    // Children that reference revisions without ON DELETE CASCADE go first, then the posts (the rest cascades).
    for (const t of ['deliveries', 'publication_authorizations', 'approvals', 'schedules']) {
      await tx.query(`DELETE FROM ${t} WHERE workspace_id=$1 AND post_id = ANY($2::uuid[])`, [wsId, story]);
    }
    await tx.query(`DELETE FROM posts WHERE workspace_id=$1 AND id = ANY($2::uuid[])`, [wsId, story]);
  });
  await db.query(`DELETE FROM notifications WHERE workspace_id=$1`, [wsId]);
  return story.length;
}

/**
 * The simulated (non-synthetic) destinations: created when missing; otherwise restored to a healthy state through the product
 * services — scenario "success", reconnected when not ready (a fresh simulated credential; also re-queues anything blocked),
 * unpaused. Returns brand → provider → connection id.
 */
async function ensureDestinations(c: Ctx, brands: Record<string, string>): Promise<Record<string, Partial<Record<Provider, string>>>> {
  const out: Record<string, Partial<Record<Provider, string>>> = {};
  for (const { brand, label, providers } of DESTINATIONS) {
    const brandId = brands[brand]!;
    out[brand] = {};
    for (const p of providers) {
      const cur = await maybeOne<{ id: string; status: string; paused: boolean; disconnected_at: Date | null; scenario: string | null }>(db,
        `SELECT id, status, paused, disconnected_at, metadata->>'mock_scenario' AS scenario FROM connections
          WHERE workspace_id=$1 AND brand_id=$2 AND provider=$3 AND is_mock AND NOT is_synthetic ORDER BY disconnected_at NULLS FIRST, created_at LIMIT 1`,
        [c.access.workspaceId, brandId, p]);
      if (!cur) {
        out[brand]![p] = (await connectMock(c, brandId, { provider: p, display_name: `${label} ${PROVIDER_NAME[p]}`, scenario: 'success' })).id;
        continue;
      }
      if (cur.scenario !== 'success') await setMockScenario(c, cur.id, { scenario: 'success' });
      if (cur.status !== 'ready' || cur.disconnected_at) await reconnectConnection(c, cur.id, {});
      if (cur.paused) await setConnectionPaused(c, cur.id, { paused: false });
      out[brand]![p] = cur.id;
    }
  }
  return out;
}

/** The six artworks: reused when already in the library (ready, not deleted), uploaded otherwise. */
async function ensureImages(c: Ctx, brands: Record<string, string>): Promise<string[]> {
  const imgs: string[] = [];
  for (let i = 0; i < PALETTES.length; i++) {
    const brandId = brands[i < 4 ? BAKERY : EVENTS]!;
    const name = `lumen-lane-${i + 1}.png`;
    const have = await maybeOne<{ id: string }>(db,
      `SELECT id FROM assets WHERE workspace_id=$1 AND brand_id=$2 AND original_filename=$3 AND status='ready' AND deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at LIMIT 1`,
      [c.access.workspaceId, brandId, name]);
    imgs.push(have?.id ?? await upload(c, brandId, name, await artwork(i + 3, ...PALETTES[i]!)));
  }
  return imgs;
}

/** Wait for the worker to deliver the "published" posts (the Published tile counts delivered posts only). */
async function waitForPublished(wsId: string, postIds: string[], timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await one<{ total: number; done: number }>(db,
      `SELECT count(*)::int total, count(*) FILTER (WHERE state='published')::int done FROM deliveries WHERE workspace_id=$1 AND post_id = ANY($2::uuid[])`, [wsId, postIds]);
    if (r.total > 0 && r.done === r.total) return;
    if (Date.now() > until) throw new Error(`published posts not delivered after ${timeoutMs / 1000}s (${r.done}/${r.total}) — is the worker running?`);
    await new Promise((res) => setTimeout(res, 1500));
  }
}

/** The state the hero shows: refuse (exit 1) when anything would read as an issue. */
async function verify(wsId: string) {
  const attention = await one<{ n: number }>(db,
    `SELECT count(*)::int n FROM deliveries d JOIN posts p ON p.id=d.post_id JOIN schedules s ON s.id=d.schedule_id
      WHERE d.workspace_id=$1 AND d.state::text = ANY($2::text[]) AND s.generation = p.schedule_generation`, [wsId, ATTENTION_STATES]);
  const warnings = (await db.query<{ display_name: string; status: string; paused: boolean }>(
    `SELECT display_name, status, paused FROM connections WHERE workspace_id=$1 AND disconnected_at IS NULL AND (status <> 'ready' OR paused)`, [wsId])).rows;
  const counts = await one<{ scheduled: number; review: number; published: number }>(db,
    `SELECT count(*) FILTER (WHERE s.status='active' AND s.due_at > now() AND s.due_at < now() + interval '7 days')::int scheduled,
            count(*) FILTER (WHERE s.status='pending_approval')::int review,
            count(DISTINCT s.id) FILTER (WHERE s.due_at > now() - interval '7 days' AND s.due_at <= now()
              AND EXISTS (SELECT 1 FROM deliveries d JOIN connections c ON c.id=d.connection_id WHERE d.schedule_id=s.id AND d.state='published' AND NOT c.is_synthetic))::int published
       FROM schedules s JOIN posts p ON p.id=s.post_id WHERE s.workspace_id=$1 AND s.generation = p.schedule_generation`, [wsId]);
  const paused = await one<{ ws: boolean; brands: number; billing: string | null }>(db,
    `SELECT w.publishing_paused ws, (SELECT count(*)::int FROM brands b WHERE b.workspace_id=w.id AND b.publishing_paused) brands,
            (SELECT access_level FROM workspace_billing wb WHERE wb.workspace_id=w.id) billing FROM workspaces w WHERE w.id=$1`, [wsId]);
  const result = { attention: attention.n, connection_warnings: warnings, ...counts, workspace_paused: paused.ws, brands_paused: paused.brands, billing_access: paused.billing ?? 'legacy (full)' };
  const clean = !attention.n && !warnings.length && counts.scheduled > 0 && counts.review > 0 && counts.published > 0 && !paused.ws && !paused.brands && (paused.billing ?? 'full') === 'full';
  if (!clean) throw new Error(`showcase is not clean: ${JSON.stringify(result)}`);
  return result;
}

/** Believable, synthetic inbox: a handful of comments and messages on the bakery's simulated Facebook and Instagram. */
async function showcaseInbox(c: Ctx, wsId: string, facebookId: string, instagramId: string) {
  const have = await one<{ n: number }>(db, `SELECT count(*)::int n FROM inbox_conversations WHERE workspace_id=$1`, [wsId]);
  if (have.n >= 6) return { conversations: have.n, added: 0 };
  const fb = await enableChannel(c, { connection_id: facebookId });
  const insta = await enableChannel(c, { connection_id: instagramId }).catch(() => null);
  const msgs: Array<[string, 'dm' | 'comment' | 'mention', string, string, number]> = [
    [fb.id, 'dm', 'Maya Fernandes', 'Hi! Is the brunch menu vegan-friendly?', 18],
    [fb.id, 'comment', 'Tom Okafor', 'Booked for Saturday — can’t wait!', 9],
    [fb.id, 'dm', 'Grace Lindqvist', 'Do you take orders for birthday cakes? We need one for 12 people on the 21st.', 42],
    [fb.id, 'comment', 'Sam Whitaker', 'Those cardamom buns were gone by 9am. Any chance of a second tray on Saturdays?', 64],
    [insta?.id ?? fb.id, 'comment', 'Leila Haddad', 'The spring menu looks beautiful. Is the rhubarb tart gluten-free?', 27],
    [insta?.id ?? fb.id, 'dm', 'Jonas Becker', 'Is there space for a stroller at the supper club?', 95],
  ];
  let added = 0;
  for (const [ch, kind, name, text, minutes_ago] of msgs.slice(have.n === 0 ? 0 : 2)) {
    try { await simulateInbound(c, ch, { kind, name, text, minutes_ago }); added++; } catch (err) { console.warn(JSON.stringify({ msg: 'simulated message skipped', name, err: String(err) })); }
  }
  return { conversations: have.n + added, added };
}

/** A completed performance analysis in the AI workspace (previous showcase tasks archived so the list stays short). */
async function showcaseAiRun(c: Ctx, wsId: string, brandId: string) {
  await db.query(`UPDATE ai_threads SET archived_at=now() WHERE workspace_id=$1 AND archived_at IS NULL`, [wsId]);
  // Performance analysis: its steps are data-only, so it completes without an AI provider (weekly planning needs one).
  const run = await createWorkflowRun(c, { workflow: 'performance_analysis', inputs: { brand_id: brandId, range_days: 28 }, idempotency_key: `showcase-${randomUUID()}` });
  const status = await executeWorkflowRun(run.id, 'showcase-seed');
  return { id: run.id, status };
}

async function main() {
  await enableWidgetInDev();
  await removePartialSeeds();
  const { wsId, ownerId, brands } = await ensureWorkspace();
  const c = await ctxFor(ownerId, wsId);
  await ensureNothingHeld(wsId);
  const cleared = await clearStory(c, wsId);
  const byProvider = await ensureDestinations(c, brands);
  const imgs = await ensureImages(c, brands);

  const draft = (text: string, img: string, ids: string[]) => ({ baseText: text, baseLink: null, baseAssetIds: [img], variants: ids.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) });
  const schedule = async (brand: string, title: string, text: string, img: string, ids: string[], when: string, review = false) => {
    const p = await createPost(c, brand, { title, draft: draft(text, img, ids) }, randomUUID());
    const req = { expected_version: 1, connection_ids: ids, input_local_time: when, timezone: TZ };
    await (review ? submitForReview(c, p.id, req, randomUUID()) : schedulePost(c, p.id, req, randomUUID()));
  };
  const bakery = brands[BAKERY]!; const events = brands[EVENTS]!;
  const ig = byProvider[BAKERY]!;
  const bake = [ig.instagram!, ig.facebook!, ig.linkedin!, ig.threads!];
  const ev = byProvider[EVENTS]!;
  const evAll = [ev.instagram!, ev.facebook!, ev.bluesky!];
  // The week ahead (bakery brand: no approval step). Five scheduled + two in review: the hero's alt text says so.
  await schedule(bakery, 'Spring menu launch', 'Five new bakes land on Wednesday — come taste spring. 🌸 #LumenLane', imgs[0]!, bake, dayLocal(1, '09:30'));
  await schedule(bakery, 'Behind the scenes: 5am bake', 'Ever wondered what 5am smells like? Our bakers show you. #LumenLane', imgs[1]!, [ig.instagram!, ig.threads!], dayLocal(1, '12:00'));
  await schedule(bakery, 'Meet the team: Priya', 'Meet Priya, our pastry lead and the reason our croissants have 81 layers.', imgs[2]!, [ig.instagram!, ig.facebook!, ig.linkedin!], dayLocal(2, '10:00'));
  await schedule(bakery, 'Weekend brunch is back', 'Brunch returns this Saturday from 9 till 2. Book a table from the link in our profile.', imgs[3]!, bake, dayLocal(3, '08:45'));
  await schedule(bakery, 'Customer story: the Okafor family', 'Three generations, one Sunday ritual. Thank you for sharing your story with us.', imgs[2]!, [ig.facebook!, ig.linkedin!], dayLocal(4, '16:15'));
  // In review (events brand requires approval; the author cannot approve their own post, so these wait for a decision).
  await schedule(events, 'Supper club: spring tasting', 'Join our spring supper club — six courses, one long table. Tickets on sale now.', imgs[4]!, evAll, dayLocal(2, '18:00'), true);
  await schedule(events, 'Sourdough workshop', 'Learn to bake sourdough with our head baker. Small groups, flour included.', imgs[5]!, evAll, dayLocal(5, '11:00'), true);
  // Published (simulated destinations; the worker delivers them).
  const publishedIds: string[] = [];
  for (const [title, text, img, ids] of [
    ['Fresh this morning', 'Cardamom buns are out of the oven. First tray goes fast. #LumenLane', imgs[1]!, [ig.instagram!, ig.facebook!]],
    ['Thank you, neighbours', 'Thank you for a wonderful first year on Lumen Lane. Cake is on us this Friday.', imgs[0]!, [ig.instagram!, ig.facebook!, ig.linkedin!]],
    ['Now hiring: weekend baker', 'We are hiring a weekend baker. Early starts, warm kitchen, great team. Details on our website.', imgs[3]!, [ig.facebook!, ig.linkedin!, ig.threads!]],
  ] as const) {
    const p = await createPost(c, bakery, { title, draft: draft(text, img, [...ids]) }, randomUUID());
    await publishNow(c, p.id, { expected_version: 1, connection_ids: [...ids] }, randomUUID());
    publishedIds.push(p.id);
  }

  // Synthetic analytics (shown as "Demo data" in the app), refreshed to end today.
  const analytics = await showcaseAnalytics(wsId);
  // Simulated inbox conversations (synthetic people and messages; added once — the inbox keeps its history).
  const inbox = await showcaseInbox(c, wsId, ig.facebook!, ig.instagram!);
  // One completed AI workspace task for the Explore capture (data steps run without a provider; AI-written parts are
  // skipped when no AI provider is configured, which the run shows honestly).
  const aiRun = await showcaseAiRun(c, wsId, bakery);
  // The owner has finished onboarding in this story: hide the checklist card.
  await updateOnboarding(c, { dismissed: true }).catch(() => undefined);

  await waitForPublished(wsId, publishedIds);
  const state = await verify(wsId);
  console.log(JSON.stringify({ msg: 'showcase workspace refreshed (synthetic)', workspaceId: wsId, owner: SHOWCASE_OWNER.email, cleared_posts: cleared, state, analytics, inbox, ai_run: aiRun }));
}

main().then(() => closePool()).catch(async (err) => { console.error(err); await closePool(); process.exit(1); });
