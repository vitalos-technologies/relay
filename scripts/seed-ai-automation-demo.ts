// SYNTHETIC automation demo data (local/dev only) for screenshots and manual QA, on the simulated Facebook Page that
// scripts/seed-inbox-demo.ts created. Nothing is sent to or received from Meta; no AI provider is called.
//   set -a; . ./.env; set +a; npx tsx scripts/seed-ai-automation-demo.ts ["Demo Workspace"]
// Idempotent: a policy named "Café care (demo)" marks it as done. Uses the real services (authorization, audit, outbox):
// saved reply approved as knowledge, a bounded policy (activated by the owner), three rules, classification + rule runs
// for the existing demo conversations, and one automatic saved reply on a new simulated question.
import { randomUUID } from 'node:crypto';
import { getPool, many, maybeOne } from '@social-lite/db';
import { config, loadAccess, type Ctx } from '@social-lite/services';
import { dispatchReply, saveSavedReply, simulateInbound } from '@social-lite/services/inbox/index';
import { approveKnowledge } from '@social-lite/services/assistant/index';
import { createPolicy, createRule, onMessageReceived, setPolicyStatus, installAutomation } from '@social-lite/services/automation/index';

const cfg = config();
if (cfg.APP_ENV === 'production') throw new Error('Refusing to seed demo data in production');
const wsName = process.argv[2] ?? 'Demo Workspace';
const POLICY = 'Café care (demo)';
const PAGE = 'Vitalos Café Page (simulated)';

async function ctxFor(email: string, workspaceId: string): Promise<Ctx> {
  const u = await maybeOne<{ id: string; name: string | null }>(getPool(), `SELECT id, name FROM users WHERE email=$1`, [email]);
  if (!u) throw new Error(`user ${email} not found`);
  const access = await loadAccess(u.id, workspaceId, getPool(), { mfaVerified: true, authTime: new Date().toISOString() });
  if (!access) throw new Error(`${email} has no access to ${wsName}`);
  return { actor: { userId: u.id, email, name: u.name, sessionId: randomUUID() }, access, correlationId: randomUUID() };
}

async function processLatest(workspaceId: string, conversationId: string) {
  const m = await maybeOne<{ id: string }>(getPool(), `SELECT id FROM inbox_messages WHERE conversation_id=$1 AND direction='inbound' AND body IS NOT NULL ORDER BY provider_created_at DESC LIMIT 1`, [conversationId]);
  if (m) await onMessageReceived({ workspaceId, aggregateId: conversationId, payload: { messageId: m.id }, origin: { kind: 'provider' } });
}

