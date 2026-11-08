// SYNTHETIC inbox demo data for stream B networks (local/dev only): simulated Instagram, WhatsApp, Google Business
// Profile (2 locations), YouTube, Bluesky, Telegram and Threads channels with simulated customer messages. Nothing is sent
// to or received from any network. Uses the real services (authorization, audit, outbox, simulated transports).
//   set -a; . ./.env; set +a; npx tsx scripts/seed-inbox-more-demo.ts ["Demo Workspace"]
// Idempotent per workspace: a simulated connection named "Vitalos Café Instagram (simulated)" marks it as done.
// Replies are queued here and delivered by the worker when it runs stream B code (or by `--dispatch` in this process).
import { randomUUID } from 'node:crypto';
import { closePool, getPool, maybeOne } from '@social-lite/db';
import { config, loadAccess, type Ctx } from '@social-lite/services';
import { connectMock } from '@social-lite/services/connections/index';
import { createSimulatedIntegration } from '@social-lite/services/connectors/index';
import {
  addNote, checkTelegramWebhook, claimTelegramWebhook, dispatchReply, enableChannel, enableIntegrationChannel, getConversation, integrationAccounts, linkIdentity, listConversations,
  listTemplates, requestReply, setCsatEnabled, simulateInbound,
} from '@social-lite/services/inbox/index';

const cfg = config();
if (cfg.APP_ENV === 'production') throw new Error('Refusing to seed demo data in production');
const wsName = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'Demo Workspace';
const dispatch = process.argv.includes('--dispatch');
const MARK = 'Vitalos Café Instagram (simulated)';

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
  if (await maybeOne(db, `SELECT 1 FROM connections WHERE workspace_id=$1 AND display_name=$2 AND disconnected_at IS NULL`, [ws.id, MARK])) {
    console.log(JSON.stringify({ msg: 'stream B inbox demo already seeded', workspace: wsName }));
    return;
  }
  const owner = await ctxFor('owner@demo.social-lite.test', ws.id);
  const admin = await ctxFor('admin@demo.social-lite.test', ws.id);
  const brand = await maybeOne<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND name LIKE 'Vitalos%' AND archived_at IS NULL LIMIT 1`, [ws.id]);
  if (!brand) throw new Error('Vitalos (demo) brand not found');
  const social = async (provider: 'instagram' | 'youtube' | 'bluesky' | 'telegram' | 'threads', name: string) => enableChannel(owner, { connection_id: (await connectMock(owner, brand.id, { provider, display_name: name })).id });

  const ig = await social('instagram', MARK);
  await simulateInbound(owner, ig.id, { kind: 'dm', name: 'Ines Duarte', text: 'Hi! Do you take bookings for 8 on Sunday brunch?', minutes_ago: 55 });
  await simulateInbound(owner, ig.id, { kind: 'comment', name: 'Jonah Kim', text: 'That cinnamon bun 😍 is it vegan?', minutes_ago: 33 });
  await simulateInbound(owner, ig.id, { kind: 'comment', name: 'Promo Bot', text: 'Get 10k followers fast → bit.ly/xyz', minutes_ago: 30 });
  await setCsatEnabled(owner, ig.id, true);

  const waI = await createSimulatedIntegration(owner, { connector: 'whatsapp', brand_id: brand.id, display_name: 'Vitalos WhatsApp (simulated)' });
  const wa = await enableIntegrationChannel(owner, { integration_id: waI.id, account_id: (await integrationAccounts(owner, waI.id)).items[0]!.account_id });
  await listTemplates(owner, wa.id, true);
  await simulateInbound(owner, wa.id, { kind: 'dm', name: 'Wes Adeyemi', text: 'Is my birthday cake order still on for Friday?', minutes_ago: 26 * 60 });
  await simulateInbound(owner, wa.id, { kind: 'dm', name: 'Lia Moreau', text: 'Here is a photo of the cracked lid from today’s delivery', minutes_ago: 18, attachment: true });

  const gbpI = await createSimulatedIntegration(owner, { connector: 'google_business_profile', brand_id: brand.id, display_name: 'Vitalos Google profile (simulated)' });
  const locs = (await integrationAccounts(owner, gbpI.id)).items;
  const g1 = await enableIntegrationChannel(owner, { integration_id: gbpI.id, account_id: locs[0]!.account_id });
  const g2 = await enableIntegrationChannel(owner, { integration_id: gbpI.id, account_id: locs[1]!.account_id });
  await simulateInbound(owner, g1.id, { kind: 'review', name: 'Rita Gomes', rating: 3, text: 'Great coffee, but we waited 20 minutes for two flat whites on Saturday.' });
  await simulateInbound(owner, g2.id, { kind: 'review', name: 'Sol Haddad', rating: 5, text: 'Perfect espresso before my train. Friendly staff!' });

  const yt = await social('youtube', 'Vitalos YouTube (simulated)');
  await simulateInbound(owner, yt.id, { kind: 'comment', name: 'Gus Petrov', text: 'Which grinder are you using in this video?' });
  const bs = await social('bluesky', 'Vitalos Bluesky (simulated)');
  await simulateInbound(owner, bs.id, { kind: 'mention', name: 'Ada Lowe', text: 'Best flat white in Shoreditch, @vitalos.bsky.social' });
  await simulateInbound(owner, bs.id, { kind: 'dm', name: 'Ada Lowe', text: 'Could I book the back room for a book club?' });
  const th = await social('threads', 'Vitalos Threads (simulated)');
  await simulateInbound(owner, th.id, { kind: 'comment', name: 'Mo Rahman', text: 'Price of the house beans per bag?' });
  const tg = await social('telegram', 'Vitalos bot (simulated)');
  await checkTelegramWebhook(owner, tg.id);
  await claimTelegramWebhook(owner, tg.id, { confirm_no_other_consumer: true });
  await simulateInbound(owner, tg.id, { kind: 'dm', name: 'Tia Novak', text: 'Do you deliver to E2?' });

  // Some activity: assignment-free reply on the review, a note with a mention, a linked identity.
  const list = await listConversations(owner, { queue: 'all' });
  const rita = list.items.find((i) => i.contact.name === 'Rita Gomes');
  if (rita) {
    const c = await getConversation(owner, rita.id);
    const r = await requestReply(owner, rita.id, { mode: 'public_reply', body: 'Thank you Rita — sorry about the wait. We have added a second barista on Saturday mornings.', base_version: c.version, idempotency_key: randomUUID().replace(/-/g, '') });
    if (dispatch) await dispatchReply(r.attempt.id, 'seed');
    await addNote(owner, rita.id, { body: 'Saturday rota updated — check with the manager before replying to similar reviews.', mentions: [admin.actor.userId] });
  }
  const ines = list.items.find((i) => i.contact.name === 'Ines Duarte');
  if (ines) await linkIdentity(owner, ines.id, { new_customer_name: 'Ines Duarte', reason: 'Confirmed booking reference BR-2207 in DM' });
  console.log(JSON.stringify({ msg: 'stream B inbox demo seeded', workspace: wsName, channels: 9 }));
}

main().then(() => closePool()).catch(async (err) => { console.error(err); await closePool(); process.exit(1); });
