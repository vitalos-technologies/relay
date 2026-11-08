// SYNTHETIC listening demo data (local/dev only) for screenshots and manual QA. Uses the SIMULATED Facebook Page from
// scripts/seed-inbox-demo.ts: simulated public comments go through the real inbox ingestion, then listening observes them.
// Everything is flagged is_simulated and labelled "Simulated" in the UI. "Brewly" is a fictional competitor.
//   set -a; . ./.env; set +a; npx tsx scripts/seed-listening-demo.ts ["Demo Workspace"]
// Idempotent: a saved search named "Vitalos" on the demo brand marks it as done.
import { randomUUID } from 'node:crypto';
import { closePool, getPool, many, maybeOne } from '@social-lite/db';
import { config, loadAccess, type Ctx } from '@social-lite/services';
import { simulateInbound } from '@social-lite/services/inbox/index';
import { createDashboard, createRule, createSearch, evaluateRule, observeMessage, rematchSearch } from '@social-lite/services/listening/index';

if (config().APP_ENV === 'production') throw new Error('Refusing to seed demo data in production');
const wsName = process.argv[2] ?? 'Demo Workspace';
const PAGE = 'Vitalos Café Page (simulated)';

async function ctxFor(email: string, workspaceId: string): Promise<Ctx> {
  const u = await maybeOne<{ id: string; name: string | null }>(getPool(), `SELECT id, name FROM users WHERE email=$1`, [email]);
  if (!u) throw new Error(`user ${email} not found`);
  const access = await loadAccess(u.id, workspaceId, getPool(), { mfaVerified: true, authTime: new Date().toISOString() });
  if (!access) throw new Error(`${email} has no access to ${wsName}`);
  return { actor: { userId: u.id, email, name: u.name, sessionId: randomUUID() }, access, correlationId: randomUUID() };
}

// Deterministic pseudo-random so reruns on a fresh DB look the same.
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;

const NAMES = ['Ava Brooks', 'Noah Patel', 'Mia Chen', 'Leo Martin', 'Zara Ali', 'Sam Rivera', 'Ivy Novak', 'Omar Haddad', 'Ella Fox', 'Ben Ito', 'Ruby Okoro', 'Theo Grant'];
const BASE = [
  'Vitalos flat white is the best in town ☕️', 'Love the oat latte at Vitalos, so smooth', 'Is Vitalos open on Sunday mornings?', 'Vitalos lemon tart was lovely today',
  'Great service at Vitalos this morning, thanks!', 'Vitalos oat latte again — never disappoints', 'Does Vitalos do gluten-free cakes?', 'Vitalos scones are amazing',
  'Queue at Vitalos was slow today but worth it', 'Brewly oat latte was better than Vitalos tbh', 'Brewly is too expensive for what it is', 'Tried Brewly cold brew, really nice',
  'Vitalos vs Brewly — Vitalos wins for pastries', 'Brewly service was rude this morning', 'Vitalos takeaway cups are finally compostable 👏', 'Any Vitalos discount for students?',
  'El café de Vitalos es muy bueno', 'Vitalos staff are always friendly', 'Vitalos croissant was a bit stale', 'Brewly opened a new shop near the station',
];
const SPIKE = [
  'Vitalos app order failed twice and I was charged', 'Vitalos online ordering is down? Payment failed', 'Charged twice by Vitalos for one order — refund please',
  'Vitalos app keeps failing at checkout', 'Is the Vitalos app broken? Order never arrived', 'Vitalos payment error again, annoying', 'Vitalos app down, had to queue instead',
  'Vitalos order failed but money taken. Not happy', 'Vitalos checkout error on the app', 'Anyone else getting a Vitalos app error?', 'Vitalos app crashed during payment',
  'Vitalos double charged me today. Terrible.',
];

