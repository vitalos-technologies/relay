// V3.5 stream F — representative-load performance check (LOCAL/DEV ONLY, synthetic data).
//   set -a; . ./.env; set +a; npx tsx scripts/v35-perf.ts
// 1. Seeds (once) a synthetic workspace "V35 Perf (synthetic)" owned by the demo owner: one simulated Facebook Page
//    channel with 5,000 conversations / 20,000 messages, inserted in bulk (the inbox tables the services read); the
//    public inbound comments (7,500) then go through the real listening ingest (observeMessage), so the saved search
//    is measured against real connected-source observations.
// 2. Measures the SERVER read path of the brief's screens through the real services (same queries as the API routes),
//    30 samples each, nearest-rank p95, against docs/PERFORMANCE_BUDGETS.md (page read model ≤ 100 ms p95 Medium /
//    ≤ 200 ms Large; search ≤ 100 ms server): inbox list (first + cursor + search), inbox thread, listening mentions +
//    timeline, integrations hub, assistant status, admin summary.
// Writes evidence/v3-5/final/perf-server.json.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { closePool, getPool, many, maybeOne, one } from '@social-lite/db';
import { config, loadAccess, type Ctx } from '@social-lite/services';
import { connectMock } from '@social-lite/services/connections/index';
import { enableChannel, getConversation, listConversations } from '@social-lite/services/inbox/index';
import { createSearch, searchMentions, searchTimeline } from '@social-lite/services/listening/index';
import { observeMessage } from '@social-lite/services/listening/ingest';
import '@social-lite/services/integrations-v35/index';
import { hubOverview } from '@social-lite/services/integrations-v35/core/hub';
import { assistantStatus } from '@social-lite/services/assistant/index';
import { careAdminSummary } from '@social-lite/services/admin/v35';

if (config().APP_ENV === 'production') throw new Error('Refusing to run in production');
const WS = 'V35 Perf (synthetic)';
const N_CONV = 5000;
const MSG_PER = 4;

async function ctxFor(userId: string, email: string, ws: string): Promise<Ctx> {
  const access = await loadAccess(userId, ws, getPool(), { mfaVerified: true, authTime: new Date().toISOString() });
  if (!access) throw new Error('no access');
  return { actor: { userId, email, name: 'Perf', sessionId: randomUUID() }, access, correlationId: randomUUID() };
}

