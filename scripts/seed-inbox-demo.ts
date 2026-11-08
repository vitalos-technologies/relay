// SYNTHETIC inbox demo data (local/dev only) for screenshots and manual QA. Simulated Facebook Page only — nothing is
// sent to or received from Meta.
//   set -a; . ./.env; set +a; npx tsx scripts/seed-inbox-demo.ts ["Demo Workspace"]
// Idempotent per workspace: a simulated connection named "Vitalos Café Page (simulated)" marks it as done.
// Uses the real services (same authorization, audit, outbox): channel opt-in, simulated inbound DMs + comments,
// assignment, internal note, a reply sent through the simulated transport, a case with service levels.
import { randomUUID } from 'node:crypto';
import { closePool, getPool, maybeOne } from '@social-lite/db';
import { config, loadAccess, type Ctx } from '@social-lite/services';
import { connectMock } from '@social-lite/services/connections/index';
import {
  addNote, assignConversation, createCase, dispatchReply, enableChannel, listConversations, requestReply, simulateInbound, upsertSlaPolicy, getConversation,
} from '@social-lite/services/inbox/index';

const cfg = config();
if (cfg.APP_ENV === 'production') throw new Error('Refusing to seed demo data in production');
const wsName = process.argv[2] ?? 'Demo Workspace';
const PAGE = 'Vitalos Café Page (simulated)';

async function ctxFor(email: string, workspaceId: string): Promise<Ctx> {
  const u = await maybeOne<{ id: string; name: string | null }>(getPool(), `SELECT id, name FROM users WHERE email=$1`, [email]);
  if (!u) throw new Error(`user ${email} not found`);
  const access = await loadAccess(u.id, workspaceId, getPool(), { mfaVerified: true, authTime: new Date().toISOString() });
  if (!access) throw new Error(`${email} has no access to ${wsName}`);
  return { actor: { userId: u.id, email, name: u.name, sessionId: randomUUID() }, access, correlationId: randomUUID() };
}

async function main() {
  const db = getPool();
  const ws = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name=$1 AND is_demo`, [wsName]);
  if (!ws) throw new Error(`${wsName} not found (synthetic demo workspaces only)`);
  if (await maybeOne(db, `SELECT 1 FROM connections WHERE workspace_id=$1 AND display_name=$2 AND disconnected_at IS NULL`, [ws.id, PAGE])) {
    console.log(JSON.stringify({ msg: 'inbox demo already seeded', workspace: wsName }));
    return;
  }
  const owner = await ctxFor('owner@demo.social-lite.test', ws.id);
  const admin = await ctxFor('admin@demo.social-lite.test', ws.id);
  const brand = await maybeOne<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND name LIKE 'Vitalos%' AND archived_at IS NULL LIMIT 1`, [ws.id]);
  if (!brand) throw new Error('Vitalos (demo) brand not found');

  await upsertSlaPolicy(owner, { name: 'Default', timezone: 'Europe/London', business_hours: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:30' })), holidays: ['2026-12-25', '2026-12-26'], first_response_minutes: 60, resolution_minutes: 480, count_automated: false, is_default: true });
  const conn = await connectMock(owner, brand.id, { provider: 'facebook', display_name: PAGE });
  const ch = await enableChannel(owner, { connection_id: conn.id });

  const a = await simulateInbound(owner, ch.id, { kind: 'dm', name: 'Maya Fernandes', text: 'Hi! I ordered the lemon tart box for Saturday (order 4417) but the confirmation email never arrived. Is it booked?', minutes_ago: 42 });
  await simulateInbound(owner, ch.id, { kind: 'dm', name: 'Maya Fernandes', thread: a.thread, text: 'Also — can I change pickup to 11:30?', minutes_ago: 38 });
  await simulateInbound(owner, ch.id, { kind: 'comment', name: 'Tom Okafor', text: 'Is the spring menu available for takeaway too?', minutes_ago: 25 });
  await simulateInbound(owner, ch.id, { kind: 'dm', name: 'Priya Shah', text: 'Do you have gluten-free options on the new menu?', minutes_ago: 12 });
  await simulateInbound(owner, ch.id, { kind: 'comment', name: 'Leo Martin', text: 'Best flat white in town ☕️', minutes_ago: 7 });
  await simulateInbound(owner, ch.id, { kind: 'dm', name: 'Sam Rivera', text: 'My card was charged twice for yesterday’s order. Can you refund one?', minutes_ago: 3 });

  const list = await listConversations(owner, { queue: 'all' });
  const byName = (n: string) => list.items.find((i) => i.contact.name === n)!;
  const maya = byName('Maya Fernandes');
  const sam = byName('Sam Rivera');
  const priya = byName('Priya Shah');

  await assignConversation(owner, maya.id, { assignee_id: owner.actor.userId });
  await addNote(owner, maya.id, { body: 'Order 4417 is in the system — confirmation email bounced (typo in address). Checking pickup slots with the kitchen.', mentions: [admin.actor.userId] });
  const cur = await getConversation(owner, maya.id);
  const r = await requestReply(owner, maya.id, { mode: 'private_message', body: 'Hi Maya — yes, order 4417 is booked for Saturday. The email bounced, so we’ll resend it now. 11:30 pickup works.', base_version: cur.version, idempotency_key: randomUUID().replace(/-/g, '') });
  await dispatchReply(r.attempt.id, 'seed');
  await createCase(owner, { conversation_id: maya.id, title: 'Order 4417 — missing confirmation, pickup change', priority: 'normal' });

  await assignConversation(owner, sam.id, { assignee_id: admin.actor.userId });
  await createCase(admin, { conversation_id: sam.id, title: 'Duplicate card charge', priority: 'high' });
  await addNote(admin, sam.id, { body: 'Payments: two captures for the same order. Refund needs owner sign-off.' });
  void priya;
  console.log(JSON.stringify({ msg: 'inbox demo seeded', workspace: wsName, channel: ch.id, conversations: list.items.length }));
}

main().then(() => closePool()).catch(async (err) => { console.error(err); await closePool(); process.exit(1); });