async function main() {
  const db = getPool();
  const ws = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name=$1 AND is_demo`, [wsName]);
  if (!ws) throw new Error(`${wsName} not found (synthetic demo workspaces only)`);
  const ch = await maybeOne<{ id: string; brand_id: string }>(db, `SELECT id, brand_id FROM inbox_channels WHERE workspace_id=$1 AND display_name=$2 AND disconnected_at IS NULL AND is_simulated`, [ws.id, PAGE]);
  if (!ch) throw new Error('Run scripts/seed-inbox-demo.ts first (simulated Facebook Page channel)');
  if (await maybeOne(db, `SELECT 1 FROM listening_searches WHERE workspace_id=$1 AND brand_id=$2 AND name='Vitalos' AND archived_at IS NULL`, [ws.id, ch.brand_id])) {
    console.log(JSON.stringify({ msg: 'listening demo already seeded', workspace: wsName }));
    return;
  }
  const owner = await ctxFor('owner@demo.social-lite.test', ws.id);

  const own = await createSearch(owner, { brand_id: ch.brand_id, name: 'Vitalos', role: 'own', terms: ['Vitalos', 'Vitalos Café', '#vitalos'], keywords: [], exclusions: ['job', 'hiring'], boolean: null, languages: [], sources: [], kinds: [] });
  const rival = await createSearch(owner, { brand_id: ch.brand_id, name: 'Brewly', role: 'competitor', terms: ['Brewly'], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] });
  const app = await createSearch(owner, { brand_id: ch.brand_id, name: 'App and payments', role: 'topic', terms: [], keywords: [], exclusions: [], boolean: '(app OR checkout OR payment OR order*) AND (fail* OR error OR down OR charged OR broken OR crashed)', languages: ['en'], sources: [], kinds: [] });

  // 14 days of sparse public comments (baseline), then a burst in the current hour.
  const ids: string[] = [];
  const add = async (text: string, minutesAgo: number) => {
    const r = await simulateInbound(owner, ch.id, { kind: 'comment', text, name: pick(NAMES), minutes_ago: minutesAgo });
    const m = await maybeOne<{ id: string }>(db, `SELECT id FROM inbox_messages WHERE external_id=$1`, [r.external_id]);
    if (m) ids.push(m.id);
  };
  for (let i = 0; i < 70; i++) await add(pick(BASE), Math.floor(30 + rnd() * 14 * 24 * 60));
  const nowMin = new Date().getUTCMinutes();
  for (let i = 0; i < SPIKE.length; i++) await add(SPIKE[i]!, Math.floor(rnd() * Math.max(1, nowMin)));
  // A private message mentioning the brand: stays in the inbox, never reaches listening.
  await simulateInbound(owner, ch.id, { kind: 'dm', text: 'Vitalos — my order 5521 was charged twice', name: 'Kim Lee' });

  for (const id of ids) await observeMessage(id);
  for (const s of [own, rival, app]) await rematchSearch(s.id);
  const rule = await createRule(owner, { search_id: own.id, name: 'Mention spike', metric: 'volume', window_minutes: 60, baseline_days: 7, min_sample: 8, multiplier: 3, min_baseline_windows: 24, cooldown_minutes: 360, recipients: [owner.actor.userId], enabled: true });
  await createRule(owner, { search_id: app.id, name: 'Payment problems', metric: 'volume', window_minutes: 60, baseline_days: 7, min_sample: 5, multiplier: 3, min_baseline_windows: 24, cooldown_minutes: 360, recipients: [owner.actor.userId], enabled: true });
  const r = await evaluateRule(rule.id);
  await createDashboard(owner, { brand_id: ch.brand_id, name: 'Weekly brand pulse', shared: true, widgets: [
    { type: 'timeline', search_ids: [own.id], days: 30 }, { type: 'share_of_voice', search_ids: [own.id, rival.id], days: 30 },
    { type: 'sentiment', search_ids: [own.id], days: 30 }, { type: 'topics', search_ids: [own.id], days: 30 },
  ] });
  const n = await many<{ n: number }>(db, `SELECT count(*)::int AS n FROM listening_observations WHERE workspace_id=$1`, [ws.id]);
  console.log(JSON.stringify({ msg: 'listening demo seeded', observations: n[0]?.n, alert: r.map((x) => x.reason) }));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closePool());