async function seed(): Promise<{ ctx: Ctx; ws: string; searchId: string; convId: string }> {
  const db = getPool();
  const u = await one<{ id: string }>(db, `SELECT id FROM users WHERE email='owner@demo.social-lite.test'`);
  let ws = (await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name=$1`, [WS]))?.id;
  if (!ws) {
    ws = (await one<{ id: string }>(db, `INSERT INTO workspaces(name, is_demo) VALUES ($1, true) RETURNING id`, [WS])).id;
    await db.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws, u.id]);
    await db.query(`INSERT INTO brands(workspace_id, name, timezone) VALUES ($1,'Perf brand','Europe/London')`, [ws]);
  }
  await db.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, source)
    SELECT $1,'user',$2,'owner','workspace','v35-perf' WHERE NOT EXISTS (SELECT 1 FROM scoped_role_grants WHERE workspace_id=$1 AND user_id=$2 AND role='owner' AND revoked_at IS NULL)`, [ws, u.id]);
  const ctx = await ctxFor(u.id, 'owner@demo.social-lite.test', ws);
  const brand = (await one<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 LIMIT 1`, [ws])).id;
  let ch = (await maybeOne<{ id: string }>(db, `SELECT id FROM inbox_channels WHERE workspace_id=$1 AND disconnected_at IS NULL LIMIT 1`, [ws]))?.id;
  if (!ch) {
    const conn = await connectMock(ctx, brand, { provider: 'facebook', display_name: 'Perf Page (simulated)' });
    ch = (await enableChannel(ctx, { connection_id: conn.id })).id;
  }
  let search = (await maybeOne<{ id: string }>(db, `SELECT id FROM listening_searches WHERE workspace_id=$1 AND archived_at IS NULL LIMIT 1`, [ws]))?.id;
  if (!search) search = (await createSearch(ctx, { brand_id: brand, name: 'Perf mentions', role: 'own', terms: ['vitalos'], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] })).id;
  const have = (await one<{ n: number }>(db, `SELECT count(*)::int n FROM inbox_conversations WHERE workspace_id=$1`, [ws])).n;
  if (have < N_CONV) {
    const t0 = Date.now();
    // Bulk insert in batches (contacts → conversations → messages); half public comments mentioning the brand.
    for (let b = have; b < N_CONV; b += 500) {
      await db.query(
        `WITH c AS (
           INSERT INTO inbox_contacts(workspace_id, channel_id, external_id, display_name)
           SELECT $1, $2, 'perf_' || g, 'Customer ' || g FROM generate_series($3::int, $4::int) g RETURNING id, external_id)
         INSERT INTO inbox_conversations(workspace_id, brand_id, channel_id, contact_id, kind, visibility, external_thread_id, status, priority, last_message_at, unanswered_since, last_inbound_at, first_inbound_at, is_simulated)
         SELECT $1, $5, $2, c.id, CASE WHEN (substr(c.external_id, 6))::int % 2 = 0 THEN 'dm' ELSE 'comment' END,
                CASE WHEN (substr(c.external_id, 6))::int % 2 = 0 THEN 'private' ELSE 'public' END, 'perf_thread_' || c.external_id,
                CASE WHEN (substr(c.external_id, 6))::int % 5 = 0 THEN 'resolved' ELSE 'open' END, 'normal',
                now() - make_interval(mins => (substr(c.external_id, 6))::int), now() - make_interval(mins => (substr(c.external_id, 6))::int),
                now() - make_interval(mins => (substr(c.external_id, 6))::int), now() - make_interval(mins => (substr(c.external_id, 6))::int + 60), true
           FROM c`, [ws, ch, b + 1, Math.min(b + 500, N_CONV), brand]).catch(async (err) => { throw err; });
    }
    await db.query(
      `INSERT INTO inbox_messages(workspace_id, conversation_id, channel_id, direction, external_id, author_contact_id, body, provider_created_at, is_simulated)
       SELECT c.workspace_id, c.id, c.channel_id, CASE WHEN k = $3 THEN 'outbound' ELSE 'inbound' END, c.external_thread_id || '_m' || k,
              CASE WHEN k = $3 THEN NULL ELSE c.contact_id END, 'Order question ' || k || ' about Vitalos lemon tart and pickup times',
              c.last_message_at - make_interval(mins => ($3 - k) * 5), true
         FROM inbox_conversations c CROSS JOIN generate_series(1, $3::int) k WHERE c.workspace_id=$1 AND c.channel_id=$2
           AND NOT EXISTS (SELECT 1 FROM inbox_messages m WHERE m.conversation_id=c.id)`, [ws, ch, MSG_PER]);
    console.log(JSON.stringify({ seeded: N_CONV, messages: N_CONV * MSG_PER, ms: Date.now() - t0 }));
  }
  // Listening: observe public inbound comments that have no observation yet (same path as the worker's sweep).
  const pending = await many<{ id: string }>(db,
    `SELECT m.id FROM inbox_messages m JOIN inbox_conversations c ON c.id = m.conversation_id
      WHERE m.workspace_id=$1 AND m.direction='inbound' AND c.visibility='public' AND c.kind <> 'dm'
        AND NOT EXISTS (SELECT 1 FROM listening_observations o WHERE o.inbox_message_id = m.id)`, [ws]);
  if (pending.length) {
    const t0 = Date.now();
    for (const r of pending) await observeMessage(r.id);
    console.log(JSON.stringify({ observed: pending.length, ms: Date.now() - t0 }));
  }
  const conv = (await one<{ id: string }>(db, `SELECT id FROM inbox_conversations WHERE workspace_id=$1 ORDER BY last_message_at DESC LIMIT 1`, [ws])).id;
  return { ctx, ws, searchId: search, convId: conv };
}

async function measure(name: string, fn: () => Promise<unknown>, n = 30) {
  await fn(); await fn(); // warm
  const xs: number[] = [];
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const r = await fn();
    xs.push(performance.now() - t);
    bytes = Buffer.byteLength(JSON.stringify(r));
  }
  xs.sort((a, b) => a - b);
  const p = (q: number) => Math.round(xs[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)]! * 10) / 10;
  return { name, samples: n, p50_ms: p(0.5), p95_ms: p(0.95), max_ms: Math.round(xs[xs.length - 1]! * 10) / 10, payload_kb: Math.round(bytes / 102.4) / 10 };
}

async function main() {
  const { ctx, searchId, convId, ws } = await seed();
  const first = await listConversations(ctx, { queue: 'all', limit: 30 });
  const obs = (await one<{ n: number }>(getPool(), `SELECT count(*)::int n FROM listening_observations WHERE workspace_id=$1`, [ws])).n;
  const rows = [
    await measure('inbox list (first page, all)', () => listConversations(ctx, { queue: 'all', limit: 30 })),
    await measure('inbox list (cursor page)', () => listConversations(ctx, { queue: 'all', limit: 30, cursor: first.next_cursor })),
    await measure('inbox list (unassigned queue)', () => listConversations(ctx, { queue: 'unassigned', limit: 30 })),
    await measure('inbox search (q)', () => listConversations(ctx, { queue: 'all', q: 'Customer 4417', limit: 30 })),
    await measure('inbox thread', () => getConversation(ctx, convId)),
    await measure('listening mentions (30 days, page)', () => searchMentions(ctx, searchId, { days: 30, limit: 30 })),
    await measure('listening timeline (30 days)', () => searchTimeline(ctx, searchId, { days: 30 })),
    await measure('integrations hub', () => hubOverview(ctx)),
    await measure('assistant status (drawer open)', () => assistantStatus(ctx)),
    await measure('admin summary (care)', () => careAdminSummary(ctx)),
  ];
  const budget: Record<string, number> = { 'inbox search (q)': 100 };
  const out = {
    at: new Date().toISOString(), workload: { conversations: N_CONV, messages: N_CONV * MSG_PER, listening_observations: obs },
    budget_note: 'docs/PERFORMANCE_BUDGETS.md: page read model ≤ 100 ms p95 (Medium) / ≤ 200 ms (Large); search ≤ 100 ms server. This workload is between Medium and Large; checked against 100 ms.',
    rows: rows.map((r) => ({ ...r, budget_p95_ms: budget[r.name] ?? 100, within_budget: r.p95_ms <= (budget[r.name] ?? 100) })),
  };
  mkdirSync('evidence/v3-5/final', { recursive: true });
  writeFileSync('evidence/v3-5/final/perf-server.json', JSON.stringify(out, null, 1));
  console.table(out.rows);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closePool());