async function main() {
  installAutomation();
  const db = getPool();
  const ws = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name=$1 AND is_demo`, [wsName]);
  if (!ws) throw new Error(`${wsName} not found (synthetic demo workspaces only)`);
  if (await maybeOne(db, `SELECT 1 FROM automation_policies WHERE workspace_id=$1 AND name=$2`, [ws.id, POLICY])) {
    console.log(JSON.stringify({ msg: 'automation demo already seeded', workspace: wsName }));
    return;
  }
  const ch = await maybeOne<{ id: string; brand_id: string }>(db, `SELECT ic.id, ic.brand_id FROM inbox_channels ic WHERE ic.workspace_id=$1 AND ic.display_name LIKE 'Vitalos Café%' AND ic.disconnected_at IS NULL LIMIT 1`, [ws.id])
    ?? await maybeOne<{ id: string; brand_id: string }>(db, `SELECT ic.id, ic.brand_id FROM inbox_channels ic JOIN connections c ON c.id=ic.connection_id WHERE ic.workspace_id=$1 AND c.display_name=$2 LIMIT 1`, [ws.id, PAGE]);
  if (!ch) throw new Error('Run scripts/seed-inbox-demo.ts first');
  const owner = await ctxFor('owner@demo.social-lite.test', ws.id);

  const hours = await saveSavedReply(owner, { brand_id: ch.brand_id, title: 'Opening hours', body: 'Thanks for asking! We are open Monday to Saturday 8:00–18:00 and Sunday 9:00–15:00.' });
  const k = await approveKnowledge(owner, { brand_id: ch.brand_id, kind: 'saved_reply', ref_id: hours.id, topics: ['opening hours'], review_by: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10) });
  const team = await maybeOne<{ id: string }>(db, `SELECT id FROM teams WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY created_at LIMIT 1`, [ws.id]);
  const policy = await createPolicy(owner, {
    name: POLICY, brand_ids: [ch.brand_id], channel_ids: [ch.id],
    allowed_actions: ['assign', 'add_labels', 'set_priority', 'add_note', 'escalate', 'reply_saved', 'create_case', 'notify'],
    knowledge_source_ids: [k.id], reply_categories: ['question'],
    limits: { max_actions_per_hour: 200, max_auto_replies_per_day: 20, monthly_token_budget: 0 },
    escalation: { negative_sentiment: true, keywords: ['allergy', 'lawyer'], team_id: team?.id ?? null },
    expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(), review_by: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
  });
  await setPolicyStatus(owner, policy.id, 'active');
  const scope = { brand_ids: [ch.brand_id], channel_ids: [] };
  await createRule(owner, { policy_id: policy.id, name: 'Label order questions', trigger: 'inbox.message_received', enabled: true, position: 0,
    conditions: [{ field: 'category', op: 'in', value: ['order_status'] }], actions: [{ type: 'add_labels', labels: ['orders'] }], scope });
  await createRule(owner, { policy_id: policy.id, name: 'Escalate refunds and complaints', trigger: 'inbox.message_received', enabled: true, position: 1,
    conditions: [{ field: 'category', op: 'in', value: ['refund', 'complaint', 'sensitive'] }], actions: [{ type: 'escalate', reason: 'Needs a person.' }], scope });
  await createRule(owner, { policy_id: policy.id, name: 'Opening hours reply', trigger: 'inbox.message_received', enabled: true, position: 2,
    conditions: [{ field: 'text_contains', op: 'contains_any', value: ['open', 'opening hours', 'close'] }], actions: [{ type: 'reply_saved', saved_reply_id: hours.id, mode: 'private_message' }],
    scope, limits: { max_per_hour: 30, per_conversation_cooldown_minutes: 1440 } });
  await createRule(owner, { policy_id: policy.id, name: 'Case nearing first-response deadline', trigger: 'case.sla_nearing', trigger_params: { minutes_before: 30 }, enabled: true, position: 3,
    conditions: [], actions: [{ type: 'set_priority', priority: 'urgent' }, { type: 'notify', to: 'case_owner' }], scope });

  const convs = await many<{ id: string }>(db, `SELECT id FROM inbox_conversations WHERE workspace_id=$1 AND channel_id=$2 ORDER BY last_message_at`, [ws.id, ch.id]);
  for (const c of convs) await processLatest(ws.id, c.id);
  await simulateInbound(owner, ch.id, { kind: 'dm', name: 'Ana Lopes', text: 'What time do you open on Sunday?' });
  const ana = await maybeOne<{ id: string }>(db, `SELECT c.id FROM inbox_conversations c JOIN inbox_contacts ct ON ct.id=c.contact_id WHERE c.workspace_id=$1 AND ct.display_name='Ana Lopes' ORDER BY c.created_at DESC LIMIT 1`, [ws.id]);
  if (ana) {
    await processLatest(ws.id, ana.id);
    const att = await many<{ id: string }>(db, `SELECT id FROM inbox_reply_attempts WHERE conversation_id=$1 AND automated AND state='queued'`, [ana.id]);
    for (const a of att) await dispatchReply(a.id, 'seed');
  }
  console.log(JSON.stringify({ msg: 'automation demo seeded', workspace: wsName, policy: policy.id, conversations: convs.length + 1 }));
}

main().then(() => getPool().end()).catch(async (err) => { console.error(err); await getPool().end(); process.exit(1); });
